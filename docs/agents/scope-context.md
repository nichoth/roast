# Scope, context, and exploration tools (TS)

`src/scope/` (public surface in `index.ts`), `src/context/`,
`src/snapshot/`.

## Scope

- Every `git diff` argument list starts with `DIFF_CONFIG` (use
  `diffArgs(...)` in `src/scope/git.ts`); git rejects an empty
  `diff.orderFile=`, so it is `/dev/null`.
- Patch output goes through `gitPatch` (streams into a
  `SectionCapper`), never the buffered runner.
- `build` takes the git environment as `BuildOpts.env` (the CLI
  context's env).
- The secret denylist lives once in `src/snapshot/denylist.ts`; scope,
  context, and snapshot import it.
- Repo survey (`scope: "repo"`) is `src/scope/survey.ts`: it lists the
  HEAD tree with `ls-tree` and filters in process (`untrackedPasses`,
  exact-match linguist set), so the git pathspec is unused there. Every
  repository-derived string in the manifest goes through
  `manifestQuote`. The CLI survey branches live in `src/cli/review.ts`;
  CLI tests are in `test/cli/review-survey.ts`.

## Context

- Every function that runs git or reads files takes a trailing
  `ContextOpts` (`signal`, `env`); pass the CLI context's env, and the
  repo env in tests. `pinIndexTree` reads `GIT_INDEX_FILE` from that
  env, not `process.env`.
- Blocking git calls use the shared runner; streamed reads use
  `gitStream` / `gitCapped` (`src/context/git.ts`).
- Grounding and normalization work on `Buffer`s; decode to text only in
  `snippet.ts` (model-facing).
- Exploration tools (`src/context/tools.ts`): `explorationTools(repo,
  tree, {env})`; each `run(args, signal)` returns a plain object, a
  model-caused failure is `{error}`, abort rejects.
- When stopping a `gitStream` early, `await lineReader.close()` before
  awaiting `done`: a paused stdout keeps the child's `close` from
  firing.

## Snapshot

- `src/snapshot/snapshot.ts` owns `liveIndexPath` and `copyIndex`;
  `pinIndexTree` (context) uses them too. Every function takes
  `{env, signal}`; pass the CLI context's env so `GIT_INDEX_FILE` is
  read from it.
- `review.ts` keeps a `durable` flag: until the run record is
  initialized, the `finally` deletes a captured ref. Code added between
  capture and `initializeRun` stays inside that `try`.
- Non-staged reviews read the `pinWorktree` tree even with
  `review.snapshot: false`; only a pin failure falls back to the live
  tree.
- Paths from git that feed an exclusion must keep raw bytes
  (`denylistedUntrackedRaw`): `decodePaths` drops non-UTF-8 names, and
  Node argv cannot carry them, so pass such pathspecs on stdin with
  `--pathspec-from-file=- --pathspec-file-nul` (magic still applies).
- Do not use `rev-parse --end-of-options`: Git before 2.43 rejects it.
  Tests fake an old Git with `fakeGit` matching on the argument list.
- `restore` and `removeWorktree` strip `GIT_INDEX_FILE` from the env
  they are given (deliberate change 12); other functions honor it.
- `restore` copies project credentials after restoring the index. The
  copy comes from the current checkout, outside the captured trees.
- `prune` takes fractional milliseconds: `runs prune` converts the Go
  duration without truncating, so `--older-than 1ns` stays positive
  instead of falling back to 30 days.
- `runs checkout` resolves a relative `dir` against `ctx.cwd`, not
  `process.cwd()`; CLI tests chdir into the repo, so a test from a
  subdirectory passes `cwd` to `r.roast` to tell them apart.

## Tests

- Use `newRepo()` (`test/scope/helpers.ts`): a temp repo with its own
  HOME, XDG_CONFIG_HOME, and `GIT_CONFIG_GLOBAL` file
  (`repo.globalConfig`, safe to fill with hostile config), passed as
  `env:repo.env`.
- APFS refuses non-UTF-8 file names; stage such a name with
  `git update-index --index-info` to test it on macOS.
- Memory bounds: plain RSS growth reflects V8 GC timing on discarded
  pipe chunks, not what code keeps alive. `test/scope/huge.ts` forces gc
  (`v8.setFlagsFromString('--expose-gc')`, `vm.runInNewContext('gc')`)
  and bounds `heapUsed + external`.
- Abort tests put a pid-recording fake `git` first on the env's `PATH`
  (`wrapGit` in `test/context/bounds.ts`).
- Tool tests call tools through `call(repo, tree, name, args)` and fake
  git with `fakeGit` / `onArg` (`test/context/tools-helpers.ts`).
- Snapshot module tests use the "messy repo" fixture in
  `test/snapshot/snapshot.ts` (copied in `test/snapshot/restore.ts`).
  A restore failure after `worktree add` is provoked with a hand-made
  ref whose `worktree` entry is a blob. Tests that check out a worktree
  remove it with `git worktree remove --force` in `t.cleanup`. CLI snapshot tests turn capture on with
  `review:{}` (settingsRepo disables it) and read refs with
  `for-each-ref refs/roast/snapshots/`.
- `npm run test:one` pipes into tap-spec, which can crash with EPIPE on
  a failing assertion and hide the summary; rerun the bundle with
  `node test/one-bundle.js` for raw TAP.
- Captured-worktree tests build the tree with plumbing (temporary
  `GIT_INDEX_FILE`, `read-tree HEAD`, `add`, `write-tree`). `write-tree`
  or `status` on the live index rewrites it, so snapshot the index bytes
  after those calls when asserting it is unchanged.
