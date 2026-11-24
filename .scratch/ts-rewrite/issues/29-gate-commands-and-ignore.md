# 29: Gate commands and `ignore`

**Blocked by:** 05
**Touches:** `src/gate/constants.ts` (`HOOK_SCRIPT`, `manualLine`),
`src/gate/git-config.ts`, `src/gate/decision.ts` (`readDecision`,
`recordDecision`, `recordNotice`), `src/gate/hook.ts` (`inspect`,
`isActive`, `summary`, `install`, `remove`, `appendable`),
`src/fsutil/atomic.ts` (mode and temp-name options for hook writes),
`src/cli/gate.ts` (`enable`, `disable`, `status` next to the existing
hidden `settings`), `src/cli/ignore.ts` (`ignore`,
`ensureStateIgnored`, `STATE_IGNORE_ENTRY`), `test/gate/`,
`test/cli/gate.ts`, `test/cli/ignore.ts`, hook execution tests with the
shell stub
**Spec:** `spec/12-gate.md` 2.1 to 2.10, 2.12, 2.13, 3, 4, 5 (all
groups except Bootstrap and Gate settings); spec.md deliberate change 19
**Status:** done

## What to build

A user can turn the pre-commit gate on and off and inspect it with
`npx roast gate enable`, `gate disable`, and `gate status`. They can add
`/.roast/` to the toplevel `.gitignore` with `npx roast ignore`. The
installed hook works exactly as the Go-installed one did. A hook
installed by the Go version compares equal and is not reported stale,
because `HOOK_SCRIPT` is the byte-identical `pre-commit.sh`. It is
imported with the esbuild text loader from `internal/gate/pre-commit.sh`
until M6.

Scope:

- Hook ownership detection (anchored marker, appended block markers).
- Appendable foreign shell hooks. Deliberate change 19: a one-line hook
  without a trailing newline gets one before the block.
- The sidecar, and shared dispatchers through `core.hooksPath`.
- The `roast.gate` decision and `roast.gate-notice` keys in local git
  config.
- The atomic hook writes of 2.7.

Seam resolution 7: hook writes go through the shared `fsutil`
`writeFileAtomic`, extended with a final-mode option and a temp name of
`.<basename>.roast-<random>` (exclusive create, retry on `EEXIST`). Do
not add a separate `gate/atomic.ts`. Git calls use the shared git runner
from ticket 3 with the injected env.

`gate enable` requires a toplevel `.roast.json` (`gateConfigPath`). It
does not load, validate, or trust-check it. `gate settings` already
exists (ticket 5). The review-time bootstrap offer is ticket 30.
`init`'s call to `ensureStateIgnored` is ticket 34.

## Acceptance criteria

- [x] `gate enable` in a temp repo with a toplevel `.roast.json` writes
      `.git/hooks/pre-commit` equal to `HOOK_SCRIPT` with mode 0755, and
      sets local `roast.gate=enabled`. Without a toplevel config it exits
      2 and writes nothing.
- [x] Rerunning `enable` rewrites a stale own hook and repairs a lost
      execute bit.
- [x] A foreign shell hook gains the block after its shebang plus a
      sidecar `roast-pre-commit`. Its mode, including a missing execute
      bit, is preserved, and a stale sidecar is refreshed. A one-line
      foreign hook without a trailing newline gets one before the block.
- [x] A non-shell hook and a symlinked hook are left byte-identical
      (symlink target untouched), and `enable` still records `enabled`.
- [x] `gate disable` deletes an own hook. It strips only the block from
      a foreign hook, leaving the remainder byte-identical. It leaves an
      untouched foreign hook alone, and records `declined`.
- [x] Ownership is anchored. Marker text mid-file is not ours. A begin
      marker without an end is never stripped. A marker pair without the
      invocation line counts as foreign.
- [x] A foreign file at the sidecar path is never overwritten or
      deleted.
- [x] A planted symlink at `pre-commit.roast-tmp` or at a
      `.pre-commit.roast-*` name is not followed by a hook write.
- [x] `core.hooksPath` is honoured.
- [x] Shared dispatcher: a shared hook does not review in a repo without
      local consent, even with a global `roast.gate=enabled`. `disable`
      in one repo preserves the dispatcher for the other, refreshes a
      legacy dispatcher, and never touches a foreign sidecar.
- [x] Decisions round-trip through `readDecision` including the
      enrollment aliases the script accepts. Recording a decision clears
      `roast.gate-notice`.
- [x] The `appendable` table of 2.5 holds (pure function or through
      `enable`).
- [x] `gate status` exits 0 and prints three lines. Gate subcommands
      with extra positional args exit 2, and `gate` with no subcommand
      exits 0.
- [x] Hook execution: these tests make a real `git commit` against the
      ported shell stub at `node_modules/.bin/roast`.
      1. A path-scoped commit reviews only that path's content.
      2. Stub exit 1 blocks the commit and the stub's stderr marker
         reaches the user.
      3. `ROAST_SKIP=1` runs no review.
      4. Empty stdout, other exit codes (including 2), a missing binary,
         a failing `gate settings`, and a timeout all allow the commit.
      5. Timeout and severity come from `gate settings`, not env.
      6. The appended block runs alongside a foreign hook, including one
         that exits early.
      7. A non-executable hook does not run.
      The timeout test can be skipped with an opt-out env variable.
- [x] `ignore` creates `.gitignore` containing `/.roast/\n` and appends
      to an existing one, terminating an unterminated last line. It
      leaves any equivalent entry form unchanged, is a no-op the second
      time, and exits 2 outside a repository.
- [x] Every git child in these tests runs with
      `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, and
      maintenance disabled in new repos.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
