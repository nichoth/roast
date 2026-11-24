# 17: Report rendering

**Blocked by:** 16
**Touches:** `src/render/render.ts` (`Report`, `SizeEntry`, `toJSON`,
`toMarkdown`, `writeReport`), `src/render/exit.ts` (`reportExitCode`,
pure helper for 09 2.6 items 2-4), `test/render/`, `test/index.ts`
**Spec:** `spec/09-verify-render.md` 2.1 (data model), 2.5-2.9, 3
(`src/render/render.ts`), 5 ("render"); `spec.md` "Cross-cutting rules"
(JSON encoding), "Further Notes" (`null` vs `[]`)
**Status:** done

## What to build

Pure rendering of a review `Report` into the JSON report and the Markdown
report, plus the writer that sends them to the right streams.

`toJSON` builds one compact JSON object with top-level keys in
alphabetical order, finding, verdict, and usage objects in documented
field order, optional keys omitted (never `undefined`), budgets with
nested keys sorted, and the `null` vs empty distinctions of 2.7
(`files_reviewed`, `notes`, `prompt_packs`, `usage`, a finding's `lines`
are `null` when absent; `findings` and `dropped_findings` are always
arrays). No HTML escaping; JSON strings are never passed through
`textsafe`. Survey fields (`completion`, stop reason, manifest count)
appear only for `survey_triage` reports; truncation fields
(`diff_truncated`, `original_diff_bytes`, `size_breakdown`) only when the
diff was truncated.

`toMarkdown(report, showDropped)` (2.8) sorts findings by effective
severity then confidence (stable), neutralizes hostile finding text with
`textsafe` (ticket 03), never lets finding text start a top-level
heading, sizes code fences longer than any backtick run inside, annotates
recalibrated severity only when it differs, and shows the dropped section
only with `showDropped`. Number formatting uses `gocompat`.

`writeReport` writes JSON plus `\n` to stdout for `json`/`both`, then
Markdown plus `\n` to stderr for `markdown`/`both`. No color or TTY
detection.

Exit mapping: `reportExitCode(result, gateRank, partial)` returns 1 when
`gateRank >= 0` and the result's `maxSeverity` (ticket 16) is at least
`gateRank`, else 4 when partial, else 0. Finalization-failure precedence,
flag validation (`--format`, `--max-severity` parsing), and the `NO_DIFF`
empty-scope path are wired by the review command in ticket 20, which
calls this helper from `reviewExitError`. Verifier behavior is ticket 21.

## Acceptance criteria

- [x] `toJSON` output parses, has top-level keys in alphabetical order,
  and round-trips findings including a non-empty `fingerprint` on each.
- [x] Absent `filesReviewed`, `promptPacks`, `usage`, notes, and finding
  lines serialize as `null`; present-but-empty ones as `[]`/`{}`;
  `findings` and `dropped_findings` are arrays even when empty.
- [x] A truncated-diff report carries `diff_truncated`,
  `original_diff_bytes`, and `size_breakdown`; an untruncated one carries
  none of them.
- [x] Survey fields appear in JSON only when `reviewKind` is
  `survey_triage`, and the Markdown survey banner appears only then
  (asserted structurally).
- [x] JSON contains `<`, `>`, `&`, U+2028, and U+2029 unescaped, and
  budgets nested keys are sorted.
- [x] For hostile finding text, Markdown contains no raw C0 (other than
  newline and tab where allowed), DEL, or C1 characters, escapes stay
  visible, no finding-text line begins a top-level heading, and every
  code fence is longer than any backtick run inside it, while JSON still
  round-trips the raw description.
- [x] Markdown orders findings by effective severity then confidence,
  stably (asserted by alias order in `### ` lines).
- [x] The dropped section and dropped tags appear only with
  `showDropped`.
- [x] A recalibrated severity is annotated only when effective severity
  differs from the original.
- [x] Structural ports of the Go headline tests: the no-findings,
  no-diff, incomplete-no-submission, and findings cases each choose the
  expected branch, and a verified finding shows its verifier/grounding
  item and its file code span (no exact wording asserted).
- [x] `writeReport` with `json` writes only to stdout, with `markdown`
  only to stderr, with `both` writes JSON to stdout and Markdown to
  stderr, each ending in `\n`.
- [x] `reportExitCode` returns 1 when the gate trips on effective
  severity of live findings only (dropped and refuted never trip it), 4
  for a partial run that does not trip the gate, and 0 otherwise.
- [x] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
