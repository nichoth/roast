# 22: Snapshots taken during review

**Blocked by:** 20
**Touches:** `src/snapshot/snapshot.ts` (`REF_PREFIX`,
`DEFAULT_REF_RETENTION_MS`, `Pin`, `Snapshot`, `CaptureOptions`,
`liveIndexPath`, `pinWorktree`, `capture`, `deleteSnapshot`, `headOid`,
`revOid`, `treeOid`), `src/snapshot/meta.ts` (`SnapshotMeta`) or the
existing `src/cli/snapshot-meta.ts` (`captureSnapshot`, enabled branch),
`src/cli/review.ts` (steps 10 and 15), `test/snapshot/*.ts`,
`test/cli/review-snapshot.ts`
**Spec:** `spec/11-snapshot.md` Constants, Git invocation rules, Live
index resolution, Pin the worktree, Capture, Delete, Helper lookups, When
a review takes snapshots, `snapshot` block in `meta.json`, Test plan items
2, 3, 5-8, 10-12, 16-18; `spec/01-cli.md` 2.8 step 10 and 15, 2.13
**Status:** done

## What to build

Every review now pins exactly what it read. Before inference, a non-staged
review writes the working tree (tracked plus untracked, non-ignored,
non-denylisted files) into one unreferenced tree object with a private
index copy, and every reader (grounding, `read_file`, `list_files`,
`grep_repo`, file context, verifier snippets) uses that pinned tree. If
the pin fails, the review logs the documented note and reads live with the
`.git`, ignored, and denylisted paths blocked (the fallback ticket 20
already uses).

When `review.snapshot` is absent or `true`, the review then captures a
replayable snapshot: index tree (the staged pin's OID for `--staged`,
otherwise a copy of the live index), worktree tree (reusing the pin),
a composite tree with `index/` and `worktree/`, a commit `roast run
<run-id>` with HEAD (and a differing base) as parents and Roast's own
identity, and the ref `refs/roast/snapshots/<run-id>`. The `meta.json`
`snapshot` block, `diff_pair`, `base_tree`, `excluded_paths`, and caveats
are filled per 2.13. Capture failure never aborts the review; it records
`captured:false` with the reason. A captured ref is deleted on every exit
before the run record is initialized and kept on every exit after.

The live index is never written; `GIT_INDEX_FILE` in the environment is
honored as the live index (relative values resolved against the
toplevel). The secret denylist module (`denylisted`,
`denylistedUntracked`) already exists from ticket 10; import it.
`goPathMatch` comes from `gocompat` (ticket 03). Git calls use the shared
runner from ticket 03 with per-call env layered over the inherited env
and no output cap.

This replaces ticket 20's placeholder capture function and its live-tree
reads for non-staged reviews.

Out of scope: `load`, `restore`, `removeWorktree`, `prune`, and the
`runs checkout` / `runs prune` commands (ticket 24).

## Acceptance criteria

Module seam (`src/snapshot/` against real temp Git repositories with a
fixed author identity and the "messy repo" fixture from the test plan):

- [x] Capture leaves `git status --porcelain` of the source unchanged and
  the live index file byte-identical.
- [x] The worktree tree omits a `.gitignore`d secret and an untracked
  `deploy.pem`, includes an untracked `untracked.go`, and `excluded` is
  `["deploy.pem"]`; `deploy.pem` stays on disk.
- [x] An untracked file literally named `*.key` is excluded while
  `keep.go` is captured.
- [x] Capture on an unmerged live index fails and writes no ref.
- [x] Capture with no HEAD fails and writes no ref.
- [x] The snapshot commit's first parent is HEAD and its second parent
  is the base only when the base differs from HEAD.
- [x] Snapshot objects survive `git gc --prune=now`.
- [x] With `GIT_INDEX_FILE` pointing at an alternate index, the captured
  index tree reflects the alternate, not `.git/index`.
- [x] A pin and a capture given that pin record the same worktree tree.
- [x] `pinWorktree` works without HEAD and with an unmerged live index,
  leaving the live index untouched.
- [x] Capture succeeds with no `user.email` configured and the commit's
  author and committer are `roast <roast@localhost>`.

CLI seam (`run(argv, io)` in a temp repo, approved config, fake `chat`
server):

- [x] With the default config, `meta.json` records `snapshot.captured:
  true`, a `ref` under `refs/roast/snapshots/<run-id>`, `commit`,
  `index_tree`, `worktree_tree`, `head`, `diff_pair`, `file_modes`, and
  the ref exists in the repository.
- [x] `diff_pair` is `head..index` for `--staged`, `head..worktree` with
  no base, and `base..worktree` with `--base`.
- [x] An untracked denylisted file produces `excluded_paths` and the
  excluded-count caveat in `meta.json` `caveats`.
- [x] `ROAST_SNAPSHOT=0` in the environment does not disable capture.
- [x] With no HEAD, or with `review.snapshot: false`, the review still
  reads one pinned tree: a file edited on disk after the pin (via a tool
  call the fake scripts) is served from the pinned content.
- [x] A review that fails with a usage error after capture (invalid
  `--mode`, prompt over `limits.max_prompt_bytes`) leaves no
  `refs/roast/snapshots/` ref.
- [x] A review whose finder fails after run-record initialization keeps
  its snapshot ref.
- [x] `meta.json` `scope.head_oid` / `scope.base_oid` fall back to the
  snapshot's `head` / `base` when the scope did not pin them.

- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
