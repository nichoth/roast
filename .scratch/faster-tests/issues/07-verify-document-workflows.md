# 07: Verify and document faster test workflows

**Blocked by:** 02, 03, 04, 05, 06
**Touches:** `package.json`, `docs/agents/typescript.md`, `AGENTS.md`,
contributor documentation, `.scratch/faster-tests/` measurement notes
**Status:** done

**What to build:** Give contributors documented test workflows and a
credible comparison of the complete suite before and after the changes.

- [x] Repeated full-suite measurements on the baseline machine and
  configuration report wall times, worker count, test and assertion
  totals, variance, and any resource constraints; report the actual
  improvement against the 50% target without a timing assertion.
- [x] Repeated parallel runs pass without interference, and the complete
  CI gate passes: lint, typecheck, tests, schema diff, and pack dry run.
- [x] Contributor guidance describes full and focused commands, worker
  control, focused-run guarantees, and timing reproduction.
- [x] The comparison records retained integration coverage and any
  limitations, including macOS and Linux verification actually performed.
