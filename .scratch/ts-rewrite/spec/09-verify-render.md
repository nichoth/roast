# 09 -- Verifier stage, report rendering, text sanitization

## 1. Purpose

This area covers the three steps between the finder and the run record:

1. The **verifier** stage. Every finding the finder kept is adjudicated by
   the verifier role's model, which sees the claim and the code only, never
   the finder's reasoning (anti-anchoring). A refutation counts only when it
   is grounded in specific code, guards, or language semantics. Anything the
   verifier cannot decide fails open: the finding keeps gating, with the
   reason on its verdict.
2. **Report rendering.** A completed review becomes a JSON payload (stdout,
   and `result.json` in the run record) and a Markdown summary (stderr, and
   `report.md` in the run record).
3. **Text sanitization** (`textsafe`). Finding text comes from a model that
   read an untrusted repository, so a JSON string such as `"\u001b]52;c;..."`
   decodes to a real ESC. Every place Roast prints model- or
   repository-derived text to a terminal or into a human-readable report
   escapes control characters first. JSON output does not go through it.

Out of scope here (owned by other areas): the finder, prompt texts and the
verifier user-prompt renderer, exploration tools, the agent loop
(`Converse`), the token ledger internals, finding fingerprints, prior
sightings lookup, run-record file writing, and CLI flag parsing in general.

Notation: in quoted output strings below, `{EM}` stands for one literal
U+2014 EM DASH character, which the Go output contains and the TypeScript
output must contain too. `·` is U+00B7 MIDDLE DOT, also literal.

## 2. Behavior contract

### 2.1 Data model used by this area

Owned by the review area; restated here because rendering and verification
depend on every field.

Severity: one of `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`. `rank`:
INFO=0, LOW=1, MEDIUM=2, HIGH=3, CRITICAL=4; any other string (including
`""`) ranks 0. `parseSeverity(s)` upper-cases and trims (Go
`strings.TrimSpace`), accepts only the five names, rejects `""`.

Finding (JSON field order is significant for output parity):

| key | type | notes |
| --- | --- | --- |
| `reasoning` | string | |
| `severity` | string | |
| `confidence` | number | |
| `cwe` | string | |
| `description` | string | |
| `file` | string | |
| `lines` | int[] or null | `null` when absent |
| `code_quote` | string | |
| `fixed_code` | string | |
| `frontend_category` | string | |
| `verdict` | Verdict | omitted when absent |
| `_drop_reason` | string | omitted when `""` |
| `id` | string | omitted when `""` |
| `alias` | string | omitted when `""`, e.g. `R-8d8d19` |

Verdict (field order significant):

| key | type | notes |
| --- | --- | --- |
| `reasoning` | string | always present |
| `status` | string | `confirmed`, `refuted`, `insufficient_context` |
| `confidence` | number | always present |
| `grounding` | string | always present |
| `recalibrated_severity` | string | omitted when `""` |
| `verifier` | string | omitted when `""`; set by Roast (model id) |
| `undecided` | boolean | omitted when false; set by Roast |

`verdict.gates()`: true when the verdict is absent or its status is not
`refuted`.

`finding.effectiveSeverity()`: the finder's `severity`, unless the verdict
exists, its status is `confirmed`, `parseSeverity(recalibrated_severity)`
succeeds, and that parsed severity's rank is strictly lower than the
finder's severity rank; then the parsed (canonical) severity. Severity can
only move down, and only on a confirmed verdict.

Result: `findings` (Finding[]), `dropped` (Finding[]), `assessment`
(string), `notes` (string[] or null), `incomplete` (boolean),
`stopReason` (string: `""`, `deadline`, `token_budget`,
`budget_exhausted`).

`result.maxSeverity()`: the highest `effectiveSeverity().rank` among
`findings` (live findings only), or -1 when there are none.

Drop reasons: `invalid_severity`, `missing_code_quote`,
`missing_fixed_code`, `ungrounded_code_quote`, `below_confidence_floor`
(finder side) and `refuted_by_verifier` (this area).

Assessments: `FINDINGS_PRESENT`, `NO_FINDINGS`, `NO_DIFF`,
`INCOMPLETE_NO_SUBMISSION`, `NO_FINDINGS_IN_SAMPLED_AREAS`.

### 2.2 When verification runs

- `doVerify = !quick && !noVerify` (`--quick`, `--no-verify`, both boolean,
  default false). When `doVerify` is true the verifier role is validated
  before anything else runs (config area; failure is a usage error, exit 2).
  With `--quick` or `--no-verify` the verifier role is never validated or
  contacted.
- The verifier client is constructed, and `verify` is called, only when
  `doVerify` is true **and** the finder returned at least one finding. With
  zero findings no verifier request is made, but the report still says
  `"verified": true` and `usage` has only a `finder` entry.
- Before calling `verify`, the CLI logs through its `logf` helper (one
  `roast: ...` line on stderr, sanitized with `textsafe.text`):
  `verifying <n> finding(s) with <model> (profile=<p> protocol=<proto>)`.
- The CLI calls `verify` with: system prompt = the rendered verifier system
  prompt; user prompt = the verifier user-prompt renderer for the finding
  (prompts area; it includes the cited file snippet, never the finder's
  reasoning); tools = the exploration tools over the reviewed tree (context
  area); `maxTurns = 8`; `maxVerified` = resolved cap; the run's shared
  token ledger; `log` writes the message plus `\n` to stderr. Concurrency is
  not set by the CLI, so the default 4 applies.
- `maxVerified` resolution: `--max-verified` flag if given on the command
  line, else `limits.max_verified` from `.roast.json`, else 25. A negative
  flag value is a usage error `max-verified cannot be negative` (exit 2).
  `0` means no cap. The resolved value is recorded in budgets as
  `verifier_cap`.
- After `verify` returns, `usage.verifier` is the verifier client's usage.
  The run is **partial** if the finder result was `incomplete` or any
  surviving finding's verdict has `undecided: true`.

### 2.3 `verify(signal, verifier, result, deps)` algorithm

Inputs: `deps.concurrency` (default 4 when `<= 0`), `deps.log` (default
no-op), `deps.userPrompt` (default returns `""`), `deps.maxVerified`
(0 = no cap), `deps.ledger` (may be absent; absent is never exhausted).

1. `n = result.findings.length`; allocate `verdicts[n]`.
2. Run a promise pool of `concurrency` workers over indices `0..n-1`,
   handed out in ascending index order. For the job at index `i`, at the
   moment a worker picks it up:
   1. If `maxVerified > 0 && i >= maxVerified`: verdict =
      `unverified("unverified: over the per-run verifier cap (<maxVerified>)")`.
      The cap is by input position, so it is deterministic.
   2. Else if the ledger is exhausted: verdict =
      `unverified("unverified: run token budget exhausted before this
      finding's verification")` (one line in the real string; the
      apostrophe is U+0027). The check is made at launch only;
      verifications already in flight finish normally.
   3. Else: verdict = `verifyOne(finding)`.
   4. Set `verdict.verifier = verifier.name()` (the verifier role's model
      id) on every verdict, including unverified and error verdicts.
   5. Store at `verdicts[i]`.
   `unverified(reason)` is `{status: "insufficient_context", undecided:
   true, reasoning: reason, confidence: 0, grounding: ""}`.
3. Wait for all workers. Then assemble a **new** result (the input is not
   mutated):
   - `dropped` = copy of input `dropped` (existing drops first).
   - `notes` = copy of input `notes`. Go quirk to preserve: an empty input
     notes list becomes `null` (Go `append(nil, empty...)` is nil), so a
     verified run with no notes serializes `"notes": null` (kept for
     Go parity; spec.md).
   - `assessment`, `incomplete`, `stopReason` copied unchanged (cutoff state
     survives verification).
   - `findings` = new empty list.
4. For each input finding in input order, with `v = verdicts[i]`:
   1. **Refutation without grounding:** if `v.status == "refuted"` and
      `goTrimSpace(v.grounding) == ""`, rewrite `v.status =
      "insufficient_context"`, `v.undecided = true`, `v.reasoning =
      "verifier returned refuted without grounding {EM} treating as
      insufficient_context (fail-open)"`. Confidence and grounding are
      kept as returned.
   2. **Ungrounded recalibration:** if `v.status == "confirmed"` and
      `v.recalibrated_severity != ""` and `goTrimSpace(v.grounding) == ""`,
      clear `recalibrated_severity` to `""`.
   3. Attach `v` as the finding's verdict (copy of the finding).
   4. If `!v.gates()` (status still `refuted`): set `_drop_reason =
      "refuted_by_verifier"`, append to `dropped`, and call `deps.log` with
      `roast: verifier refuted [<SEV>] <DESC> (conf <C>)` where
      `<SEV> = textsafe.line(finding.severity)` (the finder's raw severity),
      `<DESC> = textsafe.line(truncateUtf8(finding.description, 80))`
      (truncate first, escape second), and `<C>` is `verdict.confidence`
      formatted as Go `%.2f` (section 2.9). Log lines are emitted in input
      order after all verifications finish, not as they complete.
   5. Else append to `findings`.
5. If `findings` is empty and `assessment == "FINDINGS_PRESENT"`, set
   `assessment = "NO_FINDINGS"`. No other assessment is changed (in
   particular `INCOMPLETE_NO_SUBMISSION` never becomes `NO_FINDINGS`).
6. Return the new result. Errors never propagate out of `verify`.

Recalibrated severity is never applied to the finding's `severity` field;
it lives only on the verdict and takes effect through `effectiveSeverity()`
(rendering, sort order, `--max-severity`). The JSON output therefore keeps
the finder's `severity` and shows `verdict.recalibrated_severity`
alongside.

`truncateUtf8(s, n)`: if the UTF-8 byte length of `s` is `<= n`, return
`s`; otherwise cut at byte `n`, moving the cut left while the byte at the
cut is a UTF-8 continuation byte (`0b10xxxxxx`), so a code point is never
split. Measured in UTF-8 bytes, not UTF-16 units.

### 2.4 `verifyOne(finding)`

- Tools sent: `deps.tools` in order, then the final tool appended last:
  - name `submit_verdict`
  - description `Submit your verdict on the finding. Call exactly once.`
  - no runner (it is the final tool; the agent loop ends on it)
  - schema: exactly the JSON below (Go reflects it and re-serializes through
    a map, so property keys are alphabetical in the transmitted bytes):

```json
{
  "additionalProperties": false,
  "properties": {
    "confidence": {"maximum": 1, "minimum": 0, "type": "number"},
    "grounding": {
      "description": "<GROUNDING_DESC>",
      "type": "string"
    },
    "reasoning": {"type": "string"},
    "recalibrated_severity": {
      "description": "<RECAL_DESC>",
      "enum": ["", "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      "type": "string"
    },
    "status": {
      "enum": ["confirmed", "refuted", "insufficient_context"],
      "type": "string"
    }
  },
  "required": ["reasoning", "status", "confidence", "grounding"],
  "type": "object"
}
```

  The two placeholders are these exact one-line strings (wrapped here
  only for width; join the pieces with a single space):
  - `<GROUNDING_DESC>`: `The exact lines / contradicting code /`
    `language-semantics fact the verdict rests on`
  - `<RECAL_DESC>`: `If the finding is real but its severity is`
    `overstated, the corrected LOWER severity, justified in grounding.`
    `Leave empty to keep the finder's severity. Never raise severity.`
    (the apostrophe is U+0027)
- The model-facing ("wire") verdict has only `reasoning`, `status`,
  `confidence`, `grounding`, `recalibrated_severity`. `verifier` and
  `undecided` are deliberately absent so the model cannot fabricate them.
- Call the agent loop: `converse(signal, systemPrompt, userPrompt(finding),
  {tools, finalTool: "submit_verdict", maxTurns: deps.maxTurns})`. A
  `maxTurns` of 0 means the agent loop's default; the CLI passes 8.
- On **any** error from the loop (no final call, schema violation of the
  final call, transport failure after retries, abort):
  return `{status: "insufficient_context", confidence: 0, reasoning:
  "verifier did not reach a verdict: " + err.message, grounding: "",
  undecided: true}`. The finding keeps gating.
- On success: copy the five wire fields into a verdict
  (`undecided` false, `verifier` set later by the pool).

### 2.5 Output formats and destinations

`--format` takes `json`, `markdown`, or `both` (default `both`). Any other
value is a usage error `invalid --format "<value>"` (Go `%q` quoting),
exit 2.

`writeReport`:
- `json` or `both`: `toJSON(report)` plus `\n` to **stdout**.
- `markdown` or `both`: `toMarkdown(report, showDropped)` plus `\n` to
  **stderr**.
- JSON is written before Markdown.

Run record (records area writes the files; this area provides content):
- `result.json` = `toJSON(report)`.
- `report.md` = `toMarkdown(report, true)` -- dropped findings always
  included, independent of `--show-dropped`.
- `writeReport` runs before the run-record files are finalized.
- After finalization succeeds the CLI logs `run <id> · report <path>`.

`--show-dropped` (boolean, default false) only affects the stderr Markdown.

There is no color, no ANSI styling, and no TTY detection in rendering;
output is identical whether or not stdout/stderr are terminals.

Empty-scope path (`NO_DIFF`): when scope is empty, no model is called and
the CLI writes a report with `result = {assessment: "NO_DIFF", findings:
[], dropped: [], notes: []}`, `mode: "code"`, `files_reviewed: []`, all
other report fields at zero values (no run id, `quick: false`,
`verified: false` even under `--quick`, `usage` and `prompt_packs` null),
through the same `writeReport`, and exits 0 regardless of
`--max-severity`. No run record is written.

### 2.6 `--max-severity` and exit codes

- `--max-severity` (string, default `""`). Non-empty values go through
  `parseSeverity(value.toUpperCase())`; failure is a usage error
  `invalid --max-severity "<value>"` (exit 2). `gateRank` is the parsed
  rank, or -1 when the flag is empty.
- Exit decision after the report is written and the run record finalized,
  in priority order:
  1. Run-record finalization failed: that error (exit per the CLI error
     classification area).
  2. `gateRank >= 0 && result.maxSeverity() >= gateRank`: exit 1
     (`ExitFindings`). Uses effective (possibly recalibrated) severity of
     live findings only; dropped and refuted findings never trip it.
  3. Partial run (section 2.2): exit 4 (`ExitPartial`). Note that findings
     past the verifier cap or past ledger exhaustion are `undecided`, so
     they make the run partial.
  4. Otherwise exit 0.

### 2.7 JSON report (`toJSON`)

`Report` inputs: `result`, `mode`, `filesReviewed`, `task` (not rendered),
`runId`, `budgets` (object or absent), `quick`, `verified`,
`diffTruncated`, `originalDiffBytes`, `sizeBreakdown` (`{path, bytes}[]`),
`usage` (role name -> Usage, or absent), `prior` (fingerprint -> note, or
absent), `promptPacks` (string[] or absent), and the survey fields
`reviewKind` (`"survey_triage"` or `""`), `completion` (`partial` |
`complete`), `manifestFileCount`, `stopReason` (`converged` |
`budget_exhausted` | `incomplete_no_submission` | `deadline` |
`token_budget`).

Output is one compact JSON object (no whitespace, no trailing newline in the
string itself). Go emits the top-level keys in **alphabetical order**
(it marshals a map); the TS version should build the object in the same
sorted order. Keys:

| key | when present | value |
| --- | --- | --- |
| `assessment` | always | `result.assessment` |
| `budgets` | `budgets` set | the budgets object, nested keys sorted |
| `completion` | `reviewKind != ""` | `completion` |
| `diff_truncated` | `diffTruncated` | `true` |
| `dropped_findings` | always | `result.dropped` as finding-outs, or `[]` |
| `files_reviewed` | always | `filesReviewed` (`null` if absent) |
| `findings` | always | finding-out list of `result.findings`, `[]` when empty |
| `incomplete` | `result.incomplete` | `true` |
| `manifest_file_count` | `reviewKind != ""` | integer |
| `mode` | always | `mode` (`"code"` today) |
| `notes` | always | `result.notes` (`null` if absent, see 2.3) |
| `original_diff_bytes` | `diffTruncated` | integer |
| `prompt_packs` | always | `promptPacks` (`null` if absent) |
| `quick` | always | boolean |
| `review_kind` | `reviewKind != ""` | `"survey_triage"` |
| `run_id` | `runId != ""` | run id |
| `size_breakdown` | `diffTruncated` | `[{"path":..., "bytes":...}]` |
| `stop_reason` | see below | string |
| `usage` | always | object keyed by role (`finder`, `verifier`), or `null` |
| `verified` | always | boolean |

`stop_reason`: when `reviewKind != ""` it is the report's `stopReason`
(survey block owns the key, possibly `""`); otherwise it is
`result.stopReason`, present only when non-empty. A non-survey cut-off run
with retained findings thus carries both `incomplete: true` (when the loop
ended without submission) and `stop_reason`.

Each `usage` value: `{"uncached_input_tokens":int,
"cached_input_tokens":int, "cache_write_tokens":int, "output_tokens":int,
"calls":int}` in that order. Role keys sorted.

Finding-out object: the Finding fields in the table order of section 2.1,
then:
- `fingerprint`: the finding's fingerprint (review area), omitted only if
  empty;
- `prior_sighting`: `prior[fingerprint]` when `prior` has that key and the
  note is non-empty (omitted when empty).

`budgets` content is built by the CLI area (`deadline_duration`,
`request_timeout` as Go duration strings, `max_total_tokens`,
`verifier_cap`, `max_turns`, `max_attempts`, `max_prompt_bytes`, and
`ledger_committed_tokens` when the ledger has a limit). The CLI adds
`ledger_committed_tokens` and sets `prior` after building the report but
before rendering, so both appear in output.

JSON strings are never passed through `textsafe`: the JSON encoder escapes
C0 controls, so raw finding text round-trips exactly through
`JSON.parse`. Go's encoder additionally escapes `<`, `>`, `&` as
`\u003c`/`\u003e`/`\u0026` and U+2028/U+2029; TS does not, and the differential
harness compares parsed JSON (spec.md, "JSON encoding").
Numbers: Go and JS agree on shortest round-trip float formatting
(exponent form below 1e-6 and from 1e21, `1e-7` style), so
`JSON.stringify` numbers match.

### 2.8 Markdown report (`toMarkdown(report, showDropped)`)

Lines are collected into a list and joined with `\n` (no trailing newline
added beyond what an empty last line produces). Structure, in order:

1. **Survey banner** (only when `reviewKind != ""`):
   `> Survey triage {EM} manifest contains <manifestFileCount> files,
   completion=<completion>, stop=<report.stopReason>` (one line), then `""`.
2. Count `nRefuted` = dropped findings with `_drop_reason ==
   "refuted_by_verifier"`; `nMalformed = dropped.length - nRefuted`.
3. **Headline.** If `findings` is empty, the first matching case:
   1. `assessment == "NO_DIFF"`: `## Nothing to review in this scope {EM}
      no review ran`, `""`, then one line (shown wrapped here; the three
      flag mentions are Markdown code spans with single backticks):

      ```text
      No model was called, so this is NOT a clean review. Already
      committed? Try `--base <ref>`; use `--staged` before committing or
      `--scope repo` for a repository survey.
      ```
   2. `result.stopReason` is `deadline` or `token_budget`: `## Roast cut
      off early (<stopReason>) {EM} no findings before the cutoff`, `""`,
      `The review was cut short by a run ceiling; this is NOT a clean
      review.`
   3. `assessment == "INCOMPLETE_NO_SUBMISSION"`: `## Roast incomplete
      {EM} no findings were submitted`, `""`, `The interactive review
      exhausted its budget before submitting; this is NOT a clean review.`
   4. Otherwise: `## Roast complete {EM} no findings`, `""`, then
      `The adversary found nothing to complain about.`, with
      ` (<nRefuted> candidate finding(s) were refuted by the cross-model
      verifier.)` appended on the same line when `nRefuted > 0`.

   If `findings` is non-empty: when `result.stopReason != ""`, first
   `## Roast cut off early (<stopReason>) {EM} partial findings follow`
   and `""`; then `## Roast: <n> finding(s)` with ` (cross-model
   verified)` appended when `report.verified`.
4. If `nMalformed > 0`: `""`, then `*(<nMalformed> candidate(s) dropped by
   schema gates; --show-dropped to see them.)*`.
5. `""`.
6. **Findings**, sorted with a stable sort: effective severity rank
   descending, then `confidence` descending; ties keep input order. Each
   rendered with ordinal `i+1` (1-based position after sorting) and
   `dropped = false`.
7. **Dropped section**, only when `showDropped` and `dropped` is non-empty:
   `## Dropped findings (--show-dropped)`, `""`, then each dropped finding
   in stored order (finder drops first, then verifier refutations), ordinal
   `i+1`, `dropped = true`.

The `{EM}` dash in headings and `·` are literal; headline strings are
otherwise plain ASCII. Nothing in the headline is model-derived except
`stopReason`, which is a fixed internal value.

**Finding block** (`renderFinding(ordinal, finding, dropped, prior)`):

- `sev = line(severity)`; if that is `""`, `sev = "INFO"`. If
  `effectiveSeverity() != severity` (raw string comparison), `sev =
  "<line(effective)> (finder claimed <sev> {EM} verifier recalibrated)"`.
- `confStr = " · conf <%.2f confidence>"`.
- `tag = ""`, or when `dropped`: `"[DROPPED:<line(reason)>] "` where
  reason is `_drop_reason`, or `?` when empty.
- `path = file`, or `?` when empty (checked before escaping).
- `ln`: `?` for no lines; `<l0>` for one; `<first>-<last>` for more (first
  and last elements as given, not min/max).
- `desc = line(goTrimSpace(description))`.
- `handle = line(alias)`, or `<ordinal>.` when that is empty.
- Lines emitted:
  1. `### <handle> <tag>[<sev><confStr>] <desc>`
  2. `- **File:** ` + `inlineCode(line(path) + ":" + ln)`
  3. only if raw `cwe != ""`: `- **CWE:** <line(cwe)>`
  4. `- **Reasoning:** <listItemText(reasoning, "  ")>`
  5. if a verdict exists:
     `- **Verifier (<line(verifier) or ?>):** <line(status)> (conf <%.2f>)`;
     then, only if raw `grounding != ""`:
     `  - grounding: <listItemText(grounding, "    ")>`
  6. For `("Current", code_quote)` then `("Proposed fix", fixed_code)`:
     `block = text(value)` with all trailing `\n` removed. If `block` is
     non-empty: `- **<label>:**`, then `"  " + fence`, then each line of
     `block` (split on `\n`) prefixed with two spaces, then
     `"  " + fence`, where `fence = codeFence(block)`. If `block` is empty
     and `dropped`: `- **<label>:** *(not provided)*`. If empty and not
     dropped: nothing.
  7. If `prior` has the finding's fingerprint:
     `- **Seen previously:** <line(note)>` (emitted even for an empty note).
  8. `""`.

Helpers:
- `listItemText(s, indent) = text(goTrimSpace(s))` with every `\n`
  replaced by `\n` + indent, so model text cannot leave its list item and
  pose as a heading.
- `codeFence(content)`: backticks repeated `max(3, longestBacktickRun +
  1)` times, so a quoted backtick run cannot close the block.
- `inlineCode(s)`: delimiter = backticks repeated `longestBacktickRun(s) +
  1`; if `s` starts or ends with a backtick, `delim + " " + s + " " +
  delim`, else `delim + s + delim`.
- `longestBacktickRun(s)`: longest run of consecutive `` ` `` characters.

### 2.9 Go-compatible formatting helpers

- `goTrimSpace(s)`: trim leading and trailing characters for which Go
  `unicode.IsSpace` is true: `\t \n \v \f \r`, space, U+0085, U+00A0, and
  the Unicode `Zs`/line/paragraph separators (U+1680, U+2000-U+200A,
  U+2028, U+2029, U+202F, U+205F, U+3000). It differs from JS
  `String.prototype.trim`: Go trims U+0085 (JS does not) and does not trim
  U+FEFF (JS does). Used for the grounding emptiness checks (2.3) and
  description/reasoning/grounding rendering (2.8), where parity matters.
- `formatFixed2(x)` (Go `%.2f`): Go rounds the exact binary value half-to-even,
  JS `toFixed(2)` rounds exact ties up. They differ only on exact ties,
  which for doubles are values where `x * 8` is an odd integer (0.125,
  0.375, 0.625, 0.875, ...): Go `0.12 0.38 0.62 0.88`, JS
  `0.13 0.38 0.63 0.88`. Implementation: if `Number.isInteger(x * 8) &&
  (x * 8) % 2 !== 0`, take `n = Math.floor(x * 100)` (exact), add 1 if `n`
  is odd, and format `n / 100` with `toFixed(2)`; otherwise `x.toFixed(2)`.
  Handle negatives symmetrically. Used in the verifier log line and in
  Markdown confidences.

### 2.10 Text sanitization (`textsafe`)

Two modes over a sequence of decoded code points (Go: UTF-8 bytes):

**`text(s)`** (multi-line):
- Byte that is not part of a valid UTF-8 sequence -> `\xNN` (two lowercase
  hex digits of that byte). Each invalid byte is escaped individually (Go
  `DecodeRune` returns size 1 for any invalid or truncated sequence, so
  `"\xe2\x82"` -> `\xe2\x82`). Overlong encodings, UTF-8-encoded
  surrogates (`ED A0..BF ..`), and values above U+10FFFF are invalid.
- `\r` immediately followed by `\n` -> the `\r` is dropped (CRLF becomes
  LF). A lone `\r` -> `\x0d`.
- `\n` and `\t` -> kept as is.
- Other C0 controls (U+0000-U+001F) and DEL (U+007F) -> `\xNN` (two
  lowercase hex digits).
- C1 controls (U+0080-U+009F, valid two-byte UTF-8) -> `\uNNNN` (four
  lowercase hex digits, e.g. `\u009b`).
- Everything else copied unchanged, including valid U+FFFD and all other
  non-ASCII text.

**`line(s)`** (single-line): same as `text` except:
- `\n` -> the two characters `\n` (backslash, `n`).
- `\t` -> the two characters `\t`.
- CRLF is **not** collapsed: `\r\n` -> `\x0d\n` (escaped CR, then escaped
  LF as two characters).

Properties: output never contains a C0 control (other than `\n`/`\t` in
text mode), DEL, a C1 control, or an invalid byte; in line mode it
contains no `\n` or `\t` at all. Both functions are idempotent (backslash
is never escaped, and the escapes are printable ASCII).

Clean fast path: if the input contains nothing the mode would change,
return the input unchanged. Purely an optimization; output is identical.
In text mode a CRLF is not clean (the `\r` must be dropped).

Examples (Go test vectors; left is the raw input, right the output):
`"esc\x1b[2J"` -> `esc\x1b[2J`; `"osc\x1b]0;title\x07"` ->
`osc\x1b]0;title\x07`; `"nul\x00 del\x7f"` -> `nul\x00 del\x7f`;
`"lone\rcarriage return"` -> `lone\x0dcarriage return`;
`"crlf\r\nline"` -> `"crlf\nline"` (real LF); `"c1 csi\u009b2J"` ->
`c1 csi\u009b2J`; raw byte `0x9b` -> `\x9b`; `"unicode é ✓ stays"`
unchanged. Line mode: `"desc\n## X\r\n\tx\x1b"` ->
`desc\n## X\x0d\n\tx\x1b` (all escapes literal, one line).

**Call sites** (every one must be preserved):

1. Verifier refuted log line (2.3) -- `line`. The finder severity and
   truncated description can neither drive the terminal nor add lines.
2. Markdown single-line fields (2.8): severity, effective severity, drop
   reason, path, description, alias, CWE, verdict status, verifier name,
   prior note -- `line`. They cannot start a forged heading or line.
3. Markdown multi-line fields: reasoning and grounding (via
   `listItemText`), code quote, fixed code -- `text`. Line structure is
   kept, controls neutralized.
4. CLI `logf`, every `roast: <msg>` progress line on stderr -- `text`
   (not `line`; messages may legitimately span lines). Messages embed
   repository paths, scope notes, and model names.
5. CLI human error output (`roast: <error message>`, used when not in
   JSON error mode) -- `text`. Errors can carry git stderr naming
   repository paths.
6. `runs show <id>`: the whole stored `report.md` before it is written to
   stdout -- `text` over the raw file bytes (`textBytes`). Reports written
   before rendering escaped text may hold raw control bytes.
7. `trust` summary: profile selector, profile name, endpoint, protocol,
   credential, prompt-override name and path -- `line`. Config values are
   repository-controlled.

JSON output (stdout JSON, `result.json`, JSON error objects) is never
passed through `textsafe`.

## 3. TypeScript module design

`src/textsafe/textsafe.ts` (pure, no dependencies):

```ts
export function text(s:string):string
export function line(s:string):string
// Byte-exact Go behavior for raw bytes (runs show, git stderr).
export function textBytes(b:Uint8Array):string
export function lineBytes(b:Uint8Array):string
```

- The string variants iterate code points. A JS string cannot hold invalid
  UTF-8, but it can hold lone surrogates (for example from `JSON.parse` of
  `"\ud800"`), which Go never sees (its JSON decoder yields U+FFFD).
  The llm area turns lone surrogates in model output into U+FFFD when it
  decodes; `textsafe` escapes any that remain as `\uNNNN` (lowercase)
  (spec.md, "Bytes and text").
- The byte variants implement Go's `utf8.DecodeRune` validity rules with a
  hand-written decoder (do not use `TextDecoder`, which replaces a maximal
  invalid subpart with one U+FFFD instead of escaping each byte).
- Fast path: one regex test per mode, for example
  `/[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff]/` for text mode (and `\r`
  covered by the range), `/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/` for line
  mode, adjusted so well-formed surrogate pairs stay clean.

`src/gocompat/strings.ts` (shared Go-compatibility helpers; see the
index spec, "Go-compatibility helpers"):

```ts
export function isGoSpace(cp:number):boolean
export function goTrimSpace(s:string):string
export function goExt(path:string):string
export function truncateUtf8(s:string, maxBytes:number):string
export function formatFixed2(x:number):string  // Go "%.2f"
```

`src/verify/verify.ts`:

```ts
import type { Finding, ReviewResult, Verdict } from '../review/types.js'
import type { LlmClient, Tool } from '../llm/types.js'
import type { Ledger } from '../llm/ledger.js'

export interface VerifyDeps {
    systemPrompt:string;
    userPrompt?:(f:Finding)=>string;
    tools:Tool[];
    maxTurns:number;
    concurrency?:number;   // default 4
    log?:(line:string)=>void;
    maxVerified:number;    // 0 = no cap
    ledger?:Ledger|null;
}

export const SUBMIT_VERDICT_TOOL_NAME = 'submit_verdict'
export const VERDICT_SCHEMA:Record<string, unknown>  // section 2.4

export function verify(
    signal:AbortSignal,
    verifier:LlmClient,
    result:ReviewResult,
    deps:VerifyDeps
):Promise<ReviewResult>
```

- The pool is the shared small promise pool (architecture decision):
  `limit` workers each `await` the next index from a shared counter and
  write into a preallocated array, so output order equals input order.
  Never `Promise.all` all findings at once.
- `verifyOne` is module-private. It calls the agent loop's `converse` with
  `finalTool: 'submit_verdict'` and receives the validated final-call
  arguments as an object. Wrap the entire call in `try/catch`; any thrown
  error becomes the undecided verdict.
- The wire verdict is a zod object derived from the same definition as
  `VERDICT_SCHEMA` if the llm area validates final calls with zod; the
  transmitted schema must still be exactly the JSON in 2.4 (alphabetical
  property keys). A test pins it.
- Depends on: review area types (`Finding`, `Verdict`, `ReviewResult`,
  `gates`, drop-reason and assessment constants), llm area (`LlmClient`,
  `Tool`, `converse`, `Ledger.exhausted()`), `textsafe`, `gocompat`.

`src/render/render.ts`:

```ts
export interface SizeEntry { path:string; bytes:number }

export interface Report {
    result:ReviewResult;
    mode:string;
    filesReviewed:string[]|null;
    task:string;
    runId:string;
    budgets:Record<string, unknown>|null;
    quick:boolean;
    verified:boolean;
    diffTruncated:boolean;
    originalDiffBytes:number;
    sizeBreakdown:SizeEntry[];
    usage:Record<string, Usage>|null;
    prior:Map<string, string>|null;
    promptPacks:string[]|null;
    reviewKind:''|'survey_triage';
    completion:string;
    manifestFileCount:number;
    stopReason:string;
}

export function toJSON(report:Report):string
export function toMarkdown(report:Report, showDropped:boolean):string
export function writeReport(
    io:{ stdout:Writable; stderr:Writable },
    format:'json'|'markdown'|'both',
    showDropped:boolean,
    report:Report
):void
```

- `toJSON` builds plain objects with keys inserted in the documented order
  (top level alphabetical; finding, verdict, and usage objects in field
  order; optional keys omitted, never `undefined`) and calls
  `JSON.stringify` once. Budgets: sort keys recursively before
  stringifying.
- `nil` vs empty must be preserved: `files_reviewed`, `notes`,
  `prompt_packs`, `usage`, and a finding's `lines` serialize `null` when
  the source was absent and `[]`/`{}` when present but empty;
  `findings`/`dropped_findings` are always arrays.
- Depends on: review area (`fingerprint`, `effectiveSeverity`, types), llm
  area (`Usage`), `textsafe`, `gocompat`.

## 4. Deliberate changes

None of the listed deliberate changes apply to this area. Debug tracing
(`roast:verify`, `roast:render`) may be added under decision 5, but must
never include finding text, prompts, or verdict bodies.

## 5. Test plan

Seams: `textsafe` and the `gocompat` helpers are tested as units (the
decisions allow text sanitization at a low seam). `verify` ordering,
concurrency, and ledger behavior are tested with an in-process fake
`LlmClient` (like Go's stub), because ordering under staggered completion
is impractical through the CLI. Everything else is tested at the CLI seam
against the `node:http` fake inference server returning `submit_verdict`
tool calls, asserting on exit codes, stdout JSON, and run-record files.
Markdown is pure; test it as a unit on structural properties only (no
exact human text).

textsafe (unit):
- Escapes C0, DEL, C1, invalid bytes; keeps `\n`, `\t`, valid non-ASCII;
  CRLF collapses, lone CR escapes (TestTextEscapesControls).
- Line mode escapes `\n`, `\t`, and does not collapse CRLF
  (TestLineEscapesNewlines).
- Over every code point U+0000-U+00FF plus bytes `ff fe c2`, outputs of
  both modes contain no control, no U+FFFD, and line output no `\n`/`\t`;
  both are idempotent (TestOutputHasNoControls). Add a property-based
  variant over random byte arrays for `textBytes`/`lineBytes`.
- Lone surrogate handling (new, TS-only; pins the `\uNNNN` escape).

gocompat (unit): `formatFixed2` on 0.125/0.375/0.625/0.875 matches Go;
`goTrimSpace` trims U+0085 and not U+FEFF; `truncateUtf8` never splits a
code point and measures bytes.

verify (fake client):
- Confirmed verdict keeps the finding with verdict attached and
  `verifier` = client name (TestVerify_Confirmed_Kept).
- Grounded recalibration flows through to the verdict and lowers
  effective severity (TestVerify_Confirmed_RecalibratedSeverityFlowsThrough).
- Ungrounded recalibration is cleared
  (TestVerify_Confirmed_UngroundedRecalibration_Cleared).
- Grounded refutation moves the finding to dropped with
  `refuted_by_verifier`, assessment becomes `NO_FINDINGS`
  (TestVerify_Refuted_Dropped).
- Loop error -> kept, `undecided`, `insufficient_context`
  (TestVerify_Error_FailOpen).
- Output order equals input order when completions arrive in reverse
  (TestVerify_DeterministicOrder).
- Existing dropped findings are kept, before new refutations
  (TestVerify_PreservesExistingDropped).
- Assessment unchanged when findings remain
  (TestVerify_AssessmentKeptWhenFindingsRemain).
- Refutation with whitespace-only grounding fails open
  (TestVerify_UngroundedRefutation_FailOpen).
- Refuted log line contains no control characters and keeps escapes
  visible (TestVerify_RefutedLogEscapesFinderText).
- New (no Go test): findings at index `>= maxVerified` get the cap
  verdict without a client call; ledger exhausted before launch yields
  the budget verdict; never more than `concurrency` calls in flight;
  `VERDICT_SCHEMA` deep-equals the JSON in 2.4.

render (unit, structural):
- Survey fields present in JSON only for survey reports; banner present
  only then (TestSurveyCoverageFields).
- JSON round-trips, carries a non-empty fingerprint (TestToJSON_RoundTrip).
- Truncated diff adds `diff_truncated`, `original_diff_bytes`,
  `size_breakdown` (TestToJSON_DiffTruncatedBlock).
- Hostile finding text: Markdown holds no raw control or C1 character,
  escapes stay visible, no line of finding text starts a top-level
  heading, the code fence is longer than any backtick run inside it; JSON
  still round-trips the raw description
  (TestToMarkdown_NeutralizesHostileFindingText).
- Sort: effective severity desc then confidence desc, stable; assert via
  alias order in `### ` lines (TestToMarkdown_SortOrder).
- Dropped section appears only with `showDropped`, findings carry the
  dropped tag (TestToMarkdown_ShowDropped).
- Recalibrated severity annotated only when effective differs
  (TestToMarkdown_RecalibratedSeverityShown,
  TestToMarkdown_UnrecalibratedSeverityNotAnnotated).
- Go tests that pin exact headline text (TestToMarkdown_NoFindings,
  TestToMarkdown_NoDiffSaysNoReviewRan, TestToMarkdown_IncompleteNoSubmission,
  TestToMarkdown_FindingsHeader, TestToMarkdown_FileAndLines,
  TestToMarkdown_VerifierGrounding, TestToMarkdown_PriorSighting,
  TestToMarkdown_PlainFindingUnchanged) are ported as structural checks
  only (which case is chosen, presence of a verifier/grounding item, the
  file code span); exact wording is covered by the temporary Go-vs-TS
  differential harness on `report.md` if the maintainers opt in.

CLI seam:
- Finder plus verifier against the fake server: `--format json
  --max-severity HIGH` exits 1, stdout JSON carries `"status":"confirmed"`,
  the run record holds finder and verifier responses, `verifier_cap` 0 is
  recorded (TestFinderVerifierPipelineWithMockEndpoint,
  TestNativeAnthropicFinderWithChatVerifier).
- `runs show` escapes control bytes from a stored report
  (TestRunsShowEscapesStoredReports).
- Human error output escapes controls (TestWriteErrorEscapesControls).
- Trust summary escapes controls (TestTrustSummaryEscapesControlCharacters).
- New: `--quick` and `--no-verify` make no verifier request and report
  `verified: false`; an undecided verdict without a gate trip exits 4;
  `--format markdown` writes nothing to stdout; invalid `--format` and
  `--max-severity` exit 2.

## 6. Go baseline references

At commit `cd08f10`:

- `internal/verify/verify.go`, `internal/verify/verify_test.go`
- `internal/render/render.go`, `internal/render/render_test.go`
- `internal/textsafe/textsafe.go`, `internal/textsafe/textsafe_test.go`
- `internal/review/types.go` (Severity, Finding, Verdict, `Gates`,
  `EffectiveSeverity`, drop reasons, assessments, `MaxSeverity`)
- `internal/llm/llm.go` (`Usage`), `internal/llm/ledger.go`
  (`Exhausted`, nil-safe), `internal/llm/provider.go` (`Name` = model)
- `internal/cli/cli.go`: flags (`--format`, `--max-severity`, `--quick`,
  `--no-verify`, `--max-verified`, `--show-dropped`), `doVerify`, the
  verify call, report assembly, `writeReport`, `finalizeRunArtifacts`,
  `reviewExitError`, `logf`, `WriteError`
- `internal/cli/runs.go` (`runs show`), `internal/cli/trust.go` (summary)
- Tests: `internal/cli/cli_test.go`
  (TestFinderVerifierPipelineWithMockEndpoint,
  TestNativeAnthropicFinderWithChatVerifier),
  `internal/cli/hardening_test.go` (TestRunsShowEscapesStoredReports,
  TestWriteErrorEscapesControls), `internal/cli/trust_test.go`
  (TestTrustSummaryEscapesControlCharacters)

## 7. Resolved

Resolved:

1. `"notes": null` after verification with no notes: Go parity, kept
   (spec.md, "Deliberate changes").
2. JSON output is not HTML-escaped; the differential harness compares
   parsed JSON (spec.md, "JSON encoding").
3. Lone surrogates become U+FFFD when the llm area decodes model output;
   textsafe escapes any remaining as `\uNNNN` (spec.md, "Bytes and text").
4. `verified: true` with no findings: Go parity, kept.
5. Verifier error text in a verdict's reasoning may differ in wording
   from Go: accepted.
