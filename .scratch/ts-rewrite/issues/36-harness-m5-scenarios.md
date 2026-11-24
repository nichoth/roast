# 36: Differential harness M5 scenarios

**Blocked by:** 24, 26, 34
**Touches:** `test/diff/` (new scenario modules and any normalization
they need), the harness allowlist
**Spec:** `spec/15-packaging.md` 2.13 (per-scenario procedure,
normalization, what is not compared, M5 scenario list); spec.md
"Deliberate changes from the Go baseline" (the allowlist)
**Status:** done

## What to build

Extend the Go-vs-TS differential harness from tickets 9 and 26 with the
M5 scenarios, so parity of the remaining commands is measured before
cutover. Each scenario builds two identical fixture repositories, runs
the baseline Go binary and `node dist/cli.js` with a scrubbed
environment, and compares after normalization as in 2.13 step 5.

Scenarios:

- **`runs` listing.** After two reviews against the fake server:
  `runs`, `runs --json`, `runs --limit 1 --json`, and
  `runs show <run-id>`. Compare exit codes and parsed JSON.
- **Snapshot commands.** `runs checkout <run-id> <dir>`. Compare exit
  codes and the checked-out worktree's file set and contents, including
  that denylisted files are absent. Also `runs prune --dry-run` and
  `runs prune --older-than <d>`. Compare exit codes and the set of
  remaining `refs/roast/snapshots/*` refs.
- **`init` with a fake provider.** `init --finder-model <id>
  --verifier-model <id> --no-login`. Compare exit codes and the written
  `.roast.json` (parsed as JSONC; formatting may differ only where the
  allowlist says so) and `.gitignore`.

A difference caused by Go behavior judged wrong is recorded under the
owning area file's Open questions. It is not patched in the harness.
Differences from deliberate changes go on the allowlist, for example
change 11 (run IDs `.`, `..`, or containing separators are rejected) and
change 12 (`runs checkout` clears `GIT_INDEX_FILE` and resolves a
relative target once).

## Acceptance criteria

- [x] `npm run test:diff` runs the `runs` listing scenarios. Go and TS
      agree on exit code and parsed JSON stdout after normalization.
- [x] `npm run test:diff` runs the `runs checkout` scenario. Both CLIs
      exit the same and produce the same file set and contents in the
      target directory, with no denylisted file present.
- [x] `npm run test:diff` runs the `runs prune` scenarios (dry run and
      real). Both CLIs exit the same and leave the same snapshot refs.
- [x] `npm run test:diff` runs the `init` scenario. Both CLIs exit the
      same and write parsed-equal `.roast.json` and equal `.gitignore`.
- [x] Every allowlist entry added here cites the spec.md deliberate
      change it covers. No scenario passes only because of a broad
      ignore rule.
- [x] The harness CI job (Ubuntu) passes with the new scenarios.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
