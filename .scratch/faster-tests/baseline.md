# Serial full-suite baseline

Measured before changes to test execution or test cases, at commit
`fa7f82b18e625421e88dc5e3193a2b573f70ac08`. Run the same command on the
same machine and configuration for the later comparison:

```sh
/usr/bin/time -p npm test
```

| Run | Wall time | Result | Assertions |
| --- | ---: | --- | ---: |
| 2026-11-25 | 149.57 s | exit 0 | 7,694 passing |

The test reporter showed a duration of 2m 27.9s. It does not print a test
case total; counting lines formatted as case headings in the captured output
produced 972, which is an estimate rather than a reporter-provided total.
Only one run was permitted for this attempt, so this is not yet a repeated
baseline and provides no measure of variance. Repeat the command before
changing execution to complete the baseline.

Machine: Apple M1, 8 logical and 8 physical CPUs, 16 GiB memory; macOS
26.5.1 (25F80), arm64; Node v26.11.1, npm 12.2.3, Git 2.49.0. The
existing serial command was used with installed dependencies and no worker
configuration. Other machine load was not controlled.

The run successfully exercised local HTTP listeners. This environment did
not deny them; a prior sandboxed measurement described in the spec did.
The earlier 143.6 s figure was an instrumented bundle measurement and is
not directly comparable to this full-command wall time.

No test cases, test commands, or CI gate configuration were changed to
collect this measurement.
