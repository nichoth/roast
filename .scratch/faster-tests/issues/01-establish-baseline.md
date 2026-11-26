# 01: Establish a repeatable baseline

**Blocked by:** None (can start immediately)
**Touches:** `package.json`, `test/index.ts`,
`.scratch/faster-tests/` measurement notes
**Status:** done

**What to build:** Give maintainers a repeatable, uninstrumented baseline
for the existing full test command before changing its execution or tests.
Use the same machine and configuration for the later comparison.

- [x] Repeated successful full-suite runs record wall times, test and
  assertion totals, machine and resource details, and the command used.
- [x] The results and any listener or sandbox constraints are recorded
  where the final comparison can reference them.
- [x] The baseline leaves the test suite and CI gate behavior unchanged.
