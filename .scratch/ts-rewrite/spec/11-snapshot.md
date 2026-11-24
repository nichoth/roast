# Area 11: Review snapshots, `runs checkout`, `runs prune`

## Purpose

A review snapshot pins exactly what one review read, as ordinary Git
objects in the reviewed repository's own object store, so a run record can
later be replayed or inspected against the same bytes. It captures the
index (what was staged) and the worktree (tracked files plus untracked,
non-ignored files, including uncommitted edits and deletions) as two tree
objects, joins them in one composite tree, anchors that tree with a commit,
and points a private ref at the commit:

```
refs/roast/snapshots/<run-id>  ->  commit "roast run <run-id>"
                                     parents: HEAD [, base]
                                     tree:
                                       index/     (index tree)
                                       worktree/  (worktree tree)
```

The live index and the user's working tree are never written. Three things
are deliberately not captured: `.gitignore`d files (`git add -A` skips them,
matching Roast's own scope rules), empty directories (Git cannot represent
them), and untracked, non-ignored files whose names match the secret
denylist (recorded in the run record as `excluded_paths`).

The same package provides the "pin": the worktree half alone, written as an
unreferenced tree object before inference starts, so every reader in a
review (grounding, `read_file`, verifier context) sees one immutable tree
even when no replayable snapshot can be recorded. The secret denylist is
also owned here and consumed by the scope and context areas.

Two `runs` subcommands operate on snapshots:

- `npx roast runs checkout <run-id> [dir]` materializes a run's snapshot
  into a detached linked worktree whose `git status`, `git diff HEAD`, and
  `git diff --cached HEAD` reproduce the original state.
- `npx roast runs prune` deletes aged refs under `refs/roast/snapshots/`.

Run record layout and `meta.json` as a whole belong to the records area;
this file specifies only the `snapshot` block and how it is filled.

## Behavior contract

### Constants

- `REF_PREFIX = "refs/roast/snapshots/"`. Prune only ever deletes refs under
  this prefix.
- Default ref retention: 30 days (`720h`). Tighter than any artifact
  retention because the refs live in the user's repository.
- Snapshot commit identity (environment added to `commit-tree` only):
  `GIT_AUTHOR_NAME=roast`, `GIT_AUTHOR_EMAIL=roast@localhost`,
  `GIT_COMMITTER_NAME=roast`, `GIT_COMMITTER_EMAIL=roast@localhost`.
  Capture must not fail on a machine with no `user.email` and must not
  attribute Roast's object to the user. Dates are not overridden (an
  inherited `GIT_COMMITTER_DATE` would apply).
- Commit message: `roast run <run-id>`.
- `file_modes` string recorded in `meta.json`, verbatim:
  `regular and executable files plus symlinks; empty directories are not
  represented` (one line, single space where wrapped here).
- Temp directory prefixes (under `os.tmpdir()`): `roast-snapshot-`
  (capture), `roast-pin-` (pin), `roast-checkout-` (checkout default
  destination).

### Secret denylist

Default patterns, in this order:

```
.env*  *.pem  *_rsa  *.key  creds*
id_rsa*  id_dsa*  id_ecdsa*  id_ed25519*  id_xmss*
credentials.json  .npmrc  .pypirc  .netrc  _netrc  .pgpass
.git-credentials  *.p12  *.pfx
```

`denylisted(path)`:

1. Lower-case the path and every pattern (case-insensitive file systems
   open `.ENV` as `.env`).
2. A path matches if any pattern matches either its basename or the full
   repo-relative path (`/`-separated), using Go `filepath.Match`
   semantics: `*` matches any run of characters except `/` (a leading dot
   is not special), `?` matches one character except `/`, `[...]` is a
   character class (`^` negates, ranges `a-z`), `\` escapes the next
   character. A malformed pattern never matches (the error is swallowed).

SSH keys are matched by key-type prefix so suffixed names
(`id_ed25519_github`, `id_rsa_work`, `.pub` files) are covered; there is no
bare `id_*` (it would drop `id_map.go`).

`denylistedUntracked(repo, patterns?)` returns the untracked, non-ignored
paths matching the denylist, sorted by byte order:

- `patterns` omitted (Go `nil`) means the default list. An explicitly empty
  list disables filtering and returns `[]` without running Git. No CLI path
  passes a custom list; it exists for tests.
- Runs `git -C <repo> ls-files --others --exclude-standard -z`, splits on
  NUL, drops empty entries, keeps matches.
- Tracked files are never denylisted here: their content is already in the
  repository's history.

### Git invocation rules

Every Git call is `git -C <dir> <args...>` via `execFile`:

- The child inherits the full process environment; per-call extra
  variables are layered on top (so a per-call `GIT_INDEX_FILE` wins over an
  inherited one). Calls without extras inherit `GIT_INDEX_FILE` unchanged,
  except that restore calls clear it (see Restore, deliberate change 12).
- The result is stdout with leading and trailing whitespace trimmed.
- On a non-zero exit the error carries the exit status and, when present,
  trimmed stderr (`<status>: <stderr>`); Git puts every useful message on
  stderr.
- Output can be large (`ls-files --others` on a big tree): the runner must
  not truncate at Node's default `maxBuffer`.

### Live index resolution

The index a review reads, and therefore the one a snapshot copies:

1. If `GIT_INDEX_FILE` is set in the process environment: that path; a
   relative value is resolved against the repository toplevel (`repo`).
   Under the native pre-commit gate Git points it at the temporary index
   holding exactly the commit's content, which is what `--staged` reviews.
2. Otherwise `<absolute-git-dir>/index`, where the Git dir comes from
   `git -C <repo> rev-parse --absolute-git-dir` (per-worktree Git dir for a
   linked worktree).

Copying the index: copy the file byte for byte to the destination, created
with mode `0600` (truncating). A missing source index is not an error and
nothing is written (Git treats an absent `GIT_INDEX_FILE` as an empty
index). Any other read error is `read <src>: <err>`.

### Pin the worktree (`pinWorktree(repo, denylist?)`)

Writes the working tree, as a review sees it, into one tree object. Needs
no HEAD, writes no ref and no commit, never writes the live index. The
written objects are unreferenced (collectable by `git gc`) until a capture
anchors them.

1. `git -C <repo> rev-parse --absolute-git-dir`; failure ->
   `resolve git dir: <err>`.
2. Make a temp dir `roast-pin-*`; always removed on exit (success or
   failure).
3. Copy the live index to `<tmp>/worktree`.
4. `excluded = denylistedUntracked(repo, denylist)`.
5. With `GIT_INDEX_FILE=<tmp>/worktree`:
   `git -C <repo> add -A -- . :(exclude,literal)<p1> :(exclude,literal)<p2>
   ...` (one exclude per excluded path, in sorted order). The positive `.`
   pathspec is required (an exclude-only pathspec matches nothing and
   errors). `literal` stops metacharacters in a filename (for example a
   file literally named `*.key`) from widening the exclusion. Failure ->
   `git add -A (snapshot index): <err>`.
6. With the same `GIT_INDEX_FILE`: `git -C <repo> write-tree`; failure ->
   `write-tree (worktree): <err>`.
7. Return `{tree, excluded}`.

Because `add -A` runs on a private copy, an unmerged (conflicted) live
index is resolved in the copy rather than refused, and the live index is
untouched.

### Capture (`capture(repo, opts)`)

Options: `runId` (names the ref), `headOid`, `baseOid`, `denylist?`,
`indexTree?` (an index tree already pinned by the caller), `worktree?` (a
pin already taken by the caller). Returns the snapshot identity or throws;
it never returns a partial snapshot.

1. Empty `runId` -> error `snapshot: empty run id`.
2. Empty `headOid` -> error `repository has no commits; an unborn HEAD
   cannot be restored, so no replayable snapshot is possible`. (Restore
   detaches at the original HEAD; without one the only commit-ish is the
   synthetic composite, a baseline that never existed.)
3. `git -C <repo> rev-parse --absolute-git-dir`; failure ->
   `resolve git dir: <err>`.
4. Make temp dir `roast-snapshot-*`; always removed on exit.
5. Index tree: if `opts.indexTree` is non-empty use it verbatim. Otherwise
   copy the live index to `<tmp>/index` and run `git -C <repo> write-tree`
   with `GIT_INDEX_FILE=<tmp>/index`; failure ->
   `write-tree (index): <err>`. An unmerged index makes `write-tree`
   refuse, so capture fails.
6. Worktree tree: if `opts.worktree.tree` is non-empty use that pin
   verbatim (tree and excluded list). Otherwise run steps 3-7 of the pin
   inside this temp dir (copy to `<tmp>/worktree`, denylist, `add -A`,
   `write-tree`). Reusing caller pins is what guarantees the recorded tree
   is the reviewed tree.
7. Composite tree: `git -C <repo> mktree` with stdin exactly
   `040000 tree <indexTree>\tindex\n040000 tree <worktreeTree>\tworktree\n`;
   failure -> `mktree: <err>`.
8. Commit: `git -C <repo> commit-tree <composite> -p <headOid>
   [-p <baseOid>] -m "roast run <runId>"` with the identity environment.
   The second parent is added only when `baseOid` is non-empty and differs
   from `headOid`. Parents keep HEAD and the branch base reachable even
   after a rebase or branch delete. Failure -> `commit-tree: <err>`.
9. `git -C <repo> update-ref refs/roast/snapshots/<runId> <commit>` (no
   old-value check; an existing ref is overwritten). Failure ->
   `update-ref <ref>: <err>` (for example a read-only `.git`).
10. Return `{ref, commit, indexTree, worktreeTree, head:headOid,
    base:baseOid, excluded}`.

The ref keeps every snapshot object reachable through `git gc --prune=now`.

### Load (`load(repo, runId)`)

The snapshot is self-describing; nothing else is read.

1. `git -C <repo> rev-parse --verify --quiet <ref>^{commit}`; a failure or
   empty output -> `no snapshot ref <ref> in <repo> (run predates
   snapshots, was pruned, or lives in another clone)`.
2. `rev-parse --verify --quiet <ref>:index`; failure ->
   `snapshot <ref> has no index/ tree: <err>`.
3. `rev-parse --verify --quiet <ref>:worktree`; failure ->
   `snapshot <ref> has no worktree/ tree: <err>`.
4. `rev-parse --verify --quiet <ref>^1` -> head, `<ref>^2` -> base; each
   is best-effort (`""` on failure).
5. `excluded` is not recoverable from the ref and is empty.

### Delete (`deleteSnapshot(repo, runId)`)

Empty `runId` -> `delete snapshot: empty run id`. Otherwise
`git -C <repo> update-ref -d refs/roast/snapshots/<runId>`; failure ->
`delete <ref>: <err>`. Used by the review to avoid leaking an orphan ref
when the run record cannot be initialized.

### Restore (`restore(repo, runId, dir)`)

0. Clear `GIT_INDEX_FILE`: every git call in restore (`worktree add`,
   `read-tree`, `checkout-index`, and `removeWorktree`) runs with that
   variable removed from the child environment, so an inherited index
   (for example inside a hook) never replaces the new worktree's own.
   Deliberate change 12.
1. `load(repo, runId)`; its error propagates.
2. Empty head -> `snapshot <ref> records no HEAD commit; it cannot be
   restored to a meaningful baseline` (only a hand-made ref can hit this).
3. `git -C <repo> worktree add --detach --no-checkout <abs> <head>`,
   where `<abs>` is `dir` resolved against the process working directory
   once, before any git call (`path.resolve`); every later call in this
   function uses `<abs>` too. A relative `dir` therefore means the same
   place for `worktree add`, `read-tree`, and `checkout-index`, from any
   subdirectory (deliberate change 12);
   failure -> `git worktree add: <err>`. Git refuses a `dir` that exists
   and is non-empty; Roast does no check of its own.
4. In the new worktree (`git -C <abs> ...`):
   1. `read-tree <worktreeTree>`; failure -> `read-tree (worktree): <err>`.
   2. `checkout-index -a -f`; failure -> `checkout-index: <err>`. Disk now
      holds the worktree tree (contents, exec bit, symlinks).
   3. `read-tree <indexTree>`; failure -> `read-tree (index): <err>`. The
      index reverts to what was staged while disk is untouched, so paths on
      disk but absent from the index show as untracked, deleted files show
      as deleted, and staged versus unstaged edits are distinguished as
      they were.
   On any failure in step 4, call `removeWorktree(repo, abs)` (result
   ignored) before rethrowing, so no half-built worktree is left
   registered.
5. Return the loaded identity.

The restored status equals the original except for denylisted files,
ignored files, and empty directories.

Submodules (gitlinks) in a snapshot are unsupported and documented as
such: a gitlink entry is not restored as a populated submodule, and no
behavior is specified or tested for it.

### Remove worktree (`removeWorktree(repo, dir)`)

`git -C <repo> worktree remove --force <dir>`. If that fails, remove `dir`
recursively (errors ignored) and run `git -C <repo> worktree prune`; only
if the prune also fails, return `worktree remove <dir>: <remove err>`.

### Prune (`prune(repo, olderThanMs, dryRun)`)

1. `olderThan <= 0` -> use the default retention (30 days).
2. `git -C <repo> for-each-ref
   --format=%(refname)%09%(committerdate:unix) refs/roast/snapshots/`;
   failure -> `for-each-ref refs/roast/snapshots/: <err>`.
3. Process lines in Git's output order (sorted by refname). Skip a line
   that is blank, has no tab, whose name lacks the prefix, or whose
   timestamp (trimmed) is not a base-10 integer (for example a ref pointing
   at a non-commit, whose committer date is empty). Refs of unknown age are
   never deleted.
4. `age = now - timestamp`. Skip when `age < olderThan` (a ref exactly at
   the threshold is pruned).
5. Otherwise, unless `dryRun`, run `git -C <repo> update-ref -d <ref>`; on
   failure stop immediately and throw `delete <ref>: <err>` (refs already
   deleted stay deleted). Each considered ref yields
   `{ref, runId:<ref minus prefix>, ageMs, deleted}`.

Prune touches only refs. It never removes run records under
`.roast/runs/` and never runs `git gc`; the unreferenced objects become
collectable by Git's own gc.

### Helper lookups

- `headOid(repo)` = `revOid(repo, "HEAD")`.
- `revOid(repo, rev)`: `git -C <repo> rev-parse --verify --quiet
  <rev>^{commit}`, `""` on failure.
- `treeOid(repo, rev)`: same with `<rev>^{tree}`, `""` on failure.

### When a review takes snapshots

Config: `review.snapshot` in `.roast.json`, an optional boolean. Absent or
`true` means capture; `false` disables capture. There is no environment
variable or flag (a `ROAST_SNAPSHOT` variable from older versions has no
effect). The `init` starter shows it commented out as `"snapshot": true`
inside the `review` block. Schema description: `Record a Git snapshot of
each review for replay. Default true.`

Sequence inside `review`, after trust and config loading:

1. With `--staged`, the context area pins the index tree first
   (`PinIndexTree`, same live-index rule and copy-then-`write-tree`); its
   OID is passed to capture as `indexTree`. Without `--staged`,
   `indexTree` is empty and capture copies the index itself.
2. Scope is built. An empty scope produces the no-diff report and returns:
   no run id, no pin, no snapshot.
3. A run id is minted (records area, `<YYYYMMDDTHHMMSSZ>-<8 hex>`); the
   snapshot ref uses the same id.
4. If the scope is not staged, `pinWorktree(repo)` runs regardless of the
   setting. On failure the review logs to stderr `roast: could not pin the
   working tree (<err>); reading it live with .git, ignored, and
   denylisted paths blocked` and continues with an empty pin; on success
   the pinned tree becomes the tree every reader uses. A staged scope takes
   no pin here (capture computes the worktree half itself).
5. Snapshot capture (`captureSnapshot`), producing the `snapshot` block and
   caveat strings:
   - Disabled: `{captured:false, reason:"disabled by review.snapshot"}`,
     caveat `Git snapshot capture was disabled; this run cannot be
     replayed.` No Git commands, no ref.
   - `head` = scope's head OID if set, else `headOid(repo)`.
   - `base` = scope's base OID if set, else `revOid(repo, scope.base)` when
     the scope has a base rev name, else `""`.
   - `capture(repo, {runId, headOid:head, baseOid:base, indexTree,
     worktree:pin})`.
   - Capture error: `{captured:false, reason:<err message>, head, base}`
     (head/base omitted when empty), caveat `Git snapshot capture failed:
     <err message>`. The review continues; capture failure never aborts it.
   - Success: `diff_pair` is `head..index` for a staged scope, else `head`
     for a survey (repo) scope, else `head..worktree` when the scope has no
     base, else `base..worktree`. `base_tree` = `treeOid(repo, source)`
     where source is `head` for the three `head*` pairs and `base` for
     `base..worktree`; omitted when the source or the lookup is empty.
     Caveat `snapshot excluded <N> denylisted untracked path(s)` when the
     excluded list is non-empty.
6. If captured, the ref is deleted (`deleteSnapshot`, errors ignored) on
   every exit path until the run record is initialized (`meta.json` plus
   the initial artifacts written). Any usage error in between (invalid
   `--mode`, prompt over the byte ceiling, a failed record write) therefore
   leaves no orphan ref. After initialization the ref is durable, even if
   inference later fails or is cancelled.
7. `meta.json` `scope.base_oid` / `scope.head_oid` fall back to the
   snapshot block's `base` / `head` when the scope did not pin them.
8. The caveats go into `meta.json` `caveats`.

### `snapshot` block in `meta.json`

Key order as written by Go; every key except `captured` is omitted when
empty:

```json
{
  "captured": true,
  "reason": "...",
  "ref": "refs/roast/snapshots/<run-id>",
  "commit": "<oid>",
  "index_tree": "<oid>",
  "worktree_tree": "<oid>",
  "base_tree": "<oid>",
  "head": "<oid>",
  "base": "<oid>",
  "diff_pair": "head..index|head|head..worktree|base..worktree",
  "file_modes": "regular and executable files plus symlinks; ...",
  "excluded_paths": ["deploy.pem"]
}
```

`reason` appears only when `captured` is false. Snapshot objects are never
copied into the run directory or the run bundle; they live in the
repository's object store.

### `npx roast runs checkout <run-id> [dir]`

- Arguments: 1 or 2 positionals; any other count is a usage error (exit 2).
  No flags.
- Reads the run's `meta.json` through the records area (`readMeta`), which
  resolves `<run-id>` as a unique prefix of a run directory name under the
  current Git toplevel's `.roast/runs/`. Any failure (invalid id, outside a
  repository, no match, ambiguous prefix, missing or unparsable
  `meta.json`) is a usage error, exit 2, with the records-area message.
- `snapshot.captured` false -> usage error, exit 2:
  `run <run-id> has no Git snapshot (<reason>)`, where `<run-id>` is the
  full id from `meta.json` and `<reason>` may be empty.
- Destination: `dir` if given, resolved against the working directory
  once (`path.resolve`) and that absolute path is used by every git call
  and in the printed output (deliberate change 12); otherwise
  `<mkdtemp(os.tmpdir()/roast-checkout-)>/<run-id>`. The temp
  parent is never cleaned up by Roast. A `mkdtemp` failure is a non-usage
  error (exit 4).
- `restore(meta.repo, meta.run_id, dest)`, using the repository path
  recorded in `meta.json`, not the current directory. Failure -> exit 4,
  message `restore run <run-id>: <err>`.
- On success: stderr `roast: remove with: git -C <repo> worktree remove
  --force <dest>` and stdout `<dest>\n`; exit 0. Stdout carries only the
  path, so `cd "$(npx roast runs checkout <id>)"` works.

Errors print as `roast: <message>` on stderr (or the JSON error shape when
`--error-format json` applies; CLI area), with exit codes from the shared
mapping: usage error -> 2, any other error -> 4.

### `npx roast runs prune [--older-than <duration>] [--dry-run]`

- No positionals (any -> usage error, exit 2).
- `--older-than`: Go duration (`720h`, `1h30m`, `90s`, negative allowed),
  default `720h0m0s` (30 days). An unparsable value is a flag error, exit
  2. Zero or negative falls back to 30 days inside prune.
- `--dry-run`: boolean, default false; lists without deleting.
- Repository: the toplevel of the current directory
  (`git rev-parse --show-toplevel`); outside a repository -> usage error
  `not inside a git repository`, exit 2. Refs are shared by every linked
  worktree of the clone.
- Prune error (listing or a delete failing) -> exit 4; nothing is printed
  to stdout, even for refs deleted before the failure.
- No refs selected -> stderr `roast: no snapshot refs older than <d>`,
  where `<d>` is the flag value formatted as a Go duration (the default
  prints `720h0m0s`; an explicit `0` prints `0s` although 30 days was
  applied). This is kept as Go parity. Exit 0.
- Otherwise one stdout line per ref, in for-each-ref order:
  `deleted <ref> (age <age>)`, or `would delete <ref> (age <age>)` with
  `--dry-run`. `<age>` is the age rounded to the nearest hour (half away
  from zero) and formatted as a Go duration, so it is always `<N>h0m0s`, or
  `0s` when it rounds to zero. Exit 0.

Go duration formatting needed here (shared duration helper): zero is `0s`;
a whole number of hours `N > 0` is `<N>h0m0s`; the general form is
`[-][<h>h][<m>m]<s>[.<frac>]s` with hours and minutes present once a larger
unit is.

## TypeScript module design

`src/snapshot/`:

- `denylist.ts`
  - `export const DEFAULT_DENYLIST:readonly string[]`
  - `export function goPathMatch(pattern:string, name:string):boolean`
    (Go `filepath.Match` port; malformed pattern -> `false`)
  - `export function denylisted(path:string,
    patterns?:readonly string[]):boolean`
  - `export async function denylistedUntracked(repo:string,
    opts?:{patterns?:readonly string[], signal?:AbortSignal})
    :Promise<string[]>`
- `snapshot.ts`
  - `export const REF_PREFIX = 'refs/roast/snapshots/'`
  - `export const DEFAULT_REF_RETENTION_MS = 30 * 24 * 3600 * 1000`
  - `export interface Pin { tree:string; excluded:string[] }`
  - `export interface Snapshot { ref:string; commit:string;
    indexTree:string; worktreeTree:string; head:string; base:string;
    excluded:string[] }`
  - `export interface CaptureOptions { runId:string; headOid:string;
    baseOid:string; denylist?:readonly string[]; indexTree?:string;
    worktree?:Pin; signal?:AbortSignal }`
  - `export function liveIndexPath(repo:string, gitDir:string,
    env:NodeJS.ProcessEnv):string`
  - `export async function pinWorktree(repo:string,
    opts?:{denylist?:readonly string[], signal?:AbortSignal}):Promise<Pin>`
  - `export async function capture(repo:string,
    opts:CaptureOptions):Promise<Snapshot>`
  - `export async function load(repo:string, runId:string,
    signal?:AbortSignal):Promise<Snapshot>`
  - `export async function deleteSnapshot(repo:string,
    runId:string):Promise<void>`
  - `export async function restore(repo:string, runId:string,
    dir:string, signal?:AbortSignal):Promise<Snapshot>`
  - `export async function removeWorktree(repo:string,
    dir:string):Promise<void>`
  - `export interface Pruned { ref:string; runId:string; ageMs:number;
    deleted:boolean }`
  - `export async function prune(repo:string, olderThanMs:number,
    dryRun:boolean, now?:() => number):Promise<Pruned[]>`
  - `export async function headOid(repo:string):Promise<string>`,
    `revOid(repo, rev)`, `treeOid(repo, rev)`
- `meta.ts` (pure, no I/O besides the injected lookups)
  - `export interface SnapshotMeta` matching the JSON block above, with
    optional fields left `undefined` so `JSON.stringify` omits them; key
    insertion order follows the JSON block.
  - `export async function captureSnapshot(input:{enabled:boolean;
    repo:string; runId:string; scope:ScopeLike; indexTree:string;
    pin:Pin|null}):Promise<{meta:SnapshotMeta; caveats:string[]}>`

`src/cli/runs.ts` adds `checkout` and `prune` subcommands (the `runs` list
and `show` belong to the records/CLI areas).

Dependencies:

- Shared Git runner (scope area): `git(dir, args, {env?, input?, signal?})`
  returning trimmed stdout and throwing an error with status plus trimmed
  stderr; inherits `process.env`, merges extras; unbounded output.
- Records area: `readMeta(prefix)`, run id, `meta.json` writing.
- Scope area: `gitRoot(start)` for prune; `Scope` fields `headOid`,
  `baseOid`, `base`, `staged`, `survey`; scope and context areas import
  `denylisted` / `denylistedUntracked` from here.
- Context area: `pinIndexTree` (staged index pin), pinned-tree readers.
- Config area: `review.snapshot` (absent means `true`).
- CLI area: usage error type, exit code mapping, Go duration parse/format
  helpers, `textsafe`-sanitized error printing.
- Temp directories: `fs.mkdtemp(path.join(os.tmpdir(), prefix))`, removed
  with `fs.rm(dir, {recursive:true, force:true})` in `finally`.
- Debug tracing: namespace `roast:snapshot` (Git subcommand names and
  refs only; no file contents).

## Deliberate changes

- Debug tracing via `@substrate-system/debug` under `roast:snapshot`
  (decision 5).
- Windows is unsupported (decision 2), so path handling assumes `/`.
- Relative `runs checkout` directory is resolved against the working
  directory once, used by every git call (spec.md change 12).
- `restore` clears an inherited `GIT_INDEX_FILE` (spec.md change 12).
- Otherwise none: ref names, Git commands, `meta.json` fields, command
  output, and exit codes match Go.

## Test plan

Lower seam (`src/snapshot/` against real temp Git repositories; each test
creates its own repo with a fixed author identity). A shared "messy repo"
fixture holds: a clean committed file, a staged modification, an unstaged
modification, an unstaged deletion, an untracked file, an untracked file
with the exec bit, an untracked symlink, a `.gitignore`d secret, and an
untracked `deploy.pem`.

1. Round trip fidelity: capture leaves `git status --porcelain` of the
   source unchanged; after restore, `git diff --cached HEAD` and
   `git diff HEAD` are byte-identical to the original, status matches
   except the denylisted file, untracked content is identical, the exec bit
   survives, the symlink is still a symlink; `excluded` is `[deploy.pem]`
   (TestRoundTrip).
2. Secret hygiene: the worktree tree omits the ignored secret and
   `deploy.pem`, includes `untracked.go`; `deploy.pem` stays on disk
   (TestSecretHygiene).
3. Literal pathspec: an untracked file literally named `*.key` is excluded
   while `keep.go` is captured (TestDenylistLiteralPathspec).
4. Denylist matching: listed credential names match, including nested,
   upper-case, and suffixed SSH key names; `main.go`, `credentials.go`,
   `npmrc.go`, `README.md`, `id_map.go`, `internal/id_test.go`,
   `identity.go` do not (TestDenylistCoversCredentialFiles). Pure unit
   test; also cover `goPathMatch` for `*`, `?`, classes, escapes.
5. Capture fails (no ref written) on an unmerged index
   (TestCaptureUnmergedIndexFails).
6. Capture refuses an unborn HEAD (TestCaptureRefusesUnbornHead).
7. Parents: first parent is HEAD, second is the base when it differs
   (TestCaptureRecordsParents).
8. Snapshot objects survive `git gc --prune=now` (TestSurvivesGC).
9. Prune: with a fresh snapshot and a ref backdated 60 days (commit-tree
   with old `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`), a 30-day dry run
   reports exactly the old ref, not deleted, and it still exists; a real
   run deletes it and the fresh one still loads (TestPrune).
10. `GIT_INDEX_FILE` honored: with the live index staging `a.txt` and an
    alternate index staging only `b.txt`, the captured index tree reflects
    the alternate (TestCaptureHonorsGitIndexFile).
11. Pin reuse: a pin and the capture given that pin record the same tree
    (TestPinWorktreeMatchesCapture).
12. Pin works without HEAD (TestPinWorktreeWithoutHead) and with an
    unmerged live index, leaving the live index untouched
    (TestPinWorktreeUnmergedIndex).

CLI seam (`run(argv, io)` in a temp repo with an approved config and the
fake inference server):

13. `runs checkout` with 0 or 3 positionals exits 2
    (TestCommandUsageErrorsExitWithUsageCode).
14. `runs prune --dry-run` in a repository exits 0
    (TestRunsLocalSubcommandsStillWork).
15. After a review, `runs checkout <id> <dest>` exits 0 and materializes
    the reviewed file in `dest`; clean up with `git worktree remove
    --force` (TestFinderVerifierPipelineWithMockEndpoint). Also: a
    relative `dest` run from a subdirectory of the repository succeeds and
    lands under that subdirectory; with `GIT_INDEX_FILE` set to a bogus
    path in the environment, restore still succeeds and the new
    worktree's index is its own.
16. Default config records `snapshot.captured: true` and a ref under
    `refs/roast/snapshots/`; `review.snapshot: false` records
    `captured: false` and writes no refs
    (TestReviewSnapshotSettingInProjectConfig).
17. With no HEAD, or with `review.snapshot: false`, the review still reads
    one pinned tree rather than the live worktree
    (TestReviewPinsCorpusWithoutSnapshot).
18. `ROAST_SNAPSHOT=0` in the environment does not disable capture
    (TestRemovedEnvironmentVariablesHaveNoEffect).

New tests worth adding (behavior the Go code implements but tests do not
pin): checkout of a run whose snapshot was not captured exits 2; prune
output lines on stdout and the empty-result message exit 0; a review that
fails with a usage error after capture (for example invalid `--mode`)
leaves no ref.

## Go baseline references

At commit `cd08f10`:

- `internal/snapshot/snapshot.go`
- `internal/snapshot/snapshot_test.go`, `internal/snapshot/pin_test.go`
- `internal/cli/runs.go` (`newRunsCheckoutCommand`,
  `newRunsPruneCommand`)
- `internal/cli/cli.go` (review sequence around `snapshot.PinWorktree`,
  `captureSnapshot`, `snapshotDurable`; `exitCode`)
- `internal/context/tree.go` (`PinIndexTree`)
- `internal/record/meta.go` (`SnapshotMeta`, `ReadMeta`, `RunDir`)
- `internal/config/config.go` (`Review.Snapshot`, `SnapshotEnabled`),
  `internal/config/starter.go`, `roast.schema.json`
- `internal/cli/cli_test.go`, `internal/cli/settings_test.go`,
  `internal/cli/hardening_test.go`

## Resolved

Resolved (maintainer decisions, see spec.md):

1. A relative `runs checkout` dir is resolved against the working
   directory once and used by every git call (spec.md change 12).
2. `runs checkout` / restore clears an inherited `GIT_INDEX_FILE` (spec.md
   change 12).
3. Submodules (gitlinks) in snapshots are documented as unsupported
   (spec.md Out of Scope).
4. Prune's `0s` message when `--older-than` is <= 0 stays as Go parity.
