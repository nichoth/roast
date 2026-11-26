# 06: Reduce measured Git and gate fixture overhead

**Blocked by:** 01
**Touches:** `test/gate/exec.ts`, `test/gate/exec-helpers.ts`,
`test/git/git.ts`, `test/helpers/repo.ts`, related fixtures as measured
**Status:** done

**What to build:** Reduce measured redundant Git and gate fixture work
while keeping each test isolated and preserving distinct behaviors.

- [x] Measurements identify the fixture work addressed and show the
  effect of the changes on the affected tests.
- [x] Real Git and gate subprocess tests still verify reviewed content,
  fail-open behavior, timeout or signal behavior, and cleanup where
  applicable, without removing distinct scenarios.
- [x] Repeated affected tests leave no project state in the checkout or
  user configuration and remain isolated from one another.
