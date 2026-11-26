# Make the test suite substantially faster

**Status:** ready-for-agent

## Problem Statement

Developers wait too long for feedback from the test suite. A measured
local run took 143.6 seconds for 974 test cases and 7,694 assertions.
The suite runs cases serially, exercises many real Git repositories and
subprocesses, and waits for production timeouts and retry backoff. Much
of that coverage is useful, but elapsed time is not itself evidence of
correct behavior.

The full suite needs to remain a trustworthy release and CI gate while
developers get substantially faster feedback. Fast focused checks should
also remain available during development.

## Solution

Run independent test groups concurrently in isolated processes, and
replace unnecessary real-time waits with controllable test dependencies.
Preserve behavioral coverage, including representative real Git, gate,
HTTP, timeout, cancellation, and subprocess integration tests.

Keep the existing full-suite command and CI gate reliable. Measure the
result against the current serial baseline on the same machine. Aim for
at least a 50% reduction in full-suite wall time; report actual results
and any machine or resource constraints rather than making a fragile
timing assertion part of the ordinary test suite.

## User Stories

1. As a developer, I want the full suite to finish substantially faster,
   so that I can validate changes more often.
2. As a developer, I want independent groups to run concurrently, so
   that one slow group does not block unrelated checks.
3. As a developer, I want isolated processes, so that tests changing the
   working directory or global state cannot interfere with one another.
4. As a developer, I want a focused test command, so that I can get
   feedback while editing a single area.
5. As a developer, I want concurrent focused runs to avoid shared output
   files, so that they cannot silently execute the wrong test bundle.
6. As a developer, I want the usual full-suite command to keep working,
   so that existing workflows do not need an undocumented migration.
7. As a developer, I want failures identified by group and test, so that
   parallel output remains actionable.
8. As a developer, I want test failures and crashes to fail the command,
   so that output processing cannot conceal a broken test.
9. As a developer, I want every intended test to run exactly once, so
   that faster execution does not silently reduce coverage.
10. As a developer, I want real retry behavior checked without waiting
    for production backoff, so that retries remain safe and fast to test.
11. As a developer, I want timeout and cancellation behavior checked
    without avoidable long sleeps, so that edge cases stay affordable.
12. As a developer, I want a few real-clock checks retained, so that
    production timer and process behavior still receive integration
    coverage.
13. As a developer, I want real Git and gate integration coverage
    retained, so that shell and repository behavior remain trustworthy.
14. As a developer, I want each test's project state isolated, so that
    trust, credentials, and run records do not leak across tests.
15. As a developer, I want workers to clean up their resources on success
    and failure, so that repeated runs stay reliable.
16. As a developer, I want a sensible worker limit, so that parallelism
    does not overwhelm a laptop or CI runner.
17. As a maintainer, I want repeatable before-and-after measurements, so
    that I can judge whether the change is worthwhile.
18. As a maintainer, I want the full CI gate preserved, so that speeding
    up tests does not skip build, lint, typecheck, schema, or pack checks.
19. As a maintainer, I want test commands and limitations documented, so
    that contributors know which validation they have run.
20. As a maintainer, I want the suite to work on macOS and Linux, so that
    parallel execution respects supported development environments.

## Implementation Decisions

- Keep the TypeScript package and existing CI gate. The full test command
  still builds the CLI before tests that execute it, runs the complete
  non-live suite, and returns a nonzero status on failure.
- Partition the suite into independent groups that execute in separate
  Node processes with bounded concurrency. Preserve test discovery and
  ensure every existing case is included exactly once. A group must not
  mutate another group's bundle or other shared generated artifacts.
- Provide readable results for each group, with failures, crashes,
  incomplete output, and nonzero child exits reliably propagated. Avoid
  interleaving that makes diagnostics impossible to associate with a
  group. Preserve the test pipeline's existing failure semantics.
- Make focused test invocations safe to run concurrently, including
  independent temporary bundle paths and cleanup. Preserve their existing
  command-line interface and nonzero failure behavior.
- Prefer existing dependency injection for sleep and test fakes. Where
  end-to-end orchestration lacks a suitable seam, add the smallest
  practical seam at a high boundary. Preserve production retry delays,
  timeout values, cancellation, and command behavior.
- Replace avoidable real waits, especially the interrupted inference
  stream's retry and the doctor timeout, with deterministic control over
  the relevant delay or signal. Keep representative real-clock tests
  where they prove integration with actual timers or subprocesses.
- Investigate the slow gate and Git fixtures with measurements; reduce
  redundant setup where isolation and behavior allow it. Do not remove a
  distinct behavioral scenario solely to improve the timing.
- Keep all tests isolated from user configuration, credentials, and the
  checkout. Account for process-wide working directories, temporary Git
  repositories, local HTTP listeners, and cleanup on failure.
- Use bounded concurrency appropriate to available resources and expose a
  way to reduce it for constrained or diagnostic environments.
- Document the commands, worker control, focused-run guarantees, and
  how to reproduce the timing comparison in contributor documentation.

## Testing Decisions

- A good test verifies observable behavior at the highest practical seam,
  not private worker scheduling, a specific partition layout, or the
  implementation of a test double.
- Exercise the full test command with controlled fixture groups to prove
  complete execution, isolation, attributable output, and failure
  propagation for failed assertions, crashes, and incomplete output.
  Existing test-pipeline command tests provide prior art.
- Exercise simultaneous focused commands using distinct fixtures, and
  verify that each reports its own result and exit status. Existing
  focused-command tests provide prior art.
- Exercise retry and timeout behavior at existing agent, CLI, and HTTP
  seams with controlled delays. Verify retry requests, delay decisions,
  cancellation, and resulting observable outcomes. Existing injected
  sleep and local inference-server tests provide prior art.
- Retain representative integration tests using actual Git, gate
  subprocesses, HTTP, timers, and signals. Preserve assertions about
  reviewed content, fail-open behavior, and cleanup.
- Compare repeated full-suite wall times before and after on the same
  machine and configuration. Report the worker count, test and assertion
  totals, results, and any variance. Verify the complete CI gate and
  repeat parallel runs to detect interference; timing is a benchmark,
  not a hard-coded assertion in the normal test suite.

## Out of Scope

- Changing Roast's production retry, timeout, gate, or review semantics.
- Deleting meaningful coverage or making live provider tests mandatory.
- Rewriting the project in another language or replacing the package
  architecture.
- Guaranteeing an absolute runtime on every machine or claiming the full
  integration suite will be instant.

## Further Notes

The baseline is from an instrumented test-bundle run, not a complete
unmodified full-suite command. It passed all assertions. Re-establish a
comparable uninstrumented baseline before implementing the change.
Local HTTP listeners are required for integration tests. The first
measurement attempt could not complete under a sandbox that denied them.
