# 03: Run the full suite in isolated parallel groups

**Blocked by:** 01
**Touches:** `package.json`, `scripts/bundle.ts`, `test/index.ts`,
`test/tooling/test-tap.ts`, `test/tooling/test-one.ts`
**Status:** done

**What to build:** The usual full-suite command builds the CLI and runs
all non-live tests in independent processes with bounded, adjustable
concurrency, producing readable and trustworthy results on macOS and
Linux. Groups must not share mutable bundles or project state.

- [x] Controlled fixture groups prove that all intended tests run once,
  in isolated processes, and output is attributable to its group and test.
- [x] Failed assertions, child crashes, incomplete output, and nonzero
  child exits each make the full command fail.
- [x] A developer can reduce the worker limit, and group resources and
  temporary artifacts are cleaned up on success and failure.
- [x] The normal command builds the CLI first and retains all non-live
  test coverage, including real Git, gate, HTTP, and subprocess checks.
