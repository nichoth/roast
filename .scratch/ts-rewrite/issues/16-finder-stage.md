# 16: Finder stage

**Blocked by:** 11, 14, 15, 39, 40
**Touches:** `src/review/types.ts` (`Severity`, `SEVERITIES`,
`severityRank`, `parseSeverity`, `WireFinding`, `Finding`, `Result`,
`ASSESSMENT`, `DROP`, `effectiveSeverity`, `maxSeverity`, `toFinding`,
`Verdict` type placeholder for ticket 21), `src/review/schema.ts`
(`WIRE_FINDING_SCHEMA`, `FINDINGS_RESPONSE_SCHEMA`, `decodeWireFinding`,
`decodeFindingsResponse`), `src/review/validate.ts` (`validate`,
`assignIdentity`), `src/review/fingerprint.ts` (`collapseWhitespace`,
`fingerprint`), `src/review/find.ts` (`FindInput`, `FindingAccumulator`,
`submitDescription`, `REPORT_FINDING_DESCRIPTION`, `find`),
`test/review/`, `test/index.ts`
**Spec:** `spec/08-finder-prompts.md` 2.1-2.10, 2.18, 2.21, 3, 5
("Severity and result model", "Validate", "Fingerprint", "Find");
`spec/07-agent-loop.md` 3.3 (`Tool.recordsResult`, `FinalSpec`);
`spec.md` "Deliberate changes" 7, "Cross-cutting rules" (JSON encoding)
**Status:** done

## What to build

The finder stage as a library: given rendered prompts, an LLM `Client`
(ticket 14), exploration tools, and a grounder (ticket 11), `find` runs
either one structured call or an interactive conversation and returns a
validated `Result`.

Severity and the finding model follow 2.1-2.2: rank order with unknown
as INFO, `parseSeverity` ignoring case and surrounding space,
`effectiveSeverity` applying only confirmed, strictly lower
recalibrations, and `maxSeverity` returning -1 with no findings.
`Finding.lines` is `number[]|null` so an empty list serializes as `null`.
The `Verdict` type is declared here minimally; the verifier stage that
fills it is ticket 21.

Tool schemas (2.3) are frozen constants whose JSON matches the baseline
exactly, with sorted keys. Decoding final and reported arguments follows
Go `json.Unmarshal` semantics (2.4): exact, case-sensitive keys
(deliberate change 7), `null` as absent, and the documented coercions and
errors.

`validate(resp, floor, ground)` applies the drop gates in the 2.8 order
with the 2.7 drop reasons, canonicalizes severity, and promotes or demotes
the assessment. `assignIdentity` gives every kept and dropped finding a
v4 UUID and a short `R-` alias unique as a prefix among all ids (2.9);
the id source is injectable so tests can force a shared prefix.
`fingerprint` is the 16-hex SHA-256 contract of 2.10, using Go whitespace
rules from `gocompat` (U+0085 is whitespace, U+FEFF is not).

`find` (2.18): single-shot uses `completeStructured` with tool `findings`;
interactive offers the caller's tools, then `report_finding`
(`recordsResult: true`, never throws, feeds `FindingAccumulator` and the
`capture` sink), then the final `submit_findings`. Cutoffs (no final
call, work deadline, token budget, turn budget) produce an incomplete
result with `INCOMPLETE_NO_SUBMISSION` or the accumulated findings and the
mapped stop reason, never `NO_FINDINGS`; other client errors propagate
unchanged. Wire text with U+2014 is written as `\u2014` in source.

Out of scope: rendering (17), records and the finding spill file (18;
here `capture` is just a callback), CLI wiring (20), survey-specific CLI
completion logic (25).

## Acceptance criteria

- [x] `parseSeverity` accepts any case with surrounding space, rejects
  `""`; unknown severities rank as INFO.
- [x] `effectiveSeverity` applies only a confirmed, strictly lower
  recalibration; refuted, insufficient_context, invalid, equal, or higher
  keep the original. `maxSeverity` uses effective severity and is -1 with
  no findings.
- [x] `validate` produces each drop reason, respects gate order, treats
  whitespace-only quote or fix as missing, applies the confidence floor
  boundary as in Go, and promotes or demotes the assessment.
- [x] Lower-case severities are canonicalized and kept; an unknown
  severity is dropped as `invalid_severity`.
- [x] After `assignIdentity`, every kept and dropped finding has a v4 UUID
  and an `R-` alias of at least 6 hex characters that is a unique prefix
  among all ids, including when a seeded id source forces a shared prefix.
- [x] A finding with no lines serializes `lines` as `null`.
- [x] `fingerprint` is 16 hex characters, stable across whitespace
  differences, ignores the description, changes with file or code, treats
  U+0085 as whitespace and U+FEFF as not, and matches a checked-in vector
  computed by the Go baseline.
- [x] `WIRE_FINDING_SCHEMA` and `FINDINGS_RESPONSE_SCHEMA` deep-equal the
  baseline JSON in 2.3.
- [x] `decodeFindingsResponse` rejects a wrong-case key such as
  `"Severity"`, treats `null` as absent, and otherwise matches the 2.4
  decoding rules.
- [x] With a scripted fake adapter: single-shot returns the validated
  structured response; interactive returns validated submitted findings.
- [x] A conversation that never submits yields assessment
  `INCOMPLETE_NO_SUBMISSION`, `incomplete: true`, a note that keeps the
  cause, and stop reasons `deadline`, `token_budget`, and turn budget
  mapped per 2.18.
- [x] Findings reported through `report_finding` reach the `capture` sink,
  survive a cutoff, and make the result incomplete; if all are dropped the
  assessment stays `INCOMPLETE_NO_SUBMISSION`.
- [x] Submission merges reported findings; the accumulator dedups by
  fingerprint with last-wins content and first-appearance order.
- [x] A successful wrap-up after the work deadline is incomplete with stop
  reason `deadline`; a non-cutoff client error propagates unchanged.
- [x] Driving a real `chat` client against the `node:http` fake server
  (ticket 13), the wrap-up turn keeps reported findings for
  report-then-submit, report-and-submit together, report-only, and report
  alongside refused exploration, with the expected incompleteness and
  request counts.
- [x] `report_finding` with invalid JSON arguments records an empty
  finding that `validate` drops as `invalid_severity`.
- [x] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
