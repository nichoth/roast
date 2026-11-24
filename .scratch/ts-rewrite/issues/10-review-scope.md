# 10: Review scope

**Blocked by:** 03
**Touches:** `src/scope/` (`constants.ts`, `git.ts`, `patch.ts`,
`renames.ts`, `glob.ts`, `linguist.ts`, `untracked.ts`, `build.ts`,
`text.ts`); exports `build`, `isEmpty`, `fit`, `BuildOpts`, `Scope`,
`SizeEntry`, `GitError`, `gitPatch`, `SectionCapper`, `PATCH_FLAGS`,
`DIFF_CONFIG`, `SECTION_OMITTED_MARKER`; `src/snapshot/denylist.ts`
(`DEFAULT_DENYLIST`, `denylisted`, `denylistedUntracked`);
`test/scope/*.ts`, `test/snapshot/denylist.ts`, `test/index.ts`
**Spec:** `spec/04-scope.md` sections 1-3 except 2.12 / 3.5 (repo survey),
4, 5 (all groups except "Repo survey" and the survey manifest test);
`spec/11-snapshot.md` "Secret denylist"; `spec.md` deliberate changes
15, 16, 17, 18, 23, 24 and cross-cutting "Bytes and text", "Process
lifetime"
**Status:** done

## What to build

The diff review scope: given a repository and `BuildOpts`, `build()`
returns the `Scope` the finder reviews -- the patch text (`diff`) and its
exact bytes (`diffBytes`), the reviewed `files`, the resolved `base`,
`notes`, staged flags, and `headOID`. It covers the default mode
(committed changes against the base plus uncommitted and untracked
files), `--base`, `--uncommitted-only`, `--staged` (with an optional
pinned staged tree OID passed in by the caller), `--paths`, excludes
(config plus flags), `--include-vendored`, linguist generated/vendored
exclusion, rename compaction, the per-file section cap, untracked-file
synthesis, the empty-repository fallback, `fit` (whole-diff budget with
a stable, descending size breakdown), and `gitRoot`. `isEmpty` reports a
blank scope.

Also build the secret denylist module `src/snapshot/denylist.ts` here
(owned by this ticket so scope, context, and the later snapshot ticket
all import one copy): `DEFAULT_DENYLIST` in the spec's order,
`denylisted(path, patterns?)` (case-folded, basename or full path,
Go `filepath.Match` semantics), and `denylistedUntracked(repo, opts?)`.
Use `goPathMatch` from `src/gocompat/` (ticket 03); do not write a
second copy.

Seam resolutions that apply here:

- Git runs through the shared runner in `src/git/` from ticket 03
  (resolution 1). This ticket adds only `gitPatch` (streaming patch
  output through a `SectionCapper`) and any scope-specific wrappers on
  top of it in `src/scope/git.ts`; it does not define a second
  general-purpose runner. `gitRoot` is the ticket 03 helper; re-export it
  from `src/scope/` if convenient, do not reimplement it.
- `compareBytes` comes from `src/gocompat/` (ticket 03).

Byte discipline (spec 04 section 3.4): git output is read as `Buffer`,
name lists use `-z` and a fatal UTF-8 decoder (non-UTF-8 names are
skipped with a warning note), every `diff` invocation starts with
`DIFF_CONFIG` (`core.quotePath=false`, `diff.orderFile` overridden, user
diff drivers and external diff disabled), and all size rules count
bytes. Every best-effort `catch` rethrows when the signal is aborted.

Out of scope: repo survey scope (`scope: "repo"`, manifest,
`manifestQuote`) is ticket 25 -- `build` with `scope: "repo"` may throw
a not-yet-supported error until then, but `branch` and any other unknown
value must be the spec's error. Branch survey scope is not ported. The
CLI flag wiring and `meta.json` `scope` assertions land in ticket 20.

## Acceptance criteria

Tests call `build`, `fit`, and the denylist functions against real
temporary Git repositories (identity set in the child env, global config
isolated via `HOME` / `XDG_CONFIG_HOME` / `GIT_CONFIG_GLOBAL`).

- [x] Excludes filter both the diff text and `files`; untracked
  synthesis honors `--paths` and excludes; `scope` unset equals explicit
  `diff`; an unknown scope (including `branch`) is an error.
- [x] The untracked-path glob matcher passes the spec 2.14 cases (pure
  test).
- [x] A path with non-ASCII characters appears unquoted in `files` for
  tracked and untracked changes, and the untracked file is synthesized.
- [x] A file name that is not valid UTF-8 is skipped, absent from
  `files`, with a warning note, and the build succeeds (skipped where
  the filesystem refuses such names).
- [x] A move is delete+add under `--no-renames` with excludes applied to
  each side; moved files with small edits collapse to rename sections
  holding only the edited lines; a pure move has a rename header and no
  hunks; a move across an exclude boundary is not paired; a staged move
  collapses; a path starting with `R` is not misread as a status.
- [x] `fit` truncates with a descending breakdown, counts a collapsed
  move for both paths, and keeps `files` order for equal sizes.
- [x] Staged mode reads only the index (worktree-only edits absent) and
  honors an alternate `GIT_INDEX_FILE` without leaking the shared
  index's staged content.
- [x] A repository with no commits diffs against the empty tree and
  includes staged and untracked files with a note; base fallback notes
  appear when the base is not `origin/main` and when none resolves.
- [x] Two 24 MB files (one committed, one untracked) with a 64 KiB cap
  produce a diff under 4x the cap with two omission markers, a later
  small file intact, notes naming both cut files, all three in `files`,
  and peak RSS growth well below the file size.
- [x] `SectionCapper` keeps small sections byte-identical, cuts only the
  large one, reports its name, puts the marker on its own line, and with
  a huge cap returns its input unchanged (pure test).
- [x] With a committed `.gitattributes` routing files to a diff driver
  and hostile global config defining that driver's textconv, an external
  diff, `diff.noprefix`, and `diff.mnemonicPrefix`, neither driver runs
  (marker files absent) for `base` and `uncommittedOnly` builds.
- [x] A global `diff.orderFile` that reverses order does not change
  section order for staged, committed, and uncommitted builds.
- [x] Untracked denylisted files are skipped and noted; untracked
  symlinks are not synthesized.
- [x] Linguist: marked paths are excluded and `=false` un-marks; no
  `.gitattributes` means no excludes; a name with glob metacharacters
  excludes only itself; staged mode reads attributes from the index (or
  the pinned tree) and ignores unstaged or later-staged edits; a staged
  deletion of a generated file is excluded; a staged rename of a marked
  file excludes the old path too; a global `core.attributesFile` marking
  `*` cannot blank a review; untracked marked files are excluded.
- [x] Aborting the signal during a large `gitPatch`, and during a
  best-effort step, kills git and rejects with an `AbortError`.
- [x] `diffBytes` equals the bytes git emitted for sections under the
  cap (byte-exact for non-UTF-8 content) while `diff` decodes with
  U+FFFD; sorting is code-point order.
- [x] `denylisted` matches the default patterns case-insensitively by
  basename or full path (including suffixed SSH key names, not
  `id_map.go`), and a malformed pattern never matches.
- [x] `denylistedUntracked` returns sorted untracked, non-ignored
  matches; never returns tracked files; an explicit empty pattern list
  returns `[]` without running git.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
  the Go build and Go tests still pass.
