# 21: Verifier stage in review

**Blocked by:** 20
**Touches:** `src/verify/verify.ts` (`verify`, `VerifyDeps`,
`SUBMIT_VERDICT_TOOL_NAME`, `VERDICT_SCHEMA`, private `verifyOne`),
`src/cli/review.ts` (step 17), `test/verify/*.ts`,
`test/cli/review-verify.ts`
**Spec:** `spec/09-verify-render.md` 2.1-2.4, 2.6, section 3
(`src/verify/verify.ts`), section 5 ("verify" and "CLI seam" groups);
`spec/01-cli.md` 2.8 step 17, 2.2 (partial runs); spec.md "Further
Notes" (`verified: true` with no findings, `null` notes)
**Status:** done

## What to build

A developer runs `npx roast review` without `--no-verify` or `--quick`.
After the finder returns at least one finding, Roast logs the
`verifying <n> finding(s) ...` line, then asks the verifier role to
confirm, refute, or recalibrate each finding through the agent loop with
the `submit_verdict` final tool and the exploration tools over the
reviewed tree. Refuted findings that are grounded move to the dropped
list with `refuted_by_verifier`. Findings the verifier could not decide,
findings past the per-run cap, and findings launched after the shared
token ledger ran out stay in the report as undecided and make the run
partial (exit 4 unless `--max-severity` trips first).

`verify` runs in a small promise pool (default 4 workers, the shared pool
from ticket 03) that hands out indices in ascending order and writes into
a preallocated array, so output order equals input order. It never
throws: any loop error, including abort, becomes the undecided verdict.
Cancellation during verification therefore still writes the report and
run record and exits 4.

The CLI wiring (step 17): construct the verifier client only when
`doVerify` and at least one finding; per-finding user prompt from the
prompts area's `renderVerifierUser` with the context area's
`numberedSnippet(repo, file, 60_000, tree)`; `maxTurns` 8; `maxVerified`
from flag -> `limits.max_verified` -> 25 (0 = no cap); the run's shared
ledger; the `log` callback writes each line verbatim to stderr;
`usage.verifier` recorded in the report and meta; `partial` set when any
kept verdict is undecided. With zero findings no verifier request is
made, yet the report says `verified: true` and `usage` has only
`finder`.

Out of scope: `responses` and `anthropic` verifier combinations
(tickets 27 and 28); snapshots (22).

## Acceptance criteria

Module seam (`verify` with an in-process fake LLM client):

- [x] A confirmed verdict keeps the finding with the verdict attached
  and `verifier` set to the client's model name.
- [x] A grounded recalibration lowers effective severity; an ungrounded
  one is cleared to `""`; the finding's own `severity` never changes.
- [x] A grounded refutation drops the finding with `_drop_reason:
  "refuted_by_verifier"` after any pre-existing dropped findings, and
  `FINDINGS_PRESENT` becomes `NO_FINDINGS` when nothing remains;
  `INCOMPLETE_NO_SUBMISSION` is never converted.
- [x] A refutation with blank or whitespace-only grounding fails open to
  `insufficient_context`, undecided.
- [x] A loop error yields an undecided `insufficient_context` verdict
  and the finding is kept.
- [x] Output order equals input order when completions arrive in reverse.
- [x] Findings at index `>= maxVerified` get the cap verdict without a
  client call; a ledger exhausted before launch yields the budget verdict
  without a call; never more than `concurrency` calls are in flight.
- [x] Refuted log lines contain no control characters and are emitted in
  input order after all verifications finish.
- [x] An input result with empty `notes` yields `notes: null`;
  `assessment`, `incomplete`, and `stopReason` are copied unchanged.
- [x] `VERDICT_SCHEMA` deep-equals the JSON in 2.4 and its serialized
  property keys are alphabetical.

CLI seam (`run(argv, io)` against the fake `chat` server):

- [x] Finder plus verifier on a custom endpoint with `--format json
  --max-severity HIGH`, all budgets 0 and `--max-attempts=1`, exits 1;
  stdout JSON carries a finding whose verdict status is `confirmed`;
  `provider-responses.jsonl` has one line per model call for both roles;
  budgets record `verifier_cap: 0`.
- [x] A verifier that never calls `submit_verdict` leaves an undecided
  verdict and the review exits 4 without `--max-severity`.
- [x] `--quick` and `--no-verify` make no verifier request and report
  `verified: false`; a run with zero findings and verification on makes
  no verifier request and reports `verified: true` with only a `finder`
  usage entry.
- [x] Without `--no-verify`, an invalid verifier role exits 2 with zero
  requests; with `--no-verify` the same config reviews.
- [x] `--max-verified 1` with two findings sends one verifier
  conversation and the second finding's verdict is undecided (exit 4).
- [x] The verifier request's tool list ends with `submit_verdict` after
  the exploration tools.
- [x] Aborting `io.signal` during verification still writes
  `result.json.gz` and `report.md` and exits 4.

- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
