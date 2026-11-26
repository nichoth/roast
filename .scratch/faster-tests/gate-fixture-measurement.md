# Git and gate fixture measurement

Focused gate commands included bundling and real timeout tests. The old
and new helpers were run twice, sequentially, on the same machine. Other
Node and Git workloads were active, so these figures include load variance.

| Helper | Wall seconds | User seconds | System seconds |
| --- | --- | --- | --- |
| Five Git config commands | 50.61, 27.70 | 3.28, 3.16 | 3.68, 3.28 |
| One local config write | 21.56, 25.74 | 2.78, 2.86 | 2.89, 3.04 |

All four gate runs passed 54 assertions, including scoped reviewed content,
fail-open behavior and real timeout handling. Each gate repository previously
ran five Git config subprocesses; the local config write removes those
launches. The lower CPU times are consistent with less process overhead,
but the wall-time ranges overlap and do not establish an isolated speedup.
The prior focused Git runs were 2.25 and 2.10 seconds before, and 2.97 and
2.93 seconds after; the gate helper change does not affect that suite.

Reproduce with `/usr/bin/time -p npm run test:one -- test/gate/exec.ts`
using the parent of commit 619e70a for the old helper and the commit for
the new helper. Run focused commands sequentially because they share a
bundle in this version of the suite.
