# 02: Make concurrent focused runs safe

**Blocked by:** 01
**Touches:** `package.json`, `scripts/bundle.ts`,
`test/tooling/test-one.ts`, `docs/agents/typescript.md`, `AGENTS.md`
**Status:** done

**What to build:** Developers can run the existing focused test command
simultaneously for different modules without their bundles or results
interfering. Remove stale guidance that requires serial focused runs.

- [x] Simultaneous focused commands for distinct fixture modules report
  their own results and return their own success or failure status.
- [x] Focused commands preserve their existing interface and fail for a
  missing test file, failed assertion, or crashed test process.
- [x] Temporary bundles are cleaned up on success and failure.

## Comments

Integrated into `tests` on 2026-11-26. Kept its existing `test:one`
implementation and bundle command interface, added the branch's failure
and cleanup tests, and removed obsolete serial-run guidance.

Validation on macOS: focused suite 36/36; full suite 7,760/7,760 across
16 groups. Lint, typecheck, schema diff, and pack dry run passed.
