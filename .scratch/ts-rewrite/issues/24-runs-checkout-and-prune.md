# 24: `runs checkout` and `runs prune`

**Blocked by:** 22, 23
**Touches:** `src/snapshot/snapshot.ts` (`load`, `restore`,
`removeWorktree`, `prune`, `Pruned`), `src/cli/runs.ts` (add `checkout`
and `prune` subcommands), `test/snapshot/*.ts`,
`test/cli/runs-snapshot.ts`
**Spec:** `spec/11-snapshot.md` Constants, Git invocation rules, Load,
Restore, Remove worktree, Prune, `npx roast runs checkout`, `npx roast
runs prune`, Deliberate changes, Test plan items 1, 9, 13-15 and the "New
tests" paragraph; `spec/10-records.md` 2.4 (`readMeta` prefix
resolution); spec.md deliberate change 12
**Status:** done

## What to build

A developer replays a past review. `npx roast runs checkout <run-id>
[dir]` reads the run's `meta.json` (unique-prefix resolution under the
current toplevel's `.roast/runs/`), and when the run captured a snapshot,
materializes it into a detached linked worktree of the repository
recorded in `meta.json`: `worktree add --detach --no-checkout` at the
original HEAD, `read-tree` the worktree tree, `checkout-index -a -f`,
then `read-tree` the index tree, so `git status`, `git diff HEAD`, and
`git diff --cached HEAD` reproduce the reviewed state (except denylisted
files, ignored files, and empty directories). Stdout carries only the
destination path; stderr carries the `worktree remove` hint. A failed
restore removes the half-built worktree before failing.

Deliberate change 12 applies: restore clears an inherited
`GIT_INDEX_FILE` for every git call it makes, and a relative `dir` is
resolved once against the working directory (`path.resolve`) and that
absolute path is used by every git call and in the output. Without `dir`
the destination is `<mkdtemp(tmpdir/roast-checkout-)>/<run-id>`.

`npx roast runs prune [--older-than <duration>] [--dry-run]` lists refs
under `refs/roast/snapshots/` with their committer dates, deletes (or with
`--dry-run` lists) those at least `--older-than` old (default `720h`;
zero or negative falls back to 30 days), and prints `deleted <ref> (age
<age>)` / `would delete ...` lines with the age rounded to the hour as a
Go duration. Refs of unknown age are never deleted. Prune never touches
`.roast/runs/` and never runs `git gc`.

Usage errors (wrong positional counts, unknown run, uncaptured snapshot,
outside a repository, bad `--older-than`) exit 2; restore and prune
failures exit 4. Duration parsing and formatting come from `gocompat`.

## Acceptance criteria

Module seam (temp Git repositories, "messy repo" fixture):

- [x] Round trip: after capture and restore into a new directory,
  `git diff --cached HEAD` and `git diff HEAD` are byte-identical to the
  source, `git status --porcelain` matches except the denylisted file,
  untracked content is identical, the exec bit survives, and the symlink
  is still a symlink.
- [x] `load` of a missing ref fails; `load` returns head and base from
  the commit's parents and an empty `excluded`.
- [x] Restore with `GIT_INDEX_FILE` set to a bogus path in the
  environment succeeds and the new worktree uses its own index.
- [x] A restore that fails after `worktree add` leaves no registered
  worktree (`git worktree list` shows only the main one).
- [x] Prune with a fresh snapshot and a ref backdated 60 days: a 30-day
  dry run reports exactly the old ref with `deleted: false` and the ref
  still exists; a real run deletes it and the fresh one still loads.
- [x] A ref exactly at the threshold is pruned; a ref pointing at a
  non-commit is skipped.

CLI seam (`run(argv, io)`, approved config, fake `chat` server):

- [x] After a review, `runs checkout <id> <dest>` exits 0, stdout is
  exactly the absolute destination plus `\n`, and `dest` holds the
  reviewed file content; tests remove it with `git worktree remove
  --force`.
- [x] A relative `dest` given from a repository subdirectory lands under
  that subdirectory.
- [x] `runs checkout <unique-prefix>` resolves the run.
- [x] `runs checkout` with 0 or 3 positionals exits 2.
- [x] `runs checkout` of a run recorded with `review.snapshot: false`
  exits 2.
- [x] `runs checkout` of an unknown or ambiguous run ID exits 2.
- [x] `runs prune --dry-run` in a repository with no refs exits 0 with
  nothing on stdout.
- [x] `runs prune --dry-run --older-than 1ns` after a review prints one
  `would delete` line naming the run's ref and leaves the ref in place;
  without `--dry-run` the ref is gone and the run directory remains.
  (`0s` would fall back to 30 days and select nothing.)
- [x] `runs prune --older-than bogus` exits 2; `runs prune` outside a
  Git repository exits 2; a positional argument exits 2.

- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
