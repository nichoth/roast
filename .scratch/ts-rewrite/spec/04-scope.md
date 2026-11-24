# Area 04: Review scope

## 1. Purpose

The scope area decides exactly what a review looks at. Given the Git
toplevel and the user's scoping choices (`--staged`, `--base`,
`--uncommitted-only`, `--paths`, `--exclude`, `--include-vendored`,
`--scope`), it runs `git` and produces a **Scope**: the diff text the
**finder** reads (or, for repo scope, a small manifest), the sorted list of
files in scope, the resolved base, the commit/tree identities the rest of
the review pins its reads to, and human-facing notes that explain every
scoping decision.

Two invariants drive the design:

1. The file list is derived from the same pathspec-filtered git queries
   that produced the diff text. A file outside the post-exclude diff can
   never reach the finder, the **verifier**, or the report.
2. Nothing a repository or the user's Git config can do may run a program
   on, rewrite, or widen the reviewed content: no external diff drivers,
   no textconv, no global/system attribute files narrowing scope, no
   following symlinks out of the tree, and secret-looking untracked files
   are never sent.

Downstream consumers: the CLI `review` command (prints notes, decides
"no diff", records scope into the **run record**), the context area
(grounding and file readers pin to `staged` / `stagedTreeOID` /
`headOID`), and the finder prompt (diff or manifest). The pre-commit
**gate** reaches this area through `review --staged`.

## 2. Behavior contract

All byte counts are UTF-8 byte counts. All git commands below are run as `git
-C <repo> <args...>` with the parent environment inherited (so an ambient
`GIT_INDEX_FILE`, `GIT_DIR`, etc. is honored, see 2.6), stdout captured as a
`Buffer`, and stderr captured for error messages. `<repo>` is always the Git
toplevel (from `gitRoot`, 2.13).

### 2.1 Constants

`DEFAULT_IGNORES` (order matters for argument order):

```
vendor/**
node_modules/**
**/node_modules/**
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml
go.sum
*.pb.go
*_pb2.py
*_pb2_grpc.py
*.min.js
*.min.css
```

`PATCH_FLAGS` go on every git invocation that produces a patch or a name
list from `diff` (so a repo's `.gitattributes` diff driver, the user's
`diff.external`, color, and prefix settings cannot change the text):

```
--no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/
```

`DIFF_FLAGS` = `--no-renames` followed by `PATCH_FLAGS`. Every diff-mode
`git diff` uses `DIFF_FLAGS`. Renames are recovered later (2.8) only for
pairs whose both sides survived the excludes.

`DIFF_CONFIG` = `-c diff.orderFile= -c core.quotePath=false`, placed
before the subcommand. Every
git invocation whose subcommand is `diff` in this file, and in the context
area's own `git diff` calls, runs as `git -C <repo> DIFF_CONFIG diff ...`
(the argument lists below omit it for brevity). It overrides the user's
`diff.orderFile` so section order is always git's default path order
(deliberate change 17, spec.md). The empty value must be verified against
the installed git during implementation (a test with a global
`diff.orderFile` that reverses the order, 5). If git rejects an empty
value or still applies the file, use `-c diff.orderFile=/dev/null`
instead; the contract is only that the user's order file has no effect.
`core.quotePath=false` keeps non-ASCII paths unquoted in patch headers
(`diff --git a/... b/...`), so the fit breakdown attributes their bytes
to the right file (deliberate change 15); git still quotes paths with
tabs, newlines, or double quotes, and those report 0 bytes in the
breakdown as in Go.

`BASE_CANDIDATES`, tried in order when no `--base` is given (diff scope
only): `origin/main`, `origin/master`, `main`, `master`, `HEAD~1`.

`EMPTY_TREE` = `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (git's empty
tree; lets a repo with no commits be diffed).

`DEFAULT_MAX_FILE_DIFF_BYTES` = `1_000_000`.

`SECTION_OMITTED_MARKER(n)` is exactly this single line (with `n` in
decimal, ending in a newline; it exceeds 80 columns by necessity):

```
\ roast: the rest of this file's diff is omitted (over <n> bytes); use read_file to inspect the file
```

The leading `\` makes it diff metadata (like git's `\ No newline at end
of file`), so the grounder and rename parser skip it as content.

`LINGUIST_ATTRS` = `linguist-generated`, `linguist-vendored`.

### 2.2 Output: the Scope value

- `diff` -- combined diff text: `diffBytes` decoded once as UTF-8 with
  U+FFFD replacement, for models and reports. Empty in repo scope.
- `files` -- sorted (bytewise, 2.15) unique repo-relative paths in scope.
- `base` -- resolved base ref *name* (e.g. `origin/main`), not an OID.
  Empty for uncommitted-only, staged, no-usable-base, and repo scope.
- `diffBytes` -- the same combined diff as a `Buffer`: the exact bytes git
  and the untracked reader produced (after capping), so anything hashed or
  recorded is byte-exact (cross-cutting "Bytes and text", spec.md).
- `notes` -- human-facing scoping notes, in the order generated. The CLI
  prints each to stderr.
- `staged` -- true only for `stagedOnly`; file context must come from the
  index (or the pinned tree), not the worktree.
- `stagedTreeOID` -- echo of `BuildOpts.stagedTreeOID` in staged mode;
  else empty.
- `manifest` -- survey map (repo scope); empty in diff scope.
- `survey` -- true for `repo` scope.
- `headOID` -- repo scope: `rev-parse HEAD`; empty if no commits.
  Empty in diff scope.

`isEmpty(scope)`: in repo scope, true when `files` is empty; otherwise
true when `diff` is empty after trimming whitespace. The CLI then writes
a report with assessment `NO_DIFF` and exits 0 (CLI area).

### 2.3 Inputs: BuildOpts and how the CLI fills them

- `base` -- `--base` (string, default `""`).
- `uncommittedOnly` -- `--uncommitted-only`.
- `stagedOnly` -- `--staged`.
- `paths` -- `--paths` (string slice: comma-separated and repeatable).
- `excludes` -- `.roast.json` `review.excludes`, followed by `--exclude`
  values.
- `includeVendored` -- `--include-vendored`.
- `scope` -- `--scope` (`diff` default; the CLI accepts only `diff` or
  `repo`).
- `stagedTreeOID` -- with `--staged`, the OID from the context area's
  `pinIndexTree(repo)`, computed before `build`.
- `maxFileDiffBytes` -- the whole-diff budget: `limits.max_diff_bytes`,
  else 1_000_000, or 200_000 with `--quick`.

`maxFileDiffBytes <= 0` (or absent) means `DEFAULT_MAX_FILE_DIFF_BYTES`.
Below this, `maxSection` names the effective value.

CLI-level validation (owned by the CLI area, restated for context):
`--scope` other than `diff`/`repo` is a usage error; `--scope repo` with
`--quick` is a usage error; `--scope repo` with any of `--staged`,
`--uncommitted-only`, `--base` is a usage error. `build` itself accepts
`""`, `diff`, `repo` and rejects anything else with
`unsupported scope "<x>": expected "", "diff", or "repo"`.
`--staged` together with `--uncommitted-only` or `--base` is not rejected;
staged mode simply ignores both.

### 2.4 Common prelude (all scopes)

1. `allExcludes` = `opts.excludes`, then (unless `includeVendored`)
   `DEFAULT_IGNORES` appended.
2. Unless `includeVendored`: `linguistExcludes = linguistIgnores(repo,
   cached = stagedOnly, treeOID = stagedTreeOID)` (2.7). If non-empty,
   note `excluding <N> path(s) marked linguist-generated/-vendored in
   .gitattributes (--include-vendored to review)`.
3. `spec = pathspecArgs(paths, allExcludes, linguistExcludes)`:
   - if all three lists are empty: no arguments at all;
   - else `--`, then each path verbatim (git pathspec, user magic allowed),
     then `:(exclude)<pattern>` per `allExcludes` entry, then
     `:(exclude,literal)<path>` per `linguistExcludes` entry.
4. Dispatch on `scope`: `repo` -> 2.12, `""`/`diff` -> 2.5, anything else
   -> the `unsupported scope` error.

The linguist step runs before dispatch, so it also runs (uncached) for
repo scope.

### 2.5 Diff scope

**No-commit detection.** `head = "HEAD"`. Run `rev-parse --verify --quiet
HEAD` (stdout/stderr discarded). On non-zero exit: `head = EMPTY_TREE`,
force `uncommittedOnly = true`, note `repository has no commits;
reviewing staged + untracked files`.

**Staged mode** (`stagedOnly`), what a commit would contain:

1. `stagedRef` = `["--cached", head]`, or `[head, stagedTreeOID]` when
   `stagedTreeOID` is set (the pinned tree replaces the live index; same
   comparison, immutable OID).
2. Patch: `diff DIFF_FLAGS stagedRef spec` through the section capper
   (2.9). Failure -> error `git diff (staged): <cause>`.
3. `notes = truncationNote(notes, cut, maxSection)`.
4. `diff, n = compactRenames(stagedRef, spec, diff)`; `renameNote(n)`.
5. Names: `diff DIFF_FLAGS --name-only -z stagedRef spec`. Failure ->
   error `git diff --name-only (staged): <cause>`. `files` = the decoded
   paths (NUL-split, 2.15), sorted.
6. Return `{diff, files, notes, staged:true, stagedTreeOID}`; `base`
   empty. No untracked files, no worktree content.

**Default mode** (committed-since-base + uncommitted + untracked):

1. Unless `uncommittedOnly`:
   1. `resolvedBase = resolveBase(base)`: candidates are `[base]` if given,
      else `BASE_CANDIDATES`; the first for which `rev-parse --verify
      --quiet <ref>` exits 0 wins; none -> `""`.
   2. If `""`: note `no usable base ref (tried <T>); reviewing uncommitted
      changes only` where `<T>` is the requested base, or
      `BASE_CANDIDATES.join(", ")`. Skip to step 2.
   3. If no base was requested and `resolvedBase !== "origin/main"`: note
      `using base '<resolvedBase>'`.
   4. `rangeArgs = buildRangeArgs(resolvedBase)`: run `merge-base <base>
      HEAD` (output discarded); exit 0 -> `["<base>...HEAD"]`, else
      `["<base>", "HEAD"]`.
   5. Patch: `diff DIFF_FLAGS rangeArgs spec` through the capper. Failure ->
      `git diff (committed): <cause>`. Cut names go to `cutSections`.
   6. `committed, n = compactRenames(rangeArgs, spec, committed)`;
      `renameNote(n)`.
   7. Names: `diff DIFF_FLAGS --name-only -z rangeArgs spec`. Failure ->
      `git diff --name-only (committed): <cause>`.
2. Uncommitted (worktree and index vs `head`): patch `diff DIFF_FLAGS
   <head> spec` through the capper; failure -> `git diff (uncommitted):
   <cause>`; cut names appended to `cutSections`; `compactRenames([head],
   spec, ...)`; `renameNote`. Names: `diff DIFF_FLAGS --name-only -z
   <head> spec`; failure -> `git diff --name-only (uncommitted): <cause>`.
3. `diff = committed`; if `uncommitted.trim() !== ""`, append
   `"\n\n### Uncommitted changes ###\n" + uncommitted` (the separator is
   added even when `committed` is empty).
4. `fileSet` = the decoded paths of both name lists (2.15).
5. Untracked files (2.10) are appended to `diff` and `fileSet`.
6. `notes = truncationNote(notes, cutSections, maxSection)` -- one note for
   committed, uncommitted, and untracked cuts together, emitted after the
   untracked denylist note.
7. Return `{diff, files: sorted fileSet, base: resolvedBase, notes}`.

Name lists use `-z` (deliberate change 15): paths arrive NUL-separated and
verbatim, never C-quoted, so a path with non-ASCII, tab, or quote characters
is a normal entry in `files`. Patch text still C-quotes such paths in its
`diff --git` headers (see 2.8, 2.16). Binary files appear as git prints them
without `--binary` or `--text` (`Binary files a/x and b/x differ`); there is
no other binary handling for tracked files.

### 2.6 Ambient Git environment

Git subprocesses inherit the full parent environment. In particular a hook
invoked by `git commit <paths>` sets `GIT_INDEX_FILE` to an alternate
index; staged mode must review that index, not `.git/index`. (The pinned
tree from `pinIndexTree` already honors it; the `--cached` fallback does
too by inheritance.)

### 2.7 Linguist generated/vendored exclusion

A repo's in-tree `.gitattributes` may mark paths `linguist-generated` or
`linguist-vendored`; those are treated like `DEFAULT_IGNORES` and are
reviewed only with `--include-vendored`.

**`linguistIgnores(repo, cached, treeOID)`**, best-effort (every failure
returns no excludes, so the review proceeds unfiltered -- never narrower):

1. Pinned index: only when `cached && treeOID`: create a temp dir
   (`<tmpdir>/roast-scope-idx-*`), `idx = <dir>/index`, extra env
   `GIT_INDEX_FILE=<idx>`, run `read-tree <treeOID>` with that env.
   Failure -> remove the dir, return no excludes (do NOT fall back to the
   live index). The temp dir is removed when the function returns.
2. `ls-files -z` (with the extra env) -> NUL-split paths, decoded per 2.15
   (invalid names skipped, counted). Failure -> none.
3. Only when `cached`: also `diff DIFF_FLAGS --cached --name-only -z`
   (with the extra env; `DIFF_FLAGS` includes `--no-renames`, deliberate
   change 16); on success append its paths. With renames off, a staged
   rename lists both its old and new path, so a staged deletion or rename
   source of a marked file, absent from the index, is still excluded.
   Failure here is ignored.
4. No paths -> none. Else `linguistMarked(paths, cached, env)`, sorted.

**`linguistMarked(repo, paths, cached, env)`**:

- Empty `paths` -> none.
- Command: `git -C <repo> -c core.attributesFile=/dev/null check-attr
  --stdin -z [--cached] linguist-generated linguist-vendored`.
- Environment: parent env, plus `GIT_ATTR_NOSYSTEM=1`, plus `env` last
  (so a pinned `GIT_INDEX_FILE` wins). These two drop the user-global and
  system attribute files; only in-tree/index attributes (and
  `$GIT_DIR/info/attributes`, which cannot be disabled) can narrow scope.
- Stdin: `paths.join("\0") + "\0"`.
- Any failure -> none.
- Output is NUL-separated `(path, attr, value)` triples; a short trailing
  group is ignored. A path is marked when `value` is `set` or `true`
  (`unspecified`, `unset`, `false` do not count, so
  `dir/x linguist-generated=false` un-marks). Deduplicate, keeping first
  occurrence order.

**Attribute source per mode**: staged -> index (`--cached`), pinned to
`stagedTreeOID` when set; every other mode -> worktree `.gitattributes`.
Untracked candidates always use the worktree (`cached = false`, no pinned
env), regardless of mode.

Linguist excludes are exact paths and go into pathspecs with
`:(exclude,literal)` magic, so a file literally named `*.go` excludes only
itself.

### 2.8 Rename compaction

Diffs use `--no-renames` so excludes apply to both sides of a move.
`compactRenames(repo, ref, spec, diffText, maxSection)` then collapses
moves whose two sides both survived the excludes. It returns
`(diffText', pairsCollapsed)` and on any git error returns the input
unchanged with 0.

**Sections.** `splitSections(text)`: starting at offset 0, each section
runs up to and including the `\n` before the next occurrence of
`"\ndiff --git "` searched from `start + 1`; the last runs to the end.
Leading text before the first header is its own section.
`classify(section)`:

- Header = first line. It must start with `diff --git `; the remainder
  `pair` must not start with `"`, must have `len >= 7` and
  `(len - 5)` even; with `n = (len - 5) / 2`, `path = pair[2 .. 2+n)`,
  require `pair[0..2) == "a/"` and `pair[2+n..) == " b/" + path`.
  Otherwise kind `other`.
- Scan the following lines: the first of `@@...` or `--- ...` -> `other`;
  `deleted file mode ...` -> `deleted`; `new file mode ...` -> `added`.

**Algorithm.**

1. Collect `deleted` and `added` paths. Either empty -> unchanged, 0.
2. `diff -M PATCH_FLAGS --name-status -z <ref...> <spec...>` (failure ->
   unchanged). Walk NUL fields as records: a status field starting with
   `R` or `C` takes two paths (`from`, `to`), any other status one path
   (advance 2). A truncated R/C record stops the walk. Accept `(from, to)`
   only when status starts with `R`, `from` is a deleted path and `to` is
   an added path of this diff. (Walking whole records is required: a path
   like `README.md` must never be read as a status.)
3. No accepted pairs -> unchanged.
4. `diff -M PATCH_FLAGS <ref...> <spec...>` through the section capper with
   the same `maxSection` (its cut list is discarded; failure ->
   unchanged).
5. For each section of that output, `renameOf(section)`: scan lines until
   one starts with `@@`; take values of `rename from ` and `rename to `
   lines; reject when either is empty or starts with `"` (quoted paths are
   left uncollapsed). Keep the section when `(from, to)` is accepted; mark
   both paths `paired`; append the section text, plus `\n` if it does not
   end in one.
6. No paired paths -> unchanged.
7. Output: every original section in order except `deleted`/`added`
   sections whose path is paired; then a `\n` if the output is non-empty
   and does not end in one; then all kept rename sections. Count =
   `paired.size / 2`.

`renameNote(n)` for `n > 0`: `collapsed <n> moved file(s) to git's rename
form (both paths in scope)`. A pure move therefore has a rename header and
no hunks; a move with a small edit shows only the edited lines.

### 2.9 Patch production and per-file cap

`gitPatch(repo, args, maxSection)` runs git and streams stdout through a
section capper, so memory per file is bounded by `maxSection` (a 24 MB
file must not be buffered whole). Algorithm on the byte stream, processed
line by line (a line longer than the read buffer arrives in fragments;
only a fragment at line start can be a header):

- State: `header = ""`, `used = 0`, `dropping = false`.
- A fragment at line start beginning with `diff --git ` first finishes the
  previous section, then sets `header` to that line (without newline),
  `used = 0`, `dropping = false`.
- While not dropping, keep `take = min(len, maxSection - used)` bytes of
  the fragment; if `take < len`, start dropping.
- Finishing a section that was dropping: if the output does not end in
  `\n`, add one; append `SECTION_OMITTED_MARKER(maxSection)`; push
  `sectionName(header)` to `cut`.
- At EOF, finish the last section.
- Text before the first header counts toward a section named `""`.
- Non-zero git exit -> error `exit status <code>: <trimmed stderr>`; a
  read error kills git and reports the read error.

`sectionName(header)`: strip `diff --git `; if it is `a/P b/P` (same
length rule as `classify`), return `P`; else the raw remainder.

`truncationNote(cut, maxSection)` for non-empty `cut`: `diff for <N>
file(s) cut at <maxSection> bytes each: <listSome(cut, 10)>`.
`listSome(items, 10)`: up to 10 joined by `, `; beyond 10, the first 10
then `, and <K> more`.

The cut is at a byte offset and may split a multi-byte UTF-8 sequence;
see 3.4 for decoding.

### 2.10 Untracked files (default diff mode only)

1. `ls-files --others --exclude-standard -z` (deliberate change 15);
   failure -> error `git ls-files --others: <cause>`.
2. For each decoded path `u` (2.15; names that are not valid UTF-8 are
   skipped and counted), in git's order:
   - skip unless `untrackedPasses(u, paths, allExcludes)` (2.14);
   - if `snapshot.denylisted(u)` -> add to `denied` (the snapshot area's
     secret denylist; applies even with `--include-vendored`);
   - else candidate.
3. `denied` non-empty -> note `skipped <N> untracked file(s) matching the
   secret denylist: <listSome(denied, 10)>`.
4. Unless `includeVendored`, drop candidates returned by
   `linguistMarked(repo, candidates, cached=false, env=none)`.
5. For each remaining candidate, `synthesizeNewFileDiff(u, maxSection)`;
   empty result -> skipped silently (not added to `files`); cut -> add `u`
   to `cutSections`; else add the block and add `u` to `fileSet`.
6. If any blocks: if `diff.trim() !== ""` append `"\n\n### Untracked files
   (treated as new-file additions) ###\n"`; then append
   `blocks.join("\n")`.

**`synthesizeNewFileDiff(relpath, maxSection)`**:

- `lstat(<repo>/<relpath>)`; not a regular file (symlink, dir, missing,
  error) -> `""`. Symlinks are never followed.
- Read at most `maxSection + 1` bytes; any error -> `""`. `cut =
  bytesRead > maxSection`.
- Split on `\n`; drop one trailing empty element.
- `header = "diff --git a/P b/P\nnew file mode 100644\n--- /dev/null\n+++
  b/P\n"` with `P = relpath` verbatim (no quoting).
- For each line: if `len(header) + len(body) + len(line) + 2 >
  maxSection`, set `cut` and stop; else append `"+" + line + "\n"` and
  count it.
- Result: header, `@@ -0,0 +1,<count> @@\n`, body, and if `cut`
  `SECTION_OMITTED_MARKER(maxSection)`.
- No binary detection: content is treated as text bytes. An empty file
  yields `@@ -0,0 +1,0 @@` and no body.

### 2.11 Branch survey scope (not ported)

The Go `branch` scope was unreachable from the CLI and is intentionally
absent from the TypeScript port (deliberate change 23, spec.md); this
number is kept so later references stay stable.

### 2.12 Repo survey scope (`scope: "repo"`)

Reviews the committed tree at HEAD as one snapshot.

1. `status --porcelain` (failure -> `git status --porcelain: <cause>`).
   If non-blank: if `linguistExcludes` non-empty, note `working tree is
   dirty: skipping .gitattributes-based excludes for repo scope (they were
   resolved from the mutable index/worktree, not HeadOID)`; set
   `linguistExcludes = []`; then note `working tree has uncommitted
   changes not reflected in this repo-scope snapshot (pinned to
   HeadOID)`.
2. If `rev-parse --verify --quiet HEAD` succeeds: `headOID = rev-parse
   HEAD` trimmed (failure -> `git rev-parse HEAD: <cause>`). Else note
   `repository has no commits; manifest is empty`.
3. With a `headOID`: `ls-tree -r --name-only -z <headOID>` (failure ->
   `git ls-tree: <cause>`). Keep each decoded path (2.15; non-UTF-8 names
   are skipped and counted) that is not in the
   `linguistExcludes` set (exact membership, not glob) and that passes
   `untrackedPasses(path, paths, allExcludes)`. Sort.
   (Read from the HEAD tree, not the index, so staged changes do not leak
   into or out of the listing.)
4. `headLine`: with a `headOID`, `log --oneline --no-color
   --no-show-signature -1` trimmed; errors ignored (empty).
5. Top-level directory of each file = text before the first `/`, or the
   whole name for a root file. Count per directory; sort directory names.
6. Manifest, with `q(s)` = `manifestQuote(s)` (2.12.1) applied to the
   head line, directory names, and file names:
   ```
   ### Repository snapshot ###
   HEAD: <q(headLine)>            (or "HEAD: (no commits)" when empty)
   <F> tracked file(s) across <D> top-level director(ies)

   ### Files by top-level directory ###
   <q(dir)> (<count>)             (one per directory)

   ### Tracked files ###
   <q(file)>                      (one per file)
   ```
   Every line ends in `\n`. If any `q` call quoted, append
   `\n(Names in double quotes contain control or markup characters and
   are Go-escaped; unescape one before passing it to a tool.)\n`.
7. Return `{manifest, survey:true, files, headOID, notes}`; `base`,
   `baseOID`, `mergeBaseOID` empty.

#### 2.12.1 manifestQuote

A name is safe (returned unchanged) when it contains none
of `"`, `\`, `<`, `>`, and every code point is printable per Go's
`unicode.IsPrint`: categories L, M, N, P, S, plus U+0020 only (other
spaces, controls, format characters, line/paragraph separators are not).
Otherwise return Go `strconv.Quote(s)` with every `<` replaced by `\x3c`
and every `>` by `\x3e`. `strconv.Quote` rules: wrap in `"`; `"` and `\`
escaped with `\`; printable code points literal; `\a \b \f \n \r \t \v`
for those controls; other code points below U+0020 and U+007F as `\xNN`;
other non-printable code points as
`\uXXXX` (< U+10000) or `\UXXXXXXXX`. Hex digits are lowercase. Names
reaching it are always valid UTF-8 (2.15), so Go's invalid-byte `\xNN`
case does not arise. Unicode printable differences between Go's
`unicode.IsPrint` and JS `\p{...}` classes for newly assigned code points
are accepted (deliberate change, section 4).

### 2.13 gitRoot

`gitRoot(start)`: `git -C <start> rev-parse --show-toplevel`, trimmed.
Any failure -> error `not inside a git repository`. Used by every command
that needs the repo (review, init, trust, doctor, gate, skill, ignore,
runs, config discovery).

### 2.14 In-process glob matching (`untrackedPasses`)

Used for untracked files and the repo-scope listing (git's pathspec
engine handles tracked diffs).

`globToRegExp(pattern)` builds an anchored full-match regex scanning the
pattern byte by byte:

- `**` -> `.*`, and if immediately followed by `/`, that `/` becomes `/?`;
- `*` -> `.*` (crosses `/`, Python `fnmatch` semantics);
- `?` -> `.` (one character);
- each of `. + ^ $ { } ( ) [ ] |` and `\` -> escaped literally (so `[...]`
  classes are NOT supported);
- anything else literal.

`.` must not match `\n` and must match every other character (Go RE2
semantics; in JS use `[^\n]` rather than `.`).

`globMatch(path, pattern)`: match `pattern`; if not, and replacing every
`**` with `*` changes it, match that instead.

`untrackedPasses(path, paths, excludes)`:

1. Any exclude glob matches -> false.
2. `paths` empty -> true.
3. For each path pattern: glob match -> true; or, when the pattern
   contains none of `*`, `?`, `[`, let `dir` = pattern without one
   trailing `/`; `dir` non-empty and `path` starts with `dir + "/"` ->
   true (a bare directory selects its subtree, as git pathspecs do).
4. Otherwise false.

Examples: `vendor/foo/bar.go` matches `vendor/**`; `a/node_modules/d.js`
matches `**/node_modules/**`; `foo.pb.go` matches `*.pb.go`; `keep.go`
matches neither `*.pb.go` nor `vendor/**`.

### 2.15 Ordering and text rules

- All sorts are bytewise over UTF-8 (equivalently by Unicode code point),
  not JS's default UTF-16 order.
- "Non-empty lines" = split on `\n`, drop empty strings (no trimming).
- NUL splitting: split on `\0`, drop exactly one trailing empty element;
  empty input -> no elements. It is done on the raw `Buffer`.
- Path decoding (deliberate change 24): each NUL-split path from
  `diff --name-only -z`, `ls-files --others -z`, `ls-files -z`, and
  `ls-tree -z` is decoded with `new TextDecoder('utf-8', { fatal: true })`.
  A path that is not valid UTF-8 is skipped and counted (it cannot
  round-trip through a JS string). If the total count for the build is
  non-zero, the build adds the note `skipped <N> path(s) whose names are
  not valid UTF-8`, once, as its last note. Git's pathspec filtering has
  already happened, so such a file's section may still appear in the diff
  text; only the path is absent from `files`. Records from the rename
  `--name-status -z` walk (2.8) skip invalid names silently.
- "Trim" = remove leading/trailing whitespace (Go `strings.TrimSpace`).

### 2.16 Fit (whole-diff budget)

`fit(scope, maxBytes)` (called by the CLI after grounding has captured
the pre-fit diff):

- `byteLength(diff) <= maxBytes` -> unchanged, no breakdown.
- Else breakdown: for each file in `files`, `{path, bytes:
  fileDiffBytes(file)}`, sorted by bytes descending with a stable sort:
  ties keep `files` order (deliberate change 18; JS `Array.prototype.sort`
  is stable). New diff = first `maxBytes` bytes + `"\n... (diff
  truncated)\n"`; note `diff truncated to <maxBytes> bytes`.

`fileDiffBytes(diff, P)`: starting at `pos = 0`, repeatedly find
`diff --git a/P b/P` at or after `pos` (index `start`); the block ends at
`end` = the index of the `\n` that precedes the next `"\ndiff --git "`
found searching from `start + 1`, or the end of the diff; add
`end - start`; set `pos = end`. Then add the full length of every section
(2.8 `splitSections`) whose `renameOf` yields `from === P` or `to === P`
(a collapsed move's header names two paths, so it counts for both).

A path that git C-quotes in `diff --git` headers (non-ASCII, tab, quote)
never matches the literal `a/P b/P` search, so its breakdown entry is 0
bytes; this is accepted.

The CLI renders the breakdown in the report (render area).

### 2.17 Error surface

`build` errors are plain errors (never usage errors). The CLI prints them
and maps uncategorized errors to its default operational exit code (CLI
area). Best-effort steps (linguist, rename compaction, untracked
synthesis of one file, repo-scope head line) never fail the build, with
the exception of cancellation (3.3).

## 3. TypeScript module design

### 3.1 Files under `src/scope/`

```
src/scope/constants.ts  DEFAULT_IGNORES, PATCH_FLAGS, DIFF_FLAGS,
                        DIFF_CONFIG, BASE_CANDIDATES, EMPTY_TREE,
                        DEFAULT_MAX_FILE_DIFF_BYTES, sectionOmittedMarker
src/scope/git.ts        git subprocess helpers (execFile + spawn)
src/scope/patch.ts      SectionCapper, sectionName, truncationNote,
                        listSome
src/scope/renames.ts    splitSections, classify, renameOf, compactRenames,
                        renameNote
src/scope/glob.ts       globToRegExp, globMatch, untrackedPasses
src/scope/linguist.ts   linguistIgnores, linguistMarked
src/scope/untracked.ts  synthesizeNewFileDiff
src/scope/survey.ts     buildSurveyRepo, manifestQuote, goQuote
src/scope/build.ts      build, isEmpty, fit, fileDiffBytes, gitRoot,
                        resolveBase, buildRangeArgs, pathspecArgs
src/scope/text.ts       compareBytes, nonEmptyLines, splitNul,
                        decodePaths
```

Depends on `src/snapshot/` (`denylisted(path)`) only. Used by `src/cli/`
(review, and `gitRoot` everywhere), `src/context/` (imports `PATCH_FLAGS` for
its own `git diff --no-renames ... <range> -- <file>` calls, prefixed with
`DIFF_CONFIG`), and indirectly by `src/record/` (the CLI copies scope fields
into `meta.json`'s `scope` object).

### 3.2 Types and signatures

```ts
export type ScopeKind = ''|'diff'|'repo'

export interface BuildOpts {
    base?:string
    uncommittedOnly?:boolean
    stagedOnly?:boolean
    paths?:readonly string[]
    excludes?:readonly string[]
    includeVendored?:boolean
    scope?:string
    stagedTreeOID?:string
    maxFileDiffBytes?:number
}

export interface Scope {
    readonly diff:string
    readonly diffBytes:Buffer
    readonly files:readonly string[]
    readonly base:string
    readonly notes:readonly string[]
    readonly staged:boolean
    readonly stagedTreeOID:string
    readonly manifest:string
    readonly survey:boolean
    readonly headOID:string
}

export interface SizeEntry {
    path:string
    bytes:number
}

export function build (
    repo:string,
    opts:BuildOpts,
    signal?:AbortSignal
):Promise<Scope>

export function isEmpty (scope:Scope):boolean

// Pure; returns a new Scope rather than mutating (the CLI keeps the
// pre-fit diff for grounding).
export function fit (
    scope:Scope,
    maxBytes:number
):{ scope:Scope, breakdown:SizeEntry[]|null }

export function gitRoot (
    start:string,
    signal?:AbortSignal
):Promise<string>
```

### 3.3 git.ts

```ts
export class GitError extends Error {
    // message: `exit status <code>: <trimmed stderr>`
    exitCode:number|null
    stderr:string
}

export interface GitRunOpts {
    signal?:AbortSignal
    env?:Record<string, string>   // merged over process.env
    input?:Buffer|string          // written to stdin, then closed
}

// Buffered: execFile('git', ['-C', repo, ...args], {
//   encoding: 'buffer', maxBuffer: Infinity, signal,
//   env: { ...process.env, ...opts.env } })
export function gitOut (
    repo:string, args:readonly string[], opts?:GitRunOpts
):Promise<Buffer>

// Exit status only; stdout/stderr ignored. Resolves false on non-zero
// exit, rejects only on abort or spawn failure (ENOENT).
export function gitOk (
    repo:string, args:readonly string[], opts?:GitRunOpts
):Promise<boolean>

// Streaming: spawn('git', ...) with { signal }, stdout piped through a
// SectionCapper chunk by chunk; stderr buffered.
export function gitPatch (
    repo:string, args:readonly string[], maxSection:number,
    opts?:GitRunOpts
):Promise<{ out:Buffer, cut:string[] }>
```

Rules:

- `maxBuffer` must be effectively unlimited for buffered calls (Go has no
  cap; `ls-files`/`ls-tree` on large repos exceed Node's 1 MiB default).
  Patch output always goes through `gitPatch`, never `gitOut`.
- `gitOk` replaces Go's `git(...)` helper (`rev-parse --verify --quiet`,
  `merge-base` probe).
- Abort: on `signal` abort, the child is killed and the promise rejects
  with the signal's reason (an `AbortError`). Every best-effort `catch` in
  this area (linguist, compactRenames, untracked read, repo head line,
  temp dir cleanup) must rethrow when `signal?.aborted` is true, so
  cancellation is never mistaken for "no excludes" or "no renames".
- Every `diff` argument list is built with `DIFF_CONFIG` first (2.1).
- `check-attr` stdin uses `input`; the extra env for it is
  `{ GIT_ATTR_NOSYSTEM: '1', ...pinnedEnv }` and the args start with
  `-c core.attributesFile=/dev/null`.
- Temp index dir: `fs.mkdtemp(path.join(os.tmpdir(),
  'roast-scope-idx-'))`, removed with `fs.rm(dir, { recursive: true,
  force: true })` in `finally`.
- Debug: namespace `roast:scope` may log each git argv and exit code;
  never stdout content, file contents, or environment values.

### 3.4 Bytes vs strings

Go strings are byte strings; JS strings are UTF-16. To keep every size
rule byte-exact:

- `SectionCapper` works on `Buffer` chunks, finds `\n` and the
  `diff --git ` prefix on bytes, counts `used` in bytes, and collects
  kept slices; `finish()` returns one `Buffer` decoded once with UTF-8
  (`buf.toString('utf8')`, lossy) only for `Scope.diff`. `gitPatch`
  returns the capped `Buffer`, and `diffBytes` keeps those exact bytes for
  hashing and recording. A section cut mid-sequence therefore ends in
  U+FFFD in `diff`, before the marker newline, matching what the Go bytes
  become once JSON-encoded for a provider.
- `compactRenames` and `splitSections` operate on `Buffer` (searching the
  byte pattern `\ndiff --git `); only a section's header and `rename`
  lines are decoded for `classify` / `renameOf`.
- `synthesizeNewFileDiff` reads into a `Buffer` (`fs.open` +
  `read` up to `maxSection + 1`), splits on byte `0x0a`, measures header,
  body and line lengths in bytes (header via `Buffer.byteLength`), and
  decodes the final block once.
- `fit` measures `diffBytes.length`, truncates `diffBytes` on a byte
  offset (`subarray(0, maxBytes)` plus the marker bytes), and decodes the
  result for `diff`. `fileDiffBytes` returns byte lengths.
- Git name output is read as `Buffer` and NUL-split; `decodePaths(buf)`
  returns `{ paths:string[], skipped:number }` using a fatal UTF-8
  decoder, so non-UTF-8 names are skipped with a warning note (2.15).
- `compareBytes(a, b)` = code-point order (e.g. compare
  `Buffer.from(a)` with `Buffer.compare`); used for every sort.

### 3.5 Survey helpers (repo scope)

- `manifestQuote(name:string):{ text:string, quoted:boolean }` with
  printable test `/^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u` per code point.
  Names are already valid UTF-8 (`decodePaths`), so it takes a string.
- There is no `cUnquote`: it served only branch scope, and `-z` removes
  C-quoted name lists.

## 4. Deliberate changes

- Cancellation: `build` and `gitRoot` take an `AbortSignal` (Go's scope
  package had no context). Aborting kills the running git child and
  rejects with an `AbortError`; best-effort steps do not swallow it.
- Windows is unsupported, so `/dev/null` is used literally for
  `core.attributesFile` (Go used `os.DevNull`).
- `fit` returns a new Scope instead of mutating in place (no observable
  difference: the CLI already used the pre-fit diff for grounding).
- Branch survey scope is not ported (deliberate change 23): no `branch`
  scope, `includeWorktree`, `baseOID`, `mergeBaseOID`, `cUnquote`, or
  branch tests.
- Name lists and `ls-files --others` use `-z` (deliberate change 15).
- Names that are not valid UTF-8 are skipped with a warning note
  (deliberate change 24); git output is read as `Buffer`, and `Scope`
  carries `diffBytes` so hashed or recorded diff bytes are exact.
- The `fit` breakdown uses a stable sort (deliberate change 18).
- Staged linguist exclusion lists a rename's deleted side too, via
  `--no-renames` (deliberate change 16).
- `diff.orderFile` is overridden on every `diff` invocation with
  `DIFF_CONFIG` (deliberate change 17); verify the empty value against
  git during implementation.
- Go `unicode.IsPrint` vs JS `\p{...}` differences for newly assigned
  code points in `manifestQuote` are accepted.

Nothing else changes: other argument lists, note strings, manifest layout, and
error messages are as in Go.

## 5. Test plan

Seam: scope tests call `build()` (and `fit`, `gitRoot`) against real
temporary Git repositories created with `git init` plus
`user.email`/`user.name` config, because `Notes`, `Manifest`, OIDs and
cut lists are only partly observable through the CLI. Assertions use
structure (file lists, presence of a path in a diff header, counts of
`SECTION_OMITTED_MARKER` occurrences, `+`/`-` line counts), not note
wording; a note "names a file" check is a path substring check. A few
CLI-level tests (in-process `run`, fake inference server, approved
config) pin the flag wiring by asserting on `meta.json` `scope.files`
and on the diff text the fake server received.

Tests that set `GIT_INDEX_FILE` or other git env must restore it.
Every test repo lives in a temp dir; no test runs git in this checkout.

**Pathspecs and excludes**

- Excludes filter both the diff text and `files`
  (TestExcludesFilterBothDiffAndFiles).
- Untracked synthesis honors `--paths` and excludes
  (TestUntrackedSynthesisHonorsExcludesAndPaths).
- Glob matcher cases from 2.14 (TestGlobMatch) -- pure function test.
- Default scope with `scope` unset equals explicit `diff`
  (TestDiffScopeUnchangedByDefaultAndExplicit).
- Unknown scope string (including `branch`) is an error
  (TestBuildUnknownScopeErrors).
- A path with non-ASCII characters appears unquoted in `files` for tracked
  and untracked changes, and the untracked file is synthesized (new,
  replaces the Go quoted-path skip).
- A file name that is not valid UTF-8 is skipped with a warning note and
  absent from `files`; the build still succeeds. Create the name with a
  `Buffer` path; skip the test on filesystems that refuse such names
  (macOS APFS).

**Renames**

- A move is a delete+add under `--no-renames`, with excludes applied to
  each side (TestRenameBecomesDeleteAdd).
- Moved files with small edits collapse to rename sections with only the
  edited lines (TestMovedFilesCollapseToRenameSections).
- A pure move has a rename header and no hunks (TestPureMoveHasNoHunks).
- A move across an exclude boundary is not paired; the excluded side
  never appears (TestMovesAcrossExcludesAreNotPaired).
- An uncommitted (staged) move collapses too (TestUncommittedMoveCollapses).
- `fit` breakdown counts a collapsed move for both paths
  (TestFitBreakdownCountsCollapsedMoves).
- Record walk does not misread a path starting with `R` as a status
  (TestMoveCollapsesAfterPathStartingWithR).

**Staged mode**

- Staged reads only the index; worktree-only edits are absent
  (TestStagedModeReadsIndexOnly).
- An alternate `GIT_INDEX_FILE` (as in `git commit <paths>`) is honored
  and the shared index's staged content does not leak
  (TestStagedModeHonorsGitIndexFile).

**Base and empty repo**

- No commits: diff against the empty tree, staged + untracked reviewed,
  note present (TestEmptyRepoEmptyTreeFallback).
- Base fallback notes: `using base` when not `origin/main`, `no usable
  base` when none resolves (TestBaseFallbackNotes).

**Size caps**

- Two 24 MB files (one committed, one untracked) with a 64 KiB cap: diff
  stays under 4x the cap, two omission markers, a small later file is
  intact, notes name both cut files, all three in `files`
  (TestBuildBoundsHugeFileDiffs). The Go allocated-bytes
  assertion becomes an RSS bound: peak `process.memoryUsage().rss` growth
  stays well below the file size (spec.md, Testing Decisions).
- Capper keeps small sections byte-identical, cuts only the large one,
  reports its name, and places the marker on its own line; with a huge
  cap output equals input (TestCapSectionsKeepsSmallSectionsWhole) --
  pure `SectionCapper` test.
- `fit` truncation and descending breakdown
  (TestFitTruncationAndBreakdown); equal-size files keep `files` order
  (new, deliberate change 18).

**Hardening**

- A committed `.gitattributes` routing `*.go` to a named diff driver,
  plus hostile global Git config defining that driver's textconv and an
  external diff (each writing a marker file) and `diff.noprefix` /
  `diff.mnemonicPrefix`, never runs either driver, for both
  `base` and `uncommittedOnly` builds (TestBuildIgnoresUserDiffDrivers).
  Isolate global config via `GIT_CONFIG_GLOBAL` or `HOME`.
- A global `diff.orderFile` that reverses the order does not change
  section order, for staged, committed, and uncommitted builds (new,
  deliberate change 17; also proves the empty-value override works).
- Untracked secret-denylisted files are skipped and noted
  (TestBuildSkipsDenylistedUntrackedFiles).
- Untracked symlinks are not synthesized
  (TestUntrackedSymlinkNotSynthesized).
- Repo manifest quotes hostile names (newline, `<`, `>`) and adds the
  explanation line (TestSurveyManifestQuotesHostileNames).

**Linguist**

- Marked paths are found; `=false` un-marks (TestLinguistIgnores).
- No `.gitattributes` -> no excludes (TestLinguistIgnoresNoAttributes).
- Generated files are excluded from diff and files
  (TestLinguistGeneratedExcludedFromDiff).
- A file named with glob metacharacters excludes only itself
  (TestLinguistLiteralPathspec).
- Staged mode reads attributes from the index, ignoring an unstaged
  `.gitattributes` edit (TestLinguistStagedUsesIndexAttributes).
- Exclusions honor the pinned tree, not a later-staged `.gitattributes`
  (TestLinguistExclusionsHonorThePinnedTree).
- A staged deletion of a generated file is excluded
  (TestLinguistStagedDeletionExcluded).
- A staged rename of a marked file excludes the old path too (new,
  deliberate change 16).
- A global `core.attributesFile` marking `*` cannot blank a review
  (TestLinguistIgnoresGlobalAttributes); isolate `HOME` /
  `XDG_CONFIG_HOME` / `GIT_CONFIG_GLOBAL` in this test.
- Untracked marked files are excluded
  (TestLinguistGeneratedExcludesUntracked).

**Repo survey**

- Manifest lists tracked files, directory counts, HEAD line
  (TestSurveyRepoManifest).
- Excludes apply to the listing (TestSurveyRepoExcludesApplied).
- No tracked files -> `isEmpty` (TestSurveyRepoEmptyWhenNoTrackedFiles).
- Files reflect `headOID`, not the index
  (TestSurveyRepoFilesReflectHeadOIDNotIndex).
- Dirty tree drops linguist excludes rather than drifting
  (TestSurveyRepoDirtyTreeDoesNotDriftLinguistExcludes).
- A bare directory `--paths` value selects its subtree
  (TestSurveyRepoDirectoryPathspecMatchesSubtree).

**New in TS**

- Aborting the signal during a large `gitPatch` kills git and rejects
  with an `AbortError`, also when abort lands inside a best-effort step.
- `diffBytes` equals the bytes git emitted for sections under the cap
  (byte-exact for non-UTF-8 content), while `diff` decodes with U+FFFD.
- Sorting uses code-point order (a path with an astral character sorts
  after one with U+FFFD).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/scope/scope.go` -- Build, survey scopes (branch not ported),
  linguist, globs,
  untracked synthesis, Fit, GitRoot.
- `internal/scope/patch.go` -- capSections, sectionName, truncationNote,
  DefaultMaxFileDiffBytes, sectionOmittedMarker.
- `internal/scope/renames.go` -- compactRenames, splitSections, classify,
  renameOf.
- `internal/scope/scope_test.go`, `linguist_test.go`,
  `hardening_test.go`.
- `internal/cli/cli.go` (flag definitions, `--scope` validation,
  BuildOpts wiring, Fit call, run-record scope meta).
- `internal/context/tree.go` (`PinIndexTree`).
- `internal/snapshot/snapshot.go` (`DefaultDenylist`, `Denylisted`).

## 7. Resolved

Open questions from the draft, resolved by the maintainer (spec.md,
"Deliberate changes from the Go baseline"):

1. Branch survey scope is not ported (deliberate change 23).
2. Diff name lists and `ls-files --others` use `-z` (deliberate change 15).
3. Non-UTF-8 file names are skipped with a warning (deliberate change 24);
   git output is read as `Buffer` (cross-cutting "Bytes and text").
4. The fit breakdown uses a stable sort (deliberate change 18).
5. Staged generated-file exclusion lists renames' deleted side too
   (deliberate change 16).
6. The user's `diff.orderFile` is overridden (deliberate change 17);
   verify the mechanism against git during implementation.
7. The huge-file test asserts an RSS bound (spec.md, Testing Decisions).
8. Go/Node Unicode printable differences are accepted.
