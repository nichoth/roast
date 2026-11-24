# 08 -- Finder stage and prompts

## 1. Purpose

This area owns the **finder** side of a review and every prompt text Roast
sends. It covers:

- The finding model shared by every later stage: `Finding`, its wire form
  `WireFinding`, severities and their ordering, drop reasons, assessment
  values, and the run `Result`.
- The finder stage (`find`): a single structured call, or an interactive
  tool loop with early reporting (`report_finding`) and a final submission
  (`submit_findings`), including how cutoffs (turn budget, work deadline,
  token budget) keep partial work.
- `validate`: the server-side forcing functions (verbatim `code_quote`,
  concrete `fixed_code`, grounding, confidence floor) and identity
  assignment (UUIDv4 `id`, run-local `alias`).
- The similarity fingerprint used by run records and rendering.
- Mode classification (`code` | `prose` | `mixed`) and language prompt
  packs, and author-aware finder selection (`--author-model`,
  `roles.finder.author_routes`).
- The prompt assets: system prompt assembly for the finder, the verifier
  system prompt, the two rendered user messages (`finder_user`,
  `verifier_user`), prompt-override semantics, and the `data` defanging
  function.

Not in this area: the agent loop, protocol adapters, the token ledger, and
final-tool argument checking (LLM area); quote grounding, file context,
manifests and exploration tools (context area); the verifier stage and
`Verdict` semantics (verifier area); rendering (render area); the finding
spill and record formats (records area); flag parsing and exit-code mapping
(CLI area). They are mentioned only where this area's contract touches them.

## 2. Behavior contract

### 2.1 Severity

Five values, upper-case on the wire and in all output:

| Value      | Rank |
|------------|------|
| `INFO`     | 0    |
| `LOW`      | 1    |
| `MEDIUM`   | 2    |
| `HIGH`     | 3    |
| `CRITICAL` | 4    |

- `rank(s)`: the table above; any other string (including `""` and
  lower-case spellings) ranks 0, like `INFO`.
- `parseSeverity(s)`: trim surrounding whitespace (Go `unicode.IsSpace`
  set, see 2.10), upper-case with full Unicode upper-casing
  (`String.prototype.toUpperCase` is acceptable), and accept only the five
  names. Returns the canonical name or failure. `""` fails. The CLI also
  uses it for `--max-severity` (after its own upper-casing).
- `effectiveSeverity(f)`: if `f.verdict` is present, its `status` is
  `confirmed`, `parseSeverity(f.verdict.recalibrated_severity)` succeeds,
  and that rank is strictly lower than `rank(f.severity)`, return the
  recalibrated severity; otherwise `f.severity`. Severity can only move
  down, and never on `refuted` or `insufficient_context` verdicts.
- `maxSeverity(result)`: the highest `rank(effectiveSeverity(f))` over
  `result.findings` (kept findings only), or `-1` when there are none.

### 2.2 Finding and WireFinding

`WireFinding` is the model-facing shape (tool arguments). Property order in
the schema's `required` array is significant (reasoning first):

| Field               | Type       | Notes                                   |
|---------------------|------------|-----------------------------------------|
| `reasoning`         | string     |                                         |
| `severity`          | string     | schema enum of the five severities      |
| `confidence`        | number     | schema `minimum: 0`, `maximum: 1`       |
| `cwe`               | string     | CWE id or `""`                          |
| `description`       | string     |                                         |
| `file`              | string     | repository-relative path                |
| `lines`             | integer[]  | real file line numbers                  |
| `code_quote`        | string     | verbatim cited lines                    |
| `fixed_code`        | string     | concrete replacement                    |
| `frontend_category` | string     | enum, see 2.3                           |

`Finding` is `WireFinding` plus fields Roast attaches after the model
responds (never in the model-facing schema). JSON output field order, which
the records and JSON output depend on, is exactly:

```
reasoning, severity, confidence, cwe, description, file, lines,
code_quote, fixed_code, frontend_category,
verdict        (omitted when absent; shape owned by the verifier area)
_drop_reason   (omitted when "")
id             (omitted when "")
alias          (omitted when "")
```

Conversion `toFinding(w)` copies the ten wire fields. `lines` is copied;
an empty or missing `lines` becomes **absent**, and serializes as
`"lines": null` (Go nil slice). A non-empty array serializes as an array.
Parity requires `null`, not `[]`, for an empty `lines` in every JSON
output and record that serializes a `Finding`.

The schema enforces nothing at runtime beyond JSON type decoding (see
2.4): providers may return lower-case or unknown severities, out-of-range
confidence, or unknown `frontend_category`; `validate` handles severity,
the rest pass through unchanged.

### 2.3 Tool schemas (exact)

Both schemas are JSON Schema objects with no `$schema` or `$id`. Every
object level has `"additionalProperties": false`, `"type": "object"`, and
`required` listing every property in declaration order. Go serializes
schema maps with keys sorted alphabetically at every level; the TS version
should do the same (hand-written constants with sorted keys) so request
bodies match the Go baseline in the differential harness.

`WIRE_FINDING_SCHEMA` (used by `report_finding`, and as `items` below):

```json
{
  "additionalProperties": false,
  "properties": {
    "code_quote": {"description": "Verbatim copy of the cited lines, exactly as they appear in <files>", "type": "string"},
    "confidence": {"maximum": 1, "minimum": 0, "type": "number"},
    "cwe": {"description": "CWE id when applicable, else empty string", "type": "string"},
    "description": {"type": "string"},
    "file": {"type": "string"},
    "fixed_code": {"description": "Concrete replacement for code_quote that resolves the issue", "type": "string"},
    "frontend_category": {"description": "Which frontend-addendum dimension produced this finding; empty for non-frontend findings", "enum": ["", "hooks", "security", "a11y", "perf", "ts"], "type": "string"},
    "lines": {"items": {"type": "integer"}, "type": "array"},
    "reasoning": {"type": "string"},
    "severity": {"enum": ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"], "type": "string"}
  },
  "required": ["reasoning", "severity", "confidence", "cwe", "description",
    "file", "lines", "code_quote", "fixed_code", "frontend_category"],
  "type": "object"
}
```

(Long lines inside the JSON block are data, not prose; keep the strings
exact.)

`FINDINGS_RESPONSE_SCHEMA` (used by `submit_findings` and by the
single-shot structured call):

```json
{
  "additionalProperties": false,
  "properties": {
    "assessment": {"enum": ["FINDINGS_PRESENT", "NO_FINDINGS"], "type": "string"},
    "findings": {"items": <WIRE_FINDING_SCHEMA>, "type": "array"}
  },
  "required": ["assessment", "findings"],
  "type": "object"
}
```

Go's `encoding/json` escapes `<` and `>` as `<` / `>` when it
serializes these strings; that is an encoding detail, the decoded strings
are as shown.

### 2.4 Decoding finding arguments (Go `json.Unmarshal` parity)

Arguments are decoded with Go `encoding/json` semantics into the typed
struct. The TS decoder (`decodeWireFinding`, `decodeFindingsResponse`) must
reproduce them:

- Unknown keys are ignored. Key matching is exact and case-sensitive
  (`"Code_Quote"` is an unknown key and is ignored; deliberate change 7 in
  the index spec, unlike Go). Duplicate keys: the last one wins.
- `null` for any field leaves its zero value (`""`, `0`, absent `lines`);
  `null` for the whole object yields an all-zero finding; `null` elements
  inside `lines` become `0`.
- Type mismatches are errors: a string for `confidence`, a number for a
  string field, a non-array `lines`, or a `lines` element that is not an
  integer literal. In the direct decode (submission), `3.0`, `1e2`, and
  out-of-int64-range values in `lines` are errors.
- `confidence` accepts any JSON number.
- Strings: invalid UTF-8 and unpaired surrogate escapes become U+FFFD
  (JS `JSON.parse` keeps lone surrogates; normalize them to U+FFFD).

`report_finding` decodes differently from the final submission because the
agent loop first parses the arguments into a generic map and Roast then
re-serializes and decodes that map (Go round trip). Consequences that must
be kept:

- Numbers pass through float64, so `lines: [3.0]` or `[1e2]` are accepted
  as `3` and `100` (float64 integral values re-serialize without a
  fraction); `3.5` is still an error. Integers above 2^53 lose precision.
- If the raw arguments are not valid JSON, the agent loop hands Run the map
  `{"error": "args parse error: <msg>"}` (LLM area). That map decodes to an
  all-zero `WireFinding` (unknown key ignored), which is **recorded** as a
  finding (and later dropped by `validate` as `invalid_severity`). Keep
  this.

Submission (`submit_findings`) arguments that fail to decode are rejected
by the agent loop (LLM area), not by this area.

### 2.5 Assessment values

| Value                          | Producer                               |
|--------------------------------|----------------------------------------|
| `FINDINGS_PRESENT`             | model, or `validate` when any kept     |
| `NO_FINDINGS`                  | model, or `validate` demotion          |
| `NO_DIFF`                      | CLI, empty scope (no finder call)      |
| `INCOMPLETE_NO_SUBMISSION`     | `find`, interactive run never submitted|
| `NO_FINDINGS_IN_SAMPLED_AREAS` | CLI, survey that converged clean       |

The model-facing enum only offers the first two. `INCOMPLETE_NO_SUBMISSION`
must never be converted to `NO_FINDINGS`. The survey conversion lives in the
CLI: when `--scope repo` and the run is not incomplete and its stop reason
is none of `deadline`, `token_budget`, `budget_exhausted`, an assessment of
`NO_FINDINGS` becomes `NO_FINDINGS_IN_SAMPLED_AREAS` (completion
`complete`, stop reason `converged`); otherwise completion is `partial` and
the stop reason is the result's, or `incomplete_no_submission` when empty.

### 2.6 Result

```ts
type Result = {
    findings:Finding[]          // JSON "findings", never null
    dropped:Finding[]           // JSON "dropped_findings", never null
    assessment:string           // JSON "assessment"
    notes:string[]              // JSON "notes", never null
    incomplete?:boolean         // JSON "incomplete", omitted when false
    stopReason?:string          // JSON "stop_reason", omitted when ""
}
```

JSON key order: `findings`, `dropped_findings`, `assessment`, `notes`,
`incomplete`, `stop_reason`. Stop reasons produced by `find`: `deadline`,
`budget_exhausted` (turn budget, no submission), `token_budget` (run token
ledger exhausted). These are all the values `find` emits; the CLI and
render handle each. (The Go doc comment listing only two is stale.)

### 2.7 Drop reasons

| Value                    | Set by                                       |
|--------------------------|----------------------------------------------|
| `invalid_severity`       | `validate`                                   |
| `missing_code_quote`     | `validate`                                   |
| `missing_fixed_code`     | `validate`                                   |
| `ungrounded_code_quote`  | `validate`                                   |
| `below_confidence_floor` | `validate`                                   |
| `refuted_by_verifier`    | verifier area                                |

Dropped findings are kept (tagged, in `dropped`) for `--show-dropped`, the
records, and adjudication.

### 2.8 `validate(resp, confidenceFloor, ground?)`

Input `resp:{assessment:string, findings:WireFinding[]}`; `ground` is the
optional quote-grounding predicate `(file, quote) => boolean` from the
context area (undefined disables the check). Output: a fresh `Result` with
`assessment = resp.assessment` and empty arrays.

For each wire finding, in input order, `f = toFinding(w)` then the gates
in this exact order; the first failing gate sets `f._drop_reason`, appends
`f` to `dropped`, and moves on:

1. `parseSeverity(f.severity)` fails -> `invalid_severity`. On success the
   canonical name replaces `f.severity` (so `" high "` is kept as `HIGH`).
2. `goTrimSpace(f.code_quote) === ""` -> `missing_code_quote`.
3. `goTrimSpace(f.fixed_code) === ""` -> `missing_fixed_code`.
4. `ground` defined and `!ground(f.file, f.code_quote)` ->
   `ungrounded_code_quote`. (The quote passed is the untrimmed original.)
5. `f.confidence < confidenceFloor` -> `below_confidence_floor` (strict;
   a confidence equal to the floor is kept).

Survivors are appended to `findings`. Then:

- If `findings` is non-empty, `assessment = FINDINGS_PRESENT`.
- Else if `assessment === FINDINGS_PRESENT`, it becomes `NO_FINDINGS`.
- Else the model's assessment is kept unchanged, whatever string it is
  (including `""`, an unknown value, or `INCOMPLETE_NO_SUBMISSION` passed
  in by `find`).

Finally `assignIdentity(result)`. Severity of dropped findings: a finding
dropped at gate 1 keeps its raw severity string; later drops carry the
canonical one.

### 2.9 Identity: `assignIdentity`

Applies to kept and dropped findings alike. Work list `all` = `findings` in
order, then `dropped` in order.

1. For each finding with an empty `id`, set `id` to a fresh random RFC 4122
   version 4 UUID, lower-case hex, `8-4-4-4-12` form
   (`crypto.randomUUID()` matches Go's output format). Existing ids are
   kept.
2. `hex[i] = id` with `-` removed (32 chars). Count every prefix of
   `hex[i]` of length 6..32 across all findings
   (`prefixCount[prefix]++`).
3. For each finding: `n = 6`; while `n < hex.length` and
   `prefixCount[hex[:n]] > 1`, `n++`. `alias = "R-" + hex[:n]`.

The alias is unique among all of the run's ids, not merely among other
aliases. Ids are never derived from content.

### 2.10 Fingerprint (exact; needed for record parity)

```
fingerprint(f) = lowercaseHex(sha256(utf8(f.file + "\u0000" +
                  collapseWhitespace(f.code_quote)))[0..8 bytes])
```

- Output is the first 8 bytes of the SHA-256 digest as 16 lower-case hex
  characters.
- `collapseWhitespace(s)`: iterate code points; replace each maximal run of
  whitespace code points with one ASCII space; then trim leading and
  trailing whitespace.
- Whitespace is Go `unicode.IsSpace`, which is **not** JS `\s`:
  U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000..U+200A,
  U+2028, U+2029, U+202F, U+205F, U+3000. (JS `\s` adds U+FEFF and lacks
  U+0085.) Define one helper `isGoSpace(cp)` and use it here and in
  `goTrimSpace` / `parseSeverity`.
- UTF-8 encoding: `TextEncoder` (lone surrogates become U+FFFD, matching
  Go's decoder output).
- `description`, `severity`, and `lines` are not part of the key. Two
  distinct claims quoting the same lines in the same file collide; this is
  accepted (similarity hint only, never identity, never suppresses a
  finding in output).

Users: the finding accumulator (dedup key), run records, and rendering.

### 2.11 Mode classification

`--mode` values: `code`, `prose`, `mixed`, `auto` (default `auto`).

`classifyMode(files)` (used when `--mode auto`, over the scope's final
file list; in survey scope that is the manifest's file list):

- empty list -> `code`;
- every file has a prose extension -> `prose`;
- at least one -> `mixed`;
- none -> `code`.

Prose extensions (compared after lower-casing the extension):
`.md .mdx .markdown .rst .txt .adoc .asciidoc .org .tex`. Unknown
extensions count as code.

Extension is Go `filepath.Ext`: the suffix of the final path element
starting at its last `.`, or `""` if that element has no `.`. A dotfile
such as `docs/.md` has extension `.md` (Node `path.extname` returns `""`
here; do not use it). `file.` has extension `.`.

After resolving `auto`, the CLI rejects any mode other than the three as a
usage error: `invalid --mode "<flag value>"` (exit 2).

### 2.12 Language prompt packs (`--lang`)

`classifyLangs(files)`: map each file's lower-cased extension through the
table below, dedupe, sort ascending; unmapped extensions contribute
nothing; empty input yields `[]`.

| Extensions                                 | Tag        |
|--------------------------------------------|------------|
| `.tsx .jsx`                                | `react`    |
| `.vue .svelte .astro`                      | `frontend` |
| `.ts .js .mjs .cjs .css .scss`             | `web`      |
| `.go`                                      | `go`       |

`resolveLangs(flagValues, files, mode)`:

1. `mode === "prose"` -> `[]`, and the flag values are not validated at
   all (an unknown pack with prose mode is accepted silently).
2. No flag values (flag absent or given an empty value) -> `classifyLangs
   (files)` ("auto").
3. For each value in order: `none` -> if it is not the only value, usage
   error `--lang none cannot be combined with another language pack`;
   otherwise return `[]`. Any value other than `go`, `react`, `frontend`,
   `web` -> usage error `unknown language pack "<value>"`. Matching is
   case-sensitive and does not trim.
4. Otherwise return the flag values as given: original order, duplicates
   kept, not sorted. This list is what the run record (`derived.langs`)
   and render (`prompt_packs`) receive.

`--lang` is a string-slice flag: repeatable and comma-separated (pflag CSV
semantics; `go, react` yields the value `" react"`, which is unknown).

Addenda selected by the resolved tags (`appendLangAddenda`), always in this
order, each at most once:

1. `go` -> `finder_go_addendum`.
2. `react` or `frontend` -> `finder_frontend_addendum` (once even if both).
3. `react` -> `finder_react_hooks_addendum`.

`web` is accepted and recorded but selects no addendum.

### 2.13 Finder system prompt assembly

`finderSystem(mode, scope, quick, langs, overridePath)` where `scope` is
the `--scope` value (`diff` or `repo`). Pieces are concatenated with no
separator (every addendum file begins with its own newline(s)):

- `prose`: `base = override ?? finder_prose`; if `scope === "repo"`,
  append `finder_scope_survey`. No diff framing in prose diff mode; no
  language addenda (langs is `[]` anyway).
- `mixed`: `base = override ?? finder_core`, then scope framing, then
  `finder_mixed_addendum`, then language addenda.
- `code` (and any other value): `base = override ?? finder_core`, then
  scope framing, then language addenda.
- Scope framing: `repo` -> `finder_scope_survey`; anything else ->
  `finder_scope_diff`.
- If `quick`: append `finder_quick_addendum` last, so it overrides
  everything above.

The override replaces only the base (the core prompt, or the whole prose
base); scope framing, mixed note, language and quick addenda stay
Roast-controlled. Which override applies: `prompts.finder_prose` when the
resolved mode is `prose`, otherwise `prompts.finder_code` (mixed uses the
code override).

### 2.14 Prompt overrides

- Config keys `prompts.finder_code`, `prompts.finder_prose`,
  `prompts.verifier` (config area). Callers always resolve them through
  `promptPath(raw)`: `""` stays `""`; an absolute path is returned as is;
  otherwise it is joined to the config file's directory with path
  normalization (Go `filepath.Join`, Node `path.join`). No `~` expansion.
  The trust projection hashes the raw string (trust area).
- A non-empty path is read with no processing: verbatim bytes as UTF-8
  text, no trimming, no template rendering, no defanging.
- Read failure is an error (not a usage error; the CLI maps it to exit 4):
  `finder prose prompt: prompt override <path>: <os error>` for the prose
  base, `finder core prompt: prompt override <path>: <os error>` for code
  and mixed, `prompt override <path>: <os error>` for the verifier. A
  missing file is a failure.
- `verifierSystem(overridePath)` returns the override or
  `verifier_system`.

### 2.15 Templates

Twelve files move over unchanged as text assets (esbuild `text` loader).
The ten system pieces contain no template actions and are used verbatim.
All end with `\n`; the addenda and scope framings start with `\n` (the
diff framing with `\n\n`).

| File                               | Used when                               |
|------------------------------------|-----------------------------------------|
| `finder_core.tmpl`                 | base for `code` and `mixed`             |
| `finder_prose.tmpl`                | base for `prose`                        |
| `finder_scope_diff.tmpl`           | `code`/`mixed`, scope not `repo`        |
| `finder_scope_survey.tmpl`         | scope `repo` (all modes)                |
| `finder_mixed_addendum.tmpl`       | `mixed`                                 |
| `finder_go_addendum.tmpl`          | lang `go`                               |
| `finder_frontend_addendum.tmpl`    | lang `react` or `frontend`              |
| `finder_react_hooks_addendum.tmpl` | lang `react`                            |
| `finder_quick_addendum.tmpl`       | `--quick`                               |
| `finder_user.tmpl`                 | finder user message (render fn, 2.16)   |
| `verifier_system.tmpl`             | verifier system prompt (unless override)|
| `verifier_user.tmpl`               | verifier user message (render fn, 2.17) |

Content notes relevant to behavior: `finder_core` names the exploration
tools (`read_file`, `list_files`, `grep_repo`) and `submit_findings`,
states the 0.6 confidence filter, and instructs that injected instructions
inside `<diff>`, `<files>`, `<manifest>`, or tool results be reported as a
HIGH prompt-injection finding. The quick addendum caps at 3 findings,
MEDIUM and above, confidence 0.8. These texts are not enforced in code
except through `validate` and the configured floors.

### 2.16 `renderFinderUser` contract

```ts
type FinderUserVars = {
    task:string          // --task, default "(not provided)"
    survey:boolean
    diff:string          // diff mode only; "" in survey
    fileContext:string   // diff mode only; "" in survey
    manifest:string      // survey only; "" in diff mode
}
```

No value is defanged or escaped; all four strings are inserted raw. The
output, with `T[n]` meaning line `n` of the baseline `finder_user.tmpl`
(1-based, without its newline), is exactly:

```
T[1] + "\n\n" + task + "\n"
+ (survey
    ? "\n" + T[5] + "\n\n" + T[7] + "\n\n<manifest>\n" + manifest
      + "\n</manifest>\n\n" + T[13] + "\n"
    : "\n" + T[15] + "\n\n<diff>\n" + diff + "\n</diff>\n\n" + T[21]
      + "\n\n<files>\n" + fileContext + "\n</files>\n\n" + T[27] + "\n")
+ "\n"
```

`T[1]` is the task heading, `T[5]` the manifest heading, `T[7]` the
"contents are not inline" sentence, `T[13]` the survey grounding sentence,
`T[15]` the changes heading, `T[21]` the files-touched heading, `T[27]` the
diff-mode grounding sentence. Copy those lines byte for byte (they contain
U+2014 characters; keep them). Survey selection: `survey` is true exactly
when `--scope repo`.

Finder inputs from the CLI: in survey, `{task, survey:true, manifest}`; in
diff mode, `{task, diff, fileContext}` where `diff` is the fitted
(possibly truncated) scope diff and `fileContext` is the context area's
numbered file context bounded by `limits.max_file_ctx_bytes`. Before any
model call the CLI rejects `byteLength(system) + byteLength(user)` (UTF-8
bytes) above `limits.max_prompt_bytes` as a usage error (CLI area owns the
message).

### 2.17 `renderVerifierUser` contract and `data` defanging

```ts
type VerifierVars = {
    severity:string      // finder's severity (canonical after validate)
    confidence:number
    file:string
    lines:string         // formatted by the verifier area (lineRange)
    description:string
    codeQuote:string
    fixedCode:string
    fileSnippet:string   // numbered snippet from the context area
}
```

The finder's `reasoning` is deliberately absent (anti-anchoring). The
output is the baseline `verifier_user.tmpl` text (25 lines, trailing
newline kept) with each action replaced in place, no other whitespace
changes:

| Template action                  | Replacement                          |
|----------------------------------|--------------------------------------|
| `{{data .Severity}}`             | `dataText(severity)`                 |
| `{{printf "%.2f" .Confidence}}`  | `formatFixed2(confidence)`           |
| `{{data .File}}`                 | `dataText(file)`                     |
| `{{data .Lines}}`                | `dataText(lines)`                    |
| `{{data .Description}}`          | `dataText(description)`              |
| `{{data .CodeQuote}}`            | `dataText(codeQuote)`                |
| `{{data .FixedCode}}`            | `dataText(fixedCode)`                |
| `{{data .FileSnippet}}`          | `dataText(fileSnippet)`              |

The final line (the adjudication instruction) must follow every untrusted
block.

`dataText(s)` defangs closing wrapper tags so untrusted text cannot end its
own tag early. Go pattern:
`(?i)</\s*(claim|code_quote|fixed_code|file_contents)\b`, each match
replaced by `<\/` + the captured name (original case kept; the whitespace
between `</` and the name is removed). Example: `</CODE_QUOTE >` becomes
`<\/CODE_QUOTE >`. Only closing tags are touched; opening tags are not.

Exact semantics to reproduce (Go RE2 differs from JS defaults):

- `\s` is ASCII only: `[\t\n\f\r ]` (no `\v`, no Unicode spaces).
- Case-insensitive matching uses Unicode simple case folding: `ſ`
  (U+017F) matches `s`, `K` (U+212A) matches `k`. In JS this needs the
  `u` and `i` flags.
- `\b` is an ASCII word boundary: the character after the name must be
  absent or not in `[0-9A-Za-z_]`. With `iu` flags JS treats `ſ` and `K`
  as word characters, so do not use JS `\b`; check the following code
  unit explicitly.

A conforming implementation:

```ts
const CLOSE = /<\/[\t\n\f\r ]*(claim|code_quote|fixed_code|file_contents)/giu
function dataText(s:string):string {
    return s.replace(CLOSE, (m, name:string, at:number, all:string) => {
        const next = all.charCodeAt(at + m.length)
        return isAsciiWord(next) ? m : '<\\/' + name
    })
}
```

(No valid match can start inside a rejected candidate, so continuing after
it is equivalent to Go's scan.)

`formatFixed2` (shared `gocompat` module) must equal Go
`fmt.Sprintf("%.2f", x)`: correctly rounded
from the exact binary value with ties to even. `Number.prototype.toFixed`
rounds exact ties up, so it differs on exactly representable ties: the
odd multiples of 0.125 (`0.125 -> "0.12"`, `0.375 -> "0.38"`,
`0.625 -> "0.62"`, `0.875 -> "0.88"`, `1.125 -> "1.12"`). Also Go prints
`-0.00` for negative zero and full digits (no exponent) at or above 1e21.
Implement: for an odd multiple of 0.125, round half to even on the
hundredths digit; otherwise `toFixed(2)`. Behavior for `-0` and values
`>= 1e21` is unspecified (unreachable in practice); no requirement.

### 2.18 The finder stage: `find`

Inputs (`FindInput`):

| Field             | Meaning                                              |
|-------------------|------------------------------------------------------|
| `system`, `user`  | rendered prompts                                     |
| `quick`           | carried for callers; `find` itself does not read it  |
| `confidenceFloor` | passed to `validate`                                 |
| `interactive`     | single-shot when false                               |
| `tools`           | exploration tools (context area), interactive only   |
| `maxTurns`        | to the agent loop; `<= 0` means 8 there              |
| `survey`          | selects the `submit_findings` description            |
| `ground`          | passed to `validate`                                 |
| `capture`         | sink for every early-reported finding (spill)        |
| `deadline`        | work deadline (absolute time) or none                |

**Single-shot** (`interactive` false): one structured call through the
LLM client with tool name `findings`, description `Return the requested
structured result.`, schema `FINDINGS_RESPONSE_SCHEMA`, one turn (LLM
area). Any error propagates unchanged. Otherwise return
`validate(resp, floor, ground)`. No accumulator, no capture, never
`incomplete`.

**Interactive**: the tool list is `tools` (in given order), then
`report_finding`, then `submit_findings`. The final tool is
`submit_findings`.

`report_finding`:

- Description (exact): `Report ONE finding the moment you confirm it,
  instead of holding findings until the end <U+2014> findings reported here are
  saved immediately and survive even if the run is cut off by a budget or
  deadline. Same grounding bar as submit_findings: verbatim code_quote,
  concrete fixed_code. Re-reporting a finding replaces the earlier
  version; submit_findings may repeat it safely (deduplicated).` (one line
  in the wire text; `<U+2014>` stands for that literal character).
- Schema `WIRE_FINDING_SCHEMA`. `recordsResult: true`: the agent loop runs
  it on the reserved wrap-up turn and after the work deadline (where
  exploration tools are refused), and a response that only records does
  not use up a submission attempt (LLM area).
- Run: decode the arguments per 2.4. Re-serialization failure returns the
  tool result `{"error": "<msg>"}`; decode failure returns
  `{"error": "malformed finding: <decode error>"}`. On success
  `acc.add(w)` and return `{"recorded": true, "reported_so_far": <number
  of distinct fingerprints so far>}`. Run never throws.

`submit_findings`:

- Description when not survey (exact): `Submit your final findings. Call
  exactly once when you have gathered enough context; this ends the
  review.`
- Description in survey (exact): `Submit your findings. Call exactly once;
  this ends the review. Submit EVERY grounded defect you found rather than
  a curated best-of. Use confidence to express uncertainty and let the
  verifier adjudicate it. Every finding still needs a verbatim code_quote
  and concrete fixed_code.`
- Schema `FINDINGS_RESPONSE_SCHEMA`. No Run: its decoded arguments are the
  loop's output.

**findingAccumulator** (`sink` = `capture`):

- `add(w)`: `key = fingerprint(toFinding(w))`. If `key` is new, append it
  to `order`. Store `byKey[key] = w` (last report wins: severity or
  wording may be refined). Then call `sink(w)` if present, for every add
  (including replacements and submission merges).
- `ordered()`: `order.map(k => byKey[k])` (first-appearance order, latest
  content).
- The count reported to the model is `order.length`.

Converse is called with: `tools`, `finalTool: "submit_findings"`,
`maxTurns`, `workDeadline: deadline`, and two callbacks that set local
flags `deadlineFired` (`onWorkDeadline`) and `budgetFired`
(`onBudgetExhausted`, the token ledger ran out but the loop could still
run its wrap-up turn).

Outcomes:

1. **Converse fails with a non-"no final call" error** (provider error,
   auth, cancellation, raw abort/timeout): propagate unchanged. The spill
   already holds reported findings.
2. **Converse fails with ErrNoFinalCall** (graceful cutoff; possibly also
   tagged as work-deadline or token-budget):
   - `stopReason` = `deadline` if the error is also ErrWorkDeadline, else
     `token_budget` if it is also ErrBudgetExhausted, else
     `budget_exhausted`.
   - `note` (exact format): `interactive review ended without
     submit_findings (even after the reserved wrap-up turn); stop reason:
     <stopReason>; cause: <full error message>` (single line). The cause
     keeps the provider error or stop reason text (for example
     `finish reason "length"`).
   - If the accumulator has findings (n = `order.length` > 0):
     `result = validate({assessment: INCOMPLETE_NO_SUBMISSION, findings:
     acc.ordered()}, floor, ground)`, then `incomplete = true`,
     `stopReason`, and append to `notes` the `note` and then
     `<n> incrementally-reported finding(s) retained from before the
     cutoff`. If every reported finding is dropped, the assessment stays
     `INCOMPLETE_NO_SUBMISSION`; if any survives it is `FINDINGS_PRESENT`
     but `incomplete` is still true.
   - Otherwise return `{assessment: INCOMPLETE_NO_SUBMISSION, findings: [],
     dropped: [], notes: [note], incomplete: true, stopReason}`.
   - Either way `find` resolves (no error).
3. **Submission accepted**: add every submitted finding to the accumulator
   (dedup by fingerprint, last wins, so a submission can refine a reported
   finding; reported-but-unsubmitted findings are kept), then
   `result = validate({assessment: resp.assessment, findings:
   acc.ordered()}, floor, ground)`. If `deadlineFired` or `budgetFired`:
   `incomplete = true`; `stopReason = "deadline"` (deadline wins when both
   fired) or `"token_budget"`; append the note `work deadline reached; the
   submission is the reserved wrap-up flush, not a converged review` or
   `run token budget exhausted; the submission is the reserved wrap-up
   flush, not a converged review` respectively.

Governing invariant: no stop path discards findings that were reported via
`report_finding`; an unsubmitted run is never a clean `NO_FINDINGS`.
`findings` in a submission may be `null` (decodes to empty).

The LLM area must expose error classification equivalent to Go's
`errors.Is` on wrapped errors: `isNoFinalCall(err)`,
`isWorkDeadline(err)`, `isTokenBudgetExhausted(err)`, and an error message
equal to Go's wrapped `Error()` text for the note.

### 2.19 Finder input resolution in the CLI (contract summary)

The CLI area owns the code; the finder-relevant rules are:

- `--scope`: `diff` (default) or `repo`; anything else is the usage error
  `invalid --scope "<v>" (diff|repo)`. `repo` (survey) with `--quick` is
  the usage error `--quick cannot run a repository survey; drop --quick`;
  with `--staged`, `--uncommitted-only`, or `--base`, the usage error
  `--scope repo cannot be combined with --staged, --uncommitted-only, or
  --base`.
- `interactive = --interactive && !--quick`. Survey forces interactive,
  and its turn default is 40 unless `--max-turns` was given (default 16;
  `--max-turns < 1` is a usage error).
- Small-diff fallback (diff scope, interactive requested): if the count
  of `\n` in the fitted diff is below `interactive.min_diff_lines`
  (default 80) **and** the file count is below `interactive.min_files`
  (default 4), log `diff is small; using a single structured finder call`
  to stderr and run single-shot.
- Work deadline: flag `--deadline`, then `limits.deadline`, then default
  10m (25m in survey); 0 disables. The absolute deadline is taken just
  before the run metadata is written, before the finder call.
- Confidence floor: `review.confidence_floor` (default 0.6), or
  `review.quick_confidence_floor` (default 0.8) with `--quick`. Config
  treats an explicit 0 as unset (config area).
- Exploration tools: provided only when interactive (context area).
- `capture` is the records area's finding spill for the run (may be
  absent outside a repository).
- Verification runs only when not `--quick`, not `--no-verify`, and the
  finder kept at least one finding (verifier area).

### 2.20 Author-aware finder selection (`--author-model`)

Applied after `roles.finder` is resolved and role flags are applied, before
`ValidateRole("finder")`. Config parsing normalizes every
`roles.<role>.author_routes` key with lower-case, trim, and `gemini ->
google`; an empty key, an unknown target profile, or a duplicate key after
normalization is a config error (config area).

`inferFamily(model)`: lower-case and trim; `""` -> `""`. If it contains
`/`, split at the first `/`: if the prefix is one of `anthropic openai
google gemini mistral xai cohere deepseek`, return it (`gemini` ->
`google`); otherwise continue with the part after `/`. Strip a `:api`
suffix, then a `[1m]` suffix. Then, first match wins:

| Condition                                                 | Family      |
|-----------------------------------------------------------|-------------|
| `anthropic`, or prefix `claude-`                          | `anthropic` |
| `openai`, or prefix `gpt-` `codex-` `chatgpt-` `o1` `o3` `o4` | `openai` |
| `google`, `gemini`, or prefix `gemini-`                   | `google`    |
| `mistral`, or prefix `mistral-` `codestral-`              | `mistral`   |
| `xai`, or prefix `grok-`                                  | `xai`       |
| `cohere`, or prefix `command-`                            | `cohere`    |
| `deepseek`, or prefix `deepseek-`                         | `deepseek`  |
| otherwise                                                 | `""`        |

`resolveFinderFlip(finder, authorModel)` returns `{role, note?, warn?}`;
the CLI prints `note` then `warn` to stderr when set:

1. `authorKey = lower(trim(authorModel))`; empty -> unchanged.
2. `authorFamily = inferFamily(authorModel)`.
3. Finder pinned (`roles.finder.pin`): unchanged; if `authorFamily` is set
   and equals `inferFamily(finder.model)`, warn `author-model <a> shares
   the finder family <f>, but the finder is pinned; generation
   independence is reduced`.
4. `target = routes[authorKey]`, else `routes[authorFamily]` when the
   family is set.
5. No target: unchanged; warn `could not determine a model family for
   author-model "<a>" and no exact author route is configured; keeping
   finder <model>` when the family is unknown, or `author-model <a> shares
   the finder family <f> and no author route is configured; generation
   independence is reduced` when the finder is the same family.
6. Resolve the target profile as a bare role (no pin, no routes; config
   errors propagate as usage errors). If (`authorFamily` set and the
   target family is `""` or equal to `authorFamily`) or the target model
   equals `authorModel` case-insensitively: unchanged; warn
   `author-model <a> shares the finder family <f> and profile "<p>" uses
   non-independent model "<m>"; keeping finder <model>`.
7. Otherwise switch the finder to the target role. Note `author-model <a>
   matched an exact route; using finder profile <p> (<m>)` when the family
   is unknown, else `author-model <a> maps to family <f>; using finder
   profile <p> (<m>)`. The switch replaces the whole role, so any
   `--finder-*` overrides applied earlier are not carried over.

`<a>` is the flag value as given (not lower-cased). These messages are
human text; tests must not assert on them.

### 2.21 Constants

| Name                          | Value  |
|-------------------------------|--------|
| default confidence floor      | 0.6    |
| default quick confidence floor| 0.8    |
| min alias hex length          | 6      |
| fingerprint length            | 16 hex |
| default max turns / survey    | 16 / 40|
| default deadline / survey     | 10m / 25m |
| small-diff thresholds         | 80 lines, 4 files |

## 3. TypeScript module design

`src/review/`:

- `types.ts`: `Severity` (string union), `SEVERITIES`, `severityRank`,
  `parseSeverity`, `WireFinding`, `Finding`, `Result`, `ASSESSMENT`
  constants, `DROP` constants, `effectiveSeverity`, `maxSeverity`,
  `toFinding`. `Finding.lines` is `number[]|null` so serialization yields
  `null` for empty. Imports the `Verdict` type from the verifier area.
- Go-compatibility helpers `isGoSpace`, `goTrimSpace`, `goExt`,
  `formatFixed2`, `truncateUtf8` come from the shared
  `src/gocompat/strings.ts` (see the index spec); this area does not
  define its own copies.
- `fingerprint.ts`: `collapseWhitespace(s)`, `fingerprint(f:{file:string,
  code_quote:string}):string` using `node:crypto` SHA-256.
- `schema.ts`: `WIRE_FINDING_SCHEMA`, `FINDINGS_RESPONSE_SCHEMA` (frozen
  constants, keys sorted), `decodeWireFinding(raw:unknown)`,
  `decodeFindingsResponse(raw:unknown)` returning `{ok:true, value} |
  {ok:false, error:string}` with Go `json.Unmarshal` semantics (2.4).
  The LLM area's final-tool check may call `decodeFindingsResponse` via
  the generic "decode final arguments" hook it defines.
- `classify.ts`: `classifyMode(files:string[]):'code'|'prose'|'mixed'`,
  `classifyLangs(files:string[]):string[]`, `resolveLangs(values:string[],
  files:string[], mode:string):string[]` (throws `UsageError`).
- `validate.ts`: `validate(resp:{assessment:string,
  findings:WireFinding[]}, floor:number, ground?:GroundFn):Result`,
  `assignIdentity(result:Result):void`.
- `find.ts`: `type FindInput`, `class FindingAccumulator`,
  `submitDescription(survey:boolean)`, `REPORT_FINDING_DESCRIPTION`,
  `find(client:LlmClient, input:FindInput, signal:AbortSignal):
  Promise<Result>`.

`src/prompts/`:

- `templates/*.tmpl`: the twelve files copied unchanged. esbuild config
  adds `loader: {'.tmpl': 'text'}`; a `declare module '*.tmpl'` gives
  them type `string`.
- `index.ts`: `finderSystem(mode:string, scope:string, quick:boolean,
  langs:string[], overridePath:string):Promise<string>`,
  `verifierSystem(overridePath:string):Promise<string>`, internal
  `loadOverride(path, fallback)` using `fs.promises.readFile(path,
  'utf8')`.
- `render.ts`: `renderFinderUser(v:FinderUserVars):string`,
  `renderVerifierUser(v:VerifierVars):string`, `dataText(s:string)`
  (uses `formatFixed2` from `src/gocompat/strings.ts`). The render
  functions hold the literal lines copied from the baseline templates;
  the two user `.tmpl` files are
  kept only as fixtures for the differential test and deleted at cutover
  (or kept and parsed; either satisfies 00-decisions as long as output is
  identical).

Author selection (`inferFamily`, `resolveFinderFlip`) lives in
`src/config/` with the rest of role resolution; its contract is 2.20.

Dependencies: `src/llm` (client interface, `Tool` with `recordsResult`,
error predicates), `src/context` (`GroundFn`, exploration tools, file
context, numbered snippet), `src/record` (finding spill sink type only),
`src/config` (`promptPath`, floors). Nothing in `src/review` or
`src/prompts` touches the CLI.

## 4. Deliberate changes

None of the listed deliberate changes alter this area's behavior. Debug
tracing (`roast:review`, `roast:prompts`) may log counts, tool names, stop
reasons, and drop reasons, but never prompt text, finding text, or tool
arguments (decision 5).

## 5. Test plan

Lowest seam is pure functions; `find` is tested with a scripted fake
LLM client (the agent-loop seam named in 00-decisions); end-to-end
behaviors through the in-process CLI against the `node:http` fake server.
No assertions on human-readable text beyond what JSON exposes.

Severity and result model (unit):

- Rank order and unknown-as-INFO; `parseSeverity` ignores case and
  surrounding space, rejects `""` (TestParseSeverityIgnoresCase).
- `effectiveSeverity`: only confirmed and strictly lower recalibration
  applies; refuted, insufficient_context, invalid, equal, or higher keep
  the original (TestEffectiveSeverity).
- `maxSeverity` uses effective severity and returns -1 with no findings
  (TestMaxSeverity_UsesEffectiveSeverity).

Validate (unit):

- Each drop reason, gate order, whitespace-only quote/fix, floor
  boundary, assessment promotion and demotion (TestValidateDropReasons).
- Lower-case severity canonicalized and kept; unknown severity dropped as
  `invalid_severity` (TestValidateCanonicalizesSeverity).
- Identity: every kept and dropped finding gets a v4 UUID and an alias
  `R-` + at least 6 hex, unique as a prefix among all ids (new tests; use
  a seeded id source to force a shared prefix).
- Empty `lines` serializes as `null` (new test, JSON seam).

Fingerprint (unit):

- Stable across whitespace differences (TestFingerprint_Stability);
  description ignored (TestFingerprint_DescriptionIgnored); file and code
  change it (TestFingerprint_DifferentFiles,
  TestFingerprint_DifferentCode); 16 hex chars
  (TestFingerprint_Length16).
- New: U+0085 counts as whitespace, U+FEFF does not; a fixed vector
  computed by the Go baseline matches (differential).

Classification (unit):

- `classifyMode` empty/prose/mixed/code, case-insensitive extensions
  (TestClassifyMode); `classifyLangs` mapping, dedupe, sort, unknown
  ignored (TestClassifyLangs). New: dotfile extension (`docs/.md`).
- `resolveLangs`: prose ignores flags, `none` alone, `none` combined is
  an error, unknown pack error, order and duplicates kept (CLI seam,
  exit 2 and recorded `derived.langs`).

Prompts (unit, asserting on structure not wording, e.g. that a given
template asset is or is not contained in the output and in which order):

- Prose base vs code base; survey framing appended for prose only in
  repo scope (TestFinderProseContainsProseRulesNotCodeRules,
  TestFinderProseSurveyContainsProtocol,
  TestFinderProseDiffUnaffectedBySurvey).
- Code base plus diff framing; survey framing in repo scope
  (TestFinderCodeContainsCodeRules, TestFinderCodeDiffBehaviorNeutral,
  TestFinderSurveyContainsProtocolAndAltitude,
  TestFinderDiffScopeUnaffectedBySurvey).
- Mixed adds the mixed addendum (TestFinderMixedContainsBothRules); quick
  addendum is last (TestFinderQuickAppendsConstraints).
- Frontend addendum for react/frontend, once when both, hooks only for
  react (TestFinderFrontendAddendum, TestFinderFrontendAddendumDedup).
- Override replaces only the base, verbatim; missing override is an error
  (TestOverridePathLoading, TestOverridePathMissing,
  TestFinderOverridePath).
- `renderFinderUser` diff and survey branches; survey omits diff/files
  sections (TestFinderUserTemplate, TestFinderUserSurveyManifest).
- `renderVerifierUser` excludes reasoning
  (TestVerifierUserTemplateNoReasoning); injected closing tags are
  defanged so each wrapper closes once and the final instruction is last
  (TestVerifierUserWrapsUntrustedTextInTags). New: `ſ`-folded tag is
  defanged, `\v` between `</` and name is not, `</claimx` is not.
- `formatFixed2` ties: 0.125, 0.375, 0.625, 0.875 (new).
- The existing prompt-content tests (verifier refutation mandate,
  recalibration rule, absence-as-grounding, injection clause, ...;
  TestVerifierSystemPrompt*, TestFinderInjectionClauseCoversManifestAndTools)
  assert on template wording. Under the no-brittle-tests rule replace them
  with one test that the twelve assets are byte-identical to the baseline
  files (or drop them; templates move over unchanged).
- Differential: render both user prompts with the same inputs in Go and
  TS and compare bytes (temporary, per 00-decisions).

Find (scripted fake client):

- Single-shot validates the structured response (TestFind_SingleShot).
- Interactive submission (TestFind_Interactive_OK).
- No final call -> `INCOMPLETE_NO_SUBMISSION`, never `NO_FINDINGS`, with a
  note (TestFind_Interactive_MaxTurns); the note keeps the cause
  (TestNoSubmissionNoteKeepsTheCause); stop reason mapping for deadline,
  token budget, turn budget (new).
- Reported finding survives cutoff, reaches the capture sink, result is
  incomplete (TestFind_Interactive_IncrementalCaptureSurvivesCutoff); all
  reported findings dropped keeps `INCOMPLETE_NO_SUBMISSION`
  (TestFind_Interactive_CutoffWithAllReportedDroppedStaysIncomplete).
- Submission merges reported findings
  (TestFind_Interactive_SubmitMergesReported); accumulator dedup last
  wins, first-appearance order (TestFindingAccumulator_DedupLastWins).
- Successful wrap-up after the deadline is incomplete with stop reason
  `deadline` (TestSuccessfulDeadlineWrapUpIsIncomplete).
- Non-cutoff errors propagate unchanged (TestFind_PropagatesClientError).
- Wrap-up turn: report-then-submit, report-and-submit together,
  report-only, report alongside refused exploration -- kept findings,
  incompleteness, and request counts (TestWrapUpTurnKeepsReportedFindings;
  it drives a real `chat` client against a scripted fake server, so in TS
  it uses the `node:http` fake rather than the scripted adapter).
- `report_finding` with invalid JSON arguments records an empty finding
  that is dropped as `invalid_severity` (new, documents parity).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/review/types.go`, `internal/review/review.go`,
  `internal/review/fingerprint.go`.
- `internal/review/review_test.go`, `review_cutoff_test.go`,
  `wrapup_record_test.go`, `fingerprint_test.go`.
- `internal/prompts/prompts.go`, `internal/prompts/templates/*.tmpl`,
  `internal/prompts/prompts_test.go`.
- `internal/cli/cli.go` (`addReviewFlags`, review run: scope checks,
  mode/langs, prompt assembly, interactive resolution, floors, `Find`
  call, survey completion; `resolveLangs`, `verifierPrompt`).
- `internal/config/config.go` (`PromptPath`, `InferFamily`,
  `ResolveFinderFlip`, author route normalization, floor defaults).
- `internal/llm/agent.go`, `internal/llm/llm.go` (tool dispatch,
  `decodeArgs`, `RecordsResult`, structured call wiring).

## 7. Resolved

1. `FindInput.MaxTurns`: the Go comment ("0 = no limit") is outdated; the
   loop treats `<= 0` as 8 and the CLI rejects values below 1 (spec.md,
   resolved open questions).
2. `stop_reason` values emitted by `find` are `deadline`,
   `budget_exhausted`, and `token_budget` (spec.md, resolved open
   questions).
3. `formatFixed2` for `-0` and `>= 1e21` is unspecified and unreachable in
   practice; no requirement (spec.md, gocompat module).
4. Invalid JSON arguments to `report_finding` record an all-zero finding,
   later dropped as `invalid_severity`: Go parity, kept (spec.md).
5. A successful author route discarding `--finder-*` overrides: Go parity,
   kept (spec.md).
