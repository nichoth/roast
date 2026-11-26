# Full-suite verification

On 2026-11-26, `/usr/bin/time -p npm test` passed in 66.56 seconds
with the default limit of four workers and 16 groups. The reporters
printed 7,760 passing assertions; counting case headings gives an
estimated 986 cases. The reporter does not provide a case total.
The full command includes the build. Node was v26.11.1 and npm 12.2.3
on the same Apple M1 macOS machine described in `baseline.md`; other
machine load was not controlled.

The recorded serial baseline was 149.57 seconds, with 7,694 assertions
and an estimated 972 cases. The single observed comparison is 55.5%
faster, above the 50% target, but the suites differ and neither side
has repeated comparable measurements. No variance or robust speedup can
be inferred. Earlier parallel results in the ticket logs had competing
workloads and are not controlled repetitions. This attempt was limited
to one full-suite run, so further runs are needed for the comparison
and to detect intermittent interference.

Lint, typecheck, the full test command, schema diff, and pack dry run
passed on macOS. Lint emitted an existing deprecated-option warning.
Linux was not verified in this attempt. Local HTTP listeners worked.
The suite retained real Git repositories, gate subprocesses, scoped
content and fail-open checks, HTTP, real timers, and signal tests;
live provider tests remain opt-in. No coverage was removed here.
