# 05 -- Review context, repository navigation tools, grounding

## 1. Purpose

This area decides what repository content the **finder** and **verifier**
can see during one review, and checks afterwards that every finding quotes
code the finder could actually have seen.

It has four parts:

1. **The reviewed tree** (`Tree`). One review reads one corpus. A staged
   review reads an immutable tree written from the index. A normal review
   reads the immutable "captured worktree" tree (tracked files plus
   untracked, non-ignored, non-denylisted files) that the snapshot area
   writes. If no tree can be pinned, readers fall back to the live working
   tree and enforce the same corpus rules on every read. Every reader in
   this area (file context, the three exploration tools, the grounder)
   takes the same `Tree`, so later checkout or index edits cannot change
   what a running review sees.
2. **File context** for the prompts: numbered, middle-truncated snippets
   of the reviewed files for the finder's user prompt, and one snippet of
   the cited file for each verifier prompt.
3. **Exploration tools** handed to the agent loop: `read_file`,
   `list_files`, `grep_repo` (finder in interactive mode, verifier
   always). The Go baseline's `git_diff` tool and the grounder's range
   corpus are dead code there and are intentionally absent from the TS
   port (deliberate change 23 in `spec.md`).
4. **Quote grounding**: the check `review.Validate` uses to drop a
   finding whose `code_quote` does not appear (modulo whitespace) in the
   cited file's content or the cited file's section of the reviewed diff.

All model-supplied paths and patterns are untrusted. Repository content is
attacker-controlled. Every tool result is size-bounded and every path is
confined to the reviewed corpus; nothing in this area ever serves `.git`
content, ignored files, or untracked denylisted credentials.

The agent loop that calls the tools, their per-call timeout, and the JSON
encoding of results belong to the LLM area. The scope area owns the diff,
the file list, the manifest, `PatchFlags`, and fitting. The snapshot area
owns `PinWorktree` and the secret denylist. The prompts area renders the
user prompts that embed this area's text.

## 2. Behavior contract

### 2.1 Constants and limits

All byte counts are UTF-8 bytes, never UTF-16 code units.

| Name | Value | Meaning |
| --- | --- | --- |
| `TOOL_OUTPUT_CAP` | 65536 | Ceiling on one tool result's content |
| `MAX_LINE_BYTES` | 32768 | Ceiling on one served `read_file` line |
| `READ_FILE_LINE_LIMIT` | 2000 | Max lines in one `read_file` window |
| `GREP_LINE_BYTES` | 2048 | Ceiling on one `grep_repo` match line |
| `LIST_FILES_CAP` | 500 | Max entries in one `list_files` result |
| `GREP_MATCH_CAP` | 200 | Max match lines in one `grep_repo` result |
| `GROUNDING_CACHE_BYTES` | 8388608 | Max file normalized whole |
| `MAX_WINDOW` | 1073741824 | Clamp on parsed `offset` / `limit` (2^30) |
| `LIST_PATTERN_MAX` | 256 | Max `list_files` pattern length in bytes |
| default window | offset 1, limit 500 | `parseOffsetLimit` defaults |
| stream buffer | 65536 | Read buffer for streamed git output |

Values used by callers (CLI area) and restated here so the area is
complete:

- Finder file context: `BuildFileContext(repo, files, budget, tree)` with
  `budget` = `limits.max_file_ctx_bytes` from the project config, default
  400000, or 100000 under `--quick`. Each file's snippet is rendered with
  `maxBytes` 120000.
- Verifier snippet: `NumberedSnippet(repo, finding.file, 60000, tree)`.

### 2.2 The reviewed tree

```ts
type Tree = {
    oid:string        // '' means the live working tree
    worktree:boolean  // true: captured worktree; false + oid: index tree
}
```

- `pinned(t)` is `t.oid !== ''`.
- `staged(t)` is `pinned(t) && !t.worktree` (the index corpus).
- `pinnedWorktree(oid)` returns `{oid, worktree: oid !== ''}`.
- The zero tree `{oid: '', worktree: false}` is the live working tree.

The CLI chooses the tree once per review:

1. `--staged`: `pinIndexTree(repo)` before building scope. Its failure is
   fatal; the CLI wraps the message as `pin staged tree: <err>`.
2. Otherwise, after building scope, `snapshot.pinWorktree(repo)`. On
   success the tree is `pinnedWorktree(pin.tree)`. On failure the CLI
   logs `could not pin the working tree (<err>); reading it live with
   .git, ignored, and denylisted paths blocked` and uses the live tree.

#### `pinIndexTree(repo)`

Writes the current index into an immutable tree object without touching
the live index, any ref, or any commit.

1. `git -C <repo> rev-parse --absolute-git-dir` -> `gitDir` (stdout
   trimmed). Failure -> error `resolve git dir: <err>`.
2. The live index path is `$GIT_INDEX_FILE` when set (joined onto `repo`
   when relative), else `<gitDir>/index`. Honoring `GIT_INDEX_FILE` is
   required: inside the pre-commit gate Git points it at a temporary index
   holding exactly the commit's content.
3. Create a temp directory with prefix `roast-pin-` under the OS temp dir;
   failure -> `temp dir: <err>`. It is removed on every exit path.
4. Copy the live index to `<tmp>/index` with mode `0600`. A missing live
   index is not an error (Git treats it as an empty index): skip the copy.
   Errors: `read <src>: <err>`, `create <dst>: <err>`, `copy index: <err>`.
5. `git -C <repo> write-tree` with `GIT_INDEX_FILE=<tmp>/index` added to
   the inherited environment. Failure -> `write-tree: <err>`. An index with
   unmerged entries fails here.
6. Return `{oid: <trimmed stdout>, worktree: false}`.

Git failures in this helper fold stderr into the error:
`<exec error>: <trimmed stderr>` when stderr is non-empty.

### 2.3 Path confinement

#### `resolveUnderRepo(repo, userPath)` -> absolute path or reject

The single chokepoint for model-supplied paths on the live tree.

1. Reject `''` and absolute paths.
2. `root` = realpath of `repo` (fall back to `repo` on error).
3. `candidate` = `root` joined with the Go-`Clean`ed `userPath` (lexical:
   collapse `.`/`..`/duplicate slashes, drop a trailing slash).
4. `resolved` = `resolveDeepest(candidate)`: realpath of `candidate`; if
   that fails, realpath of its parent, and so on up to `/`. The
   non-existent tail is dropped, not re-appended.
5. Reject unless `resolved === root` or `resolved` starts with
   `root + '/'`.
6. Reject if `inGitDir(root, candidate)` or `inGitDir(root, resolved)`:
   the path relative to `root` has any segment equal to `.git`
   case-insensitively (so `.GIT/config` is refused on case-insensitive
   file systems). A relative-path computation error also rejects.
7. Return `candidate` (not `resolved`).

Examples: `''`, `/etc/passwd`, `../escape`, `sub/../../etc/passwd`, and
`escape_link/secret.txt` (symlink to a directory outside the repo) are
rejected; `internal/foo.go` and `.` are accepted.

#### `resolveLive(repo, userPath)`

`resolveUnderRepo`, then the corpus rules a pinned tree enforces by
construction, applied to the path as given and, when different, to its
symlink target (`resolveDeepest(candidate)`), each taken relative to
`root`:

- `rel === '.'` is allowed.
- If `rel` matches the secret denylist (snapshot area, `isDenylisted`) and
  is not tracked, reject. Tracked means
  `git -C <repo> ls-files -z --cached -- <rel>` (with
  `GIT_LITERAL_PATHSPECS=1`) exits 0 with non-empty stdout.
- `git -C <repo> check-ignore -q -- ./<rel>` with
  `GIT_LITERAL_PATHSPECS=0` in the environment (check-ignore refuses
  literal mode; the `./` prefix stops a leading `:` from being read as
  pathspec magic). Allowed only when it exits with code 1 ("not ignored").
  Exit 0 (ignored) or any other failure rejects (fail closed).

Example: `gitlink -> .git` symlink: `gitlink/config` is rejected because
its target is inside `.git`.

#### `stagedPathIsMagic(relpath)` / `stagedPathCanonical(relpath)`

Pinned-tree reads spell blobs as `<oid>:<relpath>`, so a model-supplied
path could land in Git's revision grammar. `stagedPathIsMagic` returns
true (reject) when any of:

- `relpath === ''` or starts with `:`;
- `relpath[1] === ':'` and `relpath[0]` is `0`..`3` (merge stage selector,
  e.g. `0:foo.go`);
- splitting on `/` yields any segment that is `''`, `.` or `..` (covers
  `/foo.go`, `./foo.go`, `../foo.go`, `sub/../foo.go`, `sub//foo.go`,
  `foo.go/.`, and a trailing slash).

`stagedPathCanonical` is its negation. A pinned-tree reader never runs
`resolveUnderRepo`; canonical spelling is its only path check, and the
pinned tree contains no `.git`, ignored, or denylisted entries.

#### Git invocation rules

- Every git call is `git -C <repo> ...` via `execFile` (no shell), with
  the inherited environment plus any listed overrides.
- "literal git" means the environment gains `GIT_LITERAL_PATHSPECS=1`.
- Model-supplied paths always follow `--`.
- Commands whose output may be large are streamed and the child process is
  killed (not drained) once the reader has what it needs.
- Every git child process this area spawns is also killed when the
  caller's `AbortSignal` fires (`spec.md` cross-cutting "Process
  lifetime"), including blocking calls such as `cat-file -s`,
  `check-ignore`, `ls-files`, and `write-tree`.
- Git output is read as `Buffer`. Bytes are decoded to a string with
  U+FFFD replacement only where the text goes to a model (tool results,
  prompt snippets). Hashing and matching paths stay on bytes (`spec.md`
  cross-cutting "Bytes and text").

### 2.4 Blob reads from a pinned tree

- `stagedContent(repo, tree, relpath)`: if magic -> absent. Else
  `git -C <repo> cat-file blob <oid>:<relpath>`; non-zero exit -> absent;
  else the whole stdout.
- `stagedContentCeiling(repo, tree, relpath, ceiling)`: same guard and
  command, but streamed. Read up to `ceiling` bytes, then try one more
  byte. If that byte exists, `truncated = true` and the child is killed.
  If the process fails and the output was not truncated -> absent.
  Otherwise return the first `min(size, ceiling)` bytes plus `truncated`.

### 2.5 `numberedSnippet(repo, relpath, maxBytes, tree)` -> string

Renders one file with real 1-indexed line numbers, middle-truncated so
both ends stay visible. Never throws; problems render as a notice. Below,
`EM` is U+2014 (em dash); these strings contain it literally in output.

Validation:

- Pinned and `!stagedPathCanonical(relpath)`, or live and
  `resolveLive` rejects:
  `### <relpath>\n(path is outside the repository or invalid)\n`.

Reading, with `readCeiling = 8 * maxBytes`:

- Pinned: `stagedContentCeiling(..., readCeiling)`.
  - Absent, staged tree:
    `### <relpath>\n(not in the index EM staged deletion?)\n`
    (spaces around `EM`).
  - Absent, worktree tree:
    `### <relpath>\n(not in the captured worktree)\n`.
  - Truncated: header is `### <relpath> (<corpus> exceeds <readCeiling>
    bytes; only the first <readCeiling> were read EM true tail NOT shown
    below)` on one line, `<corpus>` = `staged blob` or `captured worktree
    blob`.
- Live: `stat(repo/relpath)` (follows symlinks). Error or not a regular
  file: `### <relpath>\n(deleted or not a regular file)\n`. If size >
  `readCeiling`, read only the first `readCeiling` bytes and set header
  `### <relpath> (file is <size> bytes; only the first <readCeiling> were
  read EM true tail NOT shown below)`. Read errors:
  `### <relpath>\n(read error: <err>)\n`.

Rendering. `lines` = content split on `\n`, with one trailing empty
element dropped (empty content -> no lines). `\r` is kept. A numbered line
is the line number right-aligned to width 5, two spaces, the text
(`%5d  %s`).

- If `byteLength(content) <= maxBytes`: ``### <relpath>\n```\n`` + each
  numbered line + `\n` + ```` ```\n ````.
- Otherwise middle-truncate:
  1. `headBudget = trunc(maxBytes * 0.66)`. Walk lines from the top; a
     line costs `byteLength(line) + 1`; stop before the first line whose
     cost would push the total above `headBudget`. `headLast` is the last
     head line number (0 if none).
  2. `tailBudget = maxBytes - headBudget`. Walk 0-based indices `i` from
     the last line down while `i > headLast` (note: compares a 0-based
     index with a 1-based line number, so the line right after the head
     is never in the tail; keep this), stopping before exceeding
     `tailBudget` with the same cost rule. Reverse into ascending order.
     `tailFirst` = first tail line number, or `lines.length + 1` if none.
  3. If no header was set while reading: `### <relpath> (<n> lines,
     <bytes> bytes EM middle truncated)` with `<n>` = `lines.length` and
     `<bytes>` = byte length of the (possibly ceiling-cut) content.
  4. Output lines: header, ```` ``` ````, head numbered lines, then, if
     `tailFirst > headLast + 1`, the marker
     `       ... (<tailFirst - headLast - 1> lines omitted; real line
     numbers continue below)` (7 leading spaces, one line), tail numbered
     lines, ```` ``` ````, `''`; joined with `\n` (so it ends in
     ```` ```\n ````).

### 2.6 `buildFileContext(repo, files, budget, tree)` -> string

- `files` empty -> `(no files)`.
- For each file in order: `snippet = numberedSnippet(repo, f, 120000,
  tree)`. If `used + byteLength(snippet) > budget`, emit
  `### <f>\n(omitted EM context budget exceeded)\n` instead (it does not
  count against `used`) and continue with the next file (a later smaller
  file can still fit). Else emit the snippet and add its length to `used`.
- Join chunks with `\n`.

The finder's user prompt (prompts area) embeds the post-fit diff and this
file context for diff scopes, built from the scope's file list. For the
`repo` scope (survey mode) the finder gets the scope manifest instead and
no file context. There is no separate file-tree listing; the manifest is
the scope area's.

### 2.7 Exploration tools: common contract

`explorationTools(repo, tree)` returns, in this order, `read_file`,
`list_files`, `grep_repo`. Who gets them (CLI and verify areas): the
finder only in interactive mode; the verifier always.

- Each tool's `run(args)` receives the decoded JSON arguments object and
  always resolves to a plain result object. Every failure the model can
  cause or hit (bad path, bad pattern, missing file, git failure) is a
  result `{"error": "<message>"}`, never a thrown error. Nothing in a tool
  is fatal to the review. (A thrown error or timeout is turned into
  `{"error": ...}` by the agent loop anyway.)
- Results are JSON-encoded by the llm area's single tool-result encoder
  (`spec.md` cross-cutting "JSON encoding"): object keys sorted, no HTML
  escaping of `<>&` or U+2028/U+2029. This area only builds plain result
  objects (keys listed alphabetically below for readability; the encoder
  owns the order). Go encodes a nil string slice as `null`; where that
  happens it is called out.
- `%q` below means Go `strconv.Quote` formatting (double quotes; `\"`,
  `\\`, `\a\b\f\n\r\t\v`, other C0 controls and DEL as `\xNN`, invalid
  UTF-8 bytes as `\xNN`, printable Unicode kept as is). `'%s'` means the
  raw string inside single quotes.

Tool descriptions and schemas are sent to the model verbatim. In the
strings below `\u2014` is an em dash in the actual text.

Corpus sentences, chosen by tree:

```ts
const CORPUS = {
    live: {
        read: 'Reads the working tree of this checkout (tracked plus ' +
            'untracked, non-ignored files; never .git).',
        grep: 'Search the working tree of this checkout (tracked plus ' +
            'untracked, non-ignored files) for a pattern.',
        list: 'Lists tracked plus untracked, non-ignored files in the ' +
            'working tree of this checkout.',
    },
    staged: {
        read: 'This review covers STAGED content, so this reads the git ' +
            'index blob \u2014 exactly what the commit would contain ' +
            '\u2014 NOT the working tree: unstaged edits and untracked ' +
            'files are invisible here, and a path staged for deletion ' +
            'reads as absent from the index.',
        grep: 'Search the git INDEX of this checkout for a pattern ' +
            '\u2014 exactly the content the review covers. Unstaged ' +
            'edits and untracked files are NOT searched.',
        list: 'Lists regular files in the captured git INDEX, not the ' +
            'live working tree.',
    },
    worktree: {  // pinned, not staged
        read: 'Reads the immutable captured worktree used by this run, ' +
            'not later checkout edits.',
        grep: 'Search the immutable captured worktree used by this run, ' +
            'including captured non-ignored untracked files.',
        list: 'Lists regular files in the immutable captured worktree ' +
            'used by this run.',
    },
}
```

Tool definitions (schemas shown as JSON; Go emits object keys sorted):

```ts
read_file: {
    description: 'Read a file from the repository under review. ' +
        corpus.read + ' Use when a finding depends on code you haven\'t ' +
        'seen \u2014 a helper, a type definition, a config, a test. ' +
        'For large files request a window via offset/limit.',
    schema: {
        type: 'object',
        properties: {
            path: {type: 'string', description: 'Repo-relative path.'},
            offset: {type: 'integer',
                description: '1-indexed starting line.'},
            limit: {type: 'integer', description: 'Max lines to return ' +
                '(default 500, at most 2000; output is capped at 65536 ' +
                'bytes).'},
        },
        required: ['path'],
    },
}
list_files: {
    description: 'List files under a repo directory, optionally ' +
        'filtered by glob (e.g. \'*.go\', \'**/*_test.go\'). Returns ' +
        'relative paths. ' + corpus.list,
    schema: {
        type: 'object',
        properties: {
            directory: {type: 'string',
                description: 'Repo-relative directory (default: root).'},
            pattern: {type: 'string', description: 'Optional glob.'},
        },
    },
}
grep_repo: {
    description: corpus.grep + ' Returns matching lines with filenames ' +
        'and line numbers. An empty result is not proof of absence ' +
        '\u2014 it cannot see ignored/generated files, other repos, ' +
        'interface/reflection dispatch, or build-tag-excluded code.',
    schema: {
        type: 'object',
        properties: {
            pattern: {type: 'string', description: 'Search pattern ' +
                '(literal string or Go regexp).'},
            path_glob: {type: 'string', description: 'Optional glob to ' +
                'restrict which files are searched (e.g. \'*.go\').'},
        },
        required: ['pattern'],
    },
}
```

#### `parseOffsetLimit(args)`

Defaults `offset = 1`, `limit = 500`. For each of `offset`, `limit` that
is present and not `null`:

- JSON number: truncate toward zero.
- String: parse like Go `fmt.Sscan` into an int: skip leading whitespace
  (including newlines), optional sign, base prefixes `0x`/`0o`/`0b` and
  `_` separators accepted, digits read as far as they go, trailing junk
  ignored (`"12abc"` -> 12, `"1.5"` -> 1). No digits -> error.
- Any other type (boolean, object, array) -> error.
- Values below 1 become 1.
- Finally each is clamped to at most `MAX_WINDOW` (2^30). This includes
  JSON numbers and numeric strings far beyond 2^63 or `Infinity`-like
  magnitudes: they clamp rather than error (Go's behavior there is
  platform-defined).

Any error -> the tool returns `{"error": "offset and limit must be
integers"}`.

### 2.8 `read_file`

Arguments: `path` (string; a non-string counts as `''`), `offset`,
`limit`.

1. Path check. Pinned: `!stagedPathCanonical(path)`. Live:
   `resolveLive(repo, path)` rejects. Either ->
   `error: path '<path>' is outside the repository or invalid`.
2. Existence, against the corpus being served, before the window is
   parsed:
   - Pinned: `git -C <repo> cat-file -e <oid>:<path>`. Non-zero exit ->
     staged tree: `<path> is not in the index EM staged deletion? this
     review covers the index, not the working tree` (one line; spaces
     around `EM`); worktree tree: `<path> is not in the captured worktree
     for this run`.
   - Live: `stat` of the resolved path (follows symlinks); error or not a
     regular file -> `<path> does not exist or is not a regular file`.
3. `parseOffsetLimit`; `limit = min(limit, 2000)`;
   `end = offset + limit` (first line not in the window).
4. Source. Pinned: spawn `git -C <repo> cat-file blob <oid>:<path>` and
   stream stdout; spawn failure -> `read failed: <err>`. Live: open the
   resolved path; failure -> `read failed: <err>`.
5. Line loop (identical for both corpora). Read one line at a time with
   `readLineCapped(MAX_LINE_BYTES)`: the line is consumed through its
   `\n`, at most 32768 content bytes are kept, `cut` reports discarded
   bytes. Memory stays bounded by the read buffer, even for a
   multi-megabyte single-line blob, and a cut line never swallows the
   following line. For each line read (stop when a read returns no bytes
   at EOF; a final line without `\n` still counts):
   1. `lineNo++`; strip the trailing `\n`.
   2. If `cut`: push `lineNo` onto `truncatedLines` and append
      `  ... (line truncated at 32768 bytes)` to the text. This happens
      for every line read, including lines before `offset` and the line
      at `end`.
   3. If `lineNo >= end`: `moreBelow = true`; stop.
   4. If `lineNo >= offset`: `numbered = %5d  %s`; prefixed with `\n` if
      the body is non-empty. If `body + numbered` would exceed 65536
      bytes: `end = lineNo`, `moreBelow = true`, `outputCapped = true`,
      stop. Else append. (32768 leaves room for at least one line.)
   5. Stop at EOF.
6. Pinned: if `moreBelow`, kill the `cat-file` process; then reap it
   (its exit status is ignored).
7. Trailer, first matching case only:
   - `outputCapped`: `\n... (output capped at 65536 bytes; more lines
     below; request offset>=<end> to continue)`
   - `moreBelow`: `\n... (more lines below; request offset>=<end> to
     continue)`
   - `lineNo === 0`: `\n(file is empty)`
   - `offset > lineNo`: `\n(offset <offset> is past EOF EM file has
     <lineNo> lines)`

   Then, if `truncatedLines` is non-empty: `\n(lines truncated at 32768
   bytes: [<n1> <n2> ...])` (Go `%v` of an int slice: space-separated in
   brackets).
8. Result:

```json
{
  "content": "<body + trailers>",
  "more_below": true,
  "path": "<path as given>",
  "returned_range": [<offset>, <min(end - 1, lineNo)>]
}
```

`returned_range` is a two-element integer array. Past EOF it is
`[offset, lineNo]` with `offset > lineNo`; for an empty file `[offset,
0]`. Example: a file whose first line is 100000 bytes, requested with
`offset 1, limit 3`, returns `[1, 1]` and a trailer naming `offset>=2`.

### 2.9 `list_files`

Arguments: `directory` (string, default `.` when absent or empty),
`pattern` (string, default `*`).

1. `byteLength(pattern) > 256` -> `pattern exceeds 256 bytes`.
2. Pinned: the directory must be `.` or (`stagedPathCanonical` and not
   ending in `/`); else `directory '<dir>' is outside the repository or
   invalid`. Live: see below.
3. Matching a repo-relative path `rel` (slash-separated, relative to the
   repo root, not to `directory`): `globstarMatch(pattern, rel) ||
   (!pattern.includes('/') && globstarMatch(pattern, basename(rel)))`.
4. Hidden: any segment of `rel` starting with `.` is never listed.
5. Accumulation (`listMatches.add`) in iteration order:
   - if 500 entries are already held: append
     `... (truncated at 500 matches)` and stop;
   - else if `bytes + byteLength(rel) + 1 > 65536`: append
     `... (truncated at 65536 bytes after <count> matches)` and stop;
   - else append `rel`, `bytes += byteLength(rel) + 1`.
6. Result `{"directory": <as given or ".">, "matches": [...],
   "pattern": <as given or "*">}`. With zero matches Go emits
   `"matches": null`; keep that.

Live tree:

1. `resolveLive(repo, directory)` rejects -> `directory '<dir>' is
   outside the repository or invalid`. `stat` fails or not a directory ->
   `<dir> does not exist or is not a directory`. Relative-path error ->
   the "outside" message.
2. `relDir` = the resolved directory relative to realpath(`repo`).
   Literal git: `ls-files -z --cached --others --exclude-standard`, plus
   `-- <relDir>` unless `relDir === '.'`. Failure -> `list working tree
   failed: <err>` (`<err>` is the exec error, e.g. `exit status 128`, no
   stderr).
3. `snapshot.denylistedUntracked(repo)`; failure -> `list working tree
   failed: <err>`.
4. For each NUL-separated entry: skip empty, hidden, already seen
   (unmerged paths appear once per stage), denylisted-untracked, not
   matching, or whose `lstat(root/rel)` fails or is not a regular file
   (symlinks, submodules, index entries deleted on disk).
5. Sort byte-wise ascending, then accumulate.

Pinned tree:

1. `git -C <repo> ls-tree -r -z --full-tree <oid>`; failure -> `list
   captured tree failed: <err>`.
2. Each NUL-separated record is `<mode> <type> <object>\t<path>`. Keep
   only mode `100644` or `100755` with type `blob`.
3. If `directory` is not `.`, keep only paths starting with
   `<cleaned directory>/`.
4. Skip hidden, filter by match, accumulate in `ls-tree` order (no extra
   sort).

#### `globstarMatch(pattern, value)`

Split both on `/`. Dynamic programming over segments: a pattern segment
`**` matches zero or more value segments; any other segment matches
exactly one value segment by Go `path.Match` rules: `*` is any run of
non-`/` characters, `?` one non-`/` character (a code point), `[...]` a
class with optional leading `^` negation and `a-z` ranges, `\` escapes
the next character. A malformed segment pattern never matches. Example:
`**/*_test.go` matches `root_test.go`, `one/one_test.go`,
`one/two/two_test.go`, not `one/two/code.go`.

### 2.10 `grep_repo`

Arguments: `pattern` (string, required), `path_glob` (string, optional).

1. `pattern === ''` (or not a string) -> `pattern is required`.
2. Validate the pattern with JS `new RegExp(pattern)`; a throw ->
   `invalid pattern: <message>`. The message text differs from Go's RE2
   text and that is accepted. A pattern that passes this check but that
   `git grep -E` (POSIX ERE) rejects reaches step 5 and is reported to the
   model as `grep failed: ...`; git's stderr is the model's feedback for
   any remaining error.
3. Command, `git -C <repo> grep -n --no-color`, then:
   - live only: `--untracked` (tracked plus untracked files; it still
     honors `.gitignore`, so ignored build output is not searched);
   - `-E -e <pattern>`;
   - pinned only: `<oid>` (tree-ish after the pattern, before `--`);
   - `--`;
   - `<path_glob>` if non-empty (a Git pathspec; it is not made literal);
   - live only: `snapshot.denylistedUntracked(repo)` (failure -> `grep
     failed: <err>`); if non-empty and no `path_glob`, add `.`; then one
     `:(exclude,literal)<p>` per denied path.

   The environment is the inherited one plus a forced
   `GIT_LITERAL_PATHSPECS=0` (deliberate change 10): a user-exported
   `GIT_LITERAL_PATHSPECS=1` would turn the `:(exclude,literal)` entries
   into plain paths and let denylisted untracked files be searched. The
   forced value is set for live and pinned calls alike. Spawn failure ->
   `grep failed: <err>`.
4. Stream stdout. `prefix` = `<oid>:` when pinned, else `''`. For each
   line, read with `readLineCapped(byteLength(prefix) + 2048)`:
   1. Strip the trailing `\n`, then strip `prefix` if present (so pinned
      matches read `path:line:text`, the same shape as live).
   2. If the read was cut or the line is longer than 2048 bytes: keep the
      first 2048 bytes and append ` ... (line truncated)`.
   3. Skip empty lines.
   4. If 200 matches are held: append `... (truncated at 200 matching
      lines)`, mark capped, stop.
   5. If `used + byteLength(l) + 1 > 65536`: append `... (truncated at
      65536 bytes after <count> matching lines)`, mark capped, stop.
   6. Append; `used += byteLength(l) + 1`.
5. If capped, kill git and ignore its exit status. Otherwise: exit code 1
   -> the zero-match result; another failure -> `grep failed: <exec
   err>: <trimmed stderr>` (`<exec err>` like `exit status 128`).
6. Exit 0 but no usable lines -> the zero-match result.
7. Otherwise `{"matches": [...], "pattern": <pattern>}`.

Zero-match result (only on the zero-match path):

```json
{
  "matches": [],
  "note": "<NOTE>",
  "pattern": "<pattern>",
  "searched": "<SEARCHED>"
}
```

`<SEARCHED>`:

- live: `tracked + untracked (non-ignored) files in the working tree of
  this checkout`
- staged: `the git INDEX of this checkout EM the staged content this
  review covers, NOT the working tree`
- captured worktree: `the immutable captured worktree used by this run`
- then, if `path_glob` is non-empty: `, restricted to path_glob %q`.

`<NOTE>`, with `<BLIND>` = `unstaged working-tree edits, untracked files,
` for a staged tree and empty otherwise:

```ts
'No matches. This is NOT proof the symbol is absent or unused: this ' +
'search cannot see ' + BLIND + '.gitignore\'d or generated files, ' +
'other repositories, calls made through an interface, embedding, ' +
'reflection, or a struct/func value, code behind build tags, or a ' +
'name spelled differently at the call site. Do not cite an empty grep ' +
'as grounding for \'no callers\' / \'never invoked\' / ' +
'\'unreachable\' / \'dead code\'. If a verdict or a severity downgrade ' +
'depends on such a claim, establish it positively or report ' +
'insufficient_context.'
```

### 2.11 Quote grounding

`newQuoteGrounder(repo, tree, diff)` returns `ground(file, quote)` ->
boolean. The CLI builds it with the scope's diff (a `Buffer`, exactly the
bytes git printed) before `scope.fit` truncates it (a quote from past the
truncation point is still grounded). `review.validate` drops a finding
whose quote does not ground (`DropUngroundedCodeQuote`, review area).

The corpus is exactly what the finder could have seen for the cited file,
no wider and no narrower. Corpora are keyed by the cited path exactly as
given; no path normalization.

`ground(file, quote)`:

1. `nq = normalizeWS(quote)`. If `nq` is empty or contains NUL -> false.
2. File corpus match (below) -> true.
3. `diffCorpora[file]` contains `nq` -> true; else false.

Matching is on bytes, as in Go. The quote arrives as a string from the
llm area (lone surrogates already U+FFFD) and is UTF-8 encoded; file and
diff bytes keep invalid UTF-8 as is. The scope area must hand the diff over
as a `Buffer` so a diff containing invalid UTF-8 grounds exactly as in Go
(`spec.md` cross-cutting "Bytes and text").

#### `normalizeWS`

Collapse every whitespace run to one space and trim both ends, exactly
like Go `strings.Join(strings.Fields(s), " ")`. Whitespace is Go
`unicode.IsSpace`: ASCII `\t \n \v \f \r` and space, U+0085, U+00A0,
U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. Not JS
`\s` (which adds U+FEFF and lacks U+0085). NUL is not whitespace. Invalid
UTF-8 bytes are kept as bytes, not treated as whitespace. A streaming form
(`WsNormalizer.write(chunk, final)`) carries an incomplete UTF-8 sequence
across chunks and must produce byte-identical output to the whole-string
form for any chunking.

#### File corpus

`fileSource(repo, tree, file)`:

- Pinned: magic -> not in corpus. `git -C <repo> cat-file -s
  <oid>:<file>`; failure or unparsable size -> not in corpus. The opener
  streams `git -C <repo> cat-file blob <oid>:<file>`; its cleanup kills
  and reaps the process.
- Live: `resolveLive` rejects -> not in corpus. `stat` error or not a
  regular file -> not in corpus. The opener opens the file.

Matching, with a per-grounder cache keyed by `file`:

1. Cached -> `cache[file].includes(nq)`.
2. Not in corpus or the opener fails -> cache `''`, return false.
3. Size > 8 MiB -> stream the content through the normalizer in 64 KiB
   reads, keeping only the last `byteLength(nq)` normalized bytes between
   reads, and return whether `nq` appears. Not cached (re-streamed per
   call), so a huge file stays groundable with bounded memory.
4. Otherwise read up to 8 MiB, normalize, cache, test. A read error
   returns false without caching.

#### Diff corpora: `splitDiffByFile(diffText)`

1. Empty text -> no corpora.
2. Split into sections: a section ends just after the `\n` that precedes
   each `\ndiff --git ` occurrence. Text before the first `diff --git` is
   its own section.
3. `sectionPaths(section)`: walk lines (split on `\n`). Once a line starts
   with `@@`, the rest of the section is hunk content and is not parsed
   for headers (so a deleted line `-- a/other.go`, rendered `--- a/other.go`,
   cannot steal the key). Before that:
   - `--- ` + path, where path may be C-quoted (`"a/f\303\266.go"`,
     decoded with Go `strconv.Unquote` rules: the whole remainder must be
     one quoted string; `\a\b\f\n\r\t\v\\\"`, octal `\ooo`, `\xNN`,
     `\uNNNN` escapes; bytes decoded as UTF-8), then prefix `a/` cut ->
     push path.
   - else `+++ ` + path, prefix `b/` -> push unless equal to the last
     pushed path.
   - `/dev/null` and unparsable quoting yield nothing.
4. A section with no paths contributes nothing (fail closed).
5. `normalizedDiffSides(section)` builds two normalized streams, `old`
   and `new`, each with its own streaming normalizer and an `any` flag:
   - line starts with `@@`: for each side whose `any` is set, write
     `\n\x00\n` through that side's normalizer (a sentinel; `any` is not
     reset); then `inHunk = true`.
   - line starts with `diff --git `: `inHunk = false`.
   - not in a hunk, or empty line: ignore.
   - first byte ` `: rest of line + `\n` to both sides, both `any = true`.
   - `-`: to `old` only; `+`: to `new` only.
   - anything else (`\ No newline at end of file`): ignored.
   - Finish both normalizers. Corpus = `old` if `new` is empty, `new` if
     `old` is empty, else `old + ' \x00 ' + new`.

   Keeping sides apart rejects hybrid quotes spliced from a `-`/`+`
   interleave, and admits an old-side multiline quote whose lines have
   new-side lines between them.
6. For each path of the section, add the corpus under that key (skip an
   empty corpus); a key that already has a corpus is joined as
   `prev + ' \x00 ' + norm`. Both old and new paths are keys, so a quote of
   deleted code grounds under the file's name.

#### Grounding guarantees (from the tests)

- `.git/config`, ignored, and untracked denylisted files never ground,
  even with the exact text; untracked non-ignored files do.
- A staged tree grounds against the index blob only, never the worktree;
  it also grounds against the staged diff.
- `0:foo.go` or `./foo.go` never ground against `foo.go`'s content.
- A quote at the end of a 16 MiB file grounds; an absent one does not.

### 2.12 Security hardening summary

Every item below is pinned by a Go test (section 5).

1. One review, one tree: all readers take the same `Tree`; a pinned tree
   is an object ID, never a ref, so concurrent `git add` or checkout edits
   do not change what is served. Under `GIT_INDEX_FILE` (the gate), the
   pinned index is the hook's temporary index, not the live one.
2. Live-tree confinement: no `.git` (any case, via `..`, or via a symlink
   into it), no ignored files, no untracked denylisted files; `check-ignore`
   failure fails closed. `list_files` asks Git for the file list instead
   of walking the disk, so ignored files never surface even by name.
3. Pinned-tree spelling: only canonical index paths reach `cat-file`, so
   stage selectors, `:/` commit search, and `./` aliases cannot return
   content under a fabricated key.
4. Pathspec safety: model paths follow `--`; live path checks use literal
   pathspecs (or `./` for `check-ignore`); `grep_repo` forces
   `GIT_LITERAL_PATHSPECS=0` so the denylist exclusions stay magic.
5. Bounded output and memory: every tool result is capped at 64 KiB plus a
   short trailer; long lines are cut without buffering the whole line;
   blob readers kill the child process instead of draining it.
6. Honest absence: a zero-match grep says which tree was searched and
   that an empty result is not proof of absence.

## 3. TypeScript module design

Directory `src/context/`. All functions that run git or read files take
an `AbortSignal` (Go ignores cancellation here; TS kills every git child
process on abort, per `spec.md` "Process lifetime", so none outlives the
review or a timed-out tool call).

`src/context/tree.ts`

```ts
export type Tree = {readonly oid:string; readonly worktree:boolean}
export const LIVE_TREE:Tree
export function pinned (t:Tree):boolean
export function staged (t:Tree):boolean
export function pinnedWorktree (oid:string):Tree
export function pinIndexTree (repo:string, signal:AbortSignal):
    Promise<Tree>  // throws Error with the messages in 2.2
```

`src/context/git.ts` -- process helpers shared by this area.

```ts
// execFile('git', ['-C', repo, ...args]); env = process.env + extra
export function git (repo:string, args:string[], opts?:{
    env?:Record<string, string>; literal?:boolean; signal?:AbortSignal
}):Promise<{code:number; stdout:Buffer; stderr:string}>
// every spawned child is killed when opts.signal aborts
// spawn with streamed stdout; kill() is safe after exit
export function gitStream (repo:string, args:string[], opts?:{...}):{
    stdout:AsyncIterable<Buffer>; kill():void
    done:Promise<{code:number|null; stderr:string}>
}
// read up to limit bytes, probe one more, kill if more remains
export function gitCapped (repo:string, args:string[], limit:number,
    signal?:AbortSignal):Promise<{ok:boolean; out:Buffer;
    truncated:boolean}>
```

`src/context/lines.ts` -- `LineReader` over a byte stream with
`readLineCapped(cap):Promise<{line:Buffer; cut:boolean; eof:boolean}>`
(consumes through `\n`, keeps at most `cap` content bytes, never
accumulates more). Used by `read_file` and `grep_repo`.

`src/context/paths.ts`

```ts
export function resolveUnderRepo (repo:string, p:string):string|null
export function resolveLive (repo:string, p:string,
    signal?:AbortSignal):Promise<string|null>
export function stagedPathCanonical (p:string):boolean
```

`src/context/snippet.ts`

```ts
export function numberedSnippet (repo:string, relpath:string,
    maxBytes:number, tree:Tree):Promise<string>
export function buildFileContext (repo:string, files:string[],
    budget:number, tree:Tree):Promise<string>
```

`src/context/tools.ts`

```ts
export function explorationTools (repo:string, tree:Tree):Tool[]
```

`Tool` is the LLM area's type: `{name:string; description:string;
schema:object; run(args:Record<string, unknown>,
signal:AbortSignal):Promise<unknown>}`. Tool bodies live in
`read-file.ts`, `list-files.ts`, `grep.ts`; each returns a plain object.
Key order and JSON text are the llm area's encoder's job.

`src/context/glob.ts` -- `globstarMatch(pattern, value)` and a Go
`path.Match` port (`goPathMatch`, returns false on a malformed pattern).

`src/context/normalize.ts` -- `normalizeWS(buf:Buffer):Buffer` and
`class WsNormalizer {write(chunk:Buffer, final:boolean):Buffer}`,
byte-level (git output stays `Buffer`; see section 2.11).

`src/context/grounding.ts`

```ts
export type Grounder = (file:string, quote:string) => Promise<boolean>
export function newQuoteGrounder (repo:string, tree:Tree,
    diff:Buffer):Grounder
export function splitDiffByFile (diff:Buffer):Map<string, Buffer>
```

The grounder is async, so `review.validate` (review area) awaits it.

Shared helper (likely `src/util/goquote.ts`, owned with other areas):
`goQuote(s:string):string` reproducing `strconv.Quote` for `%q`.

Dependencies:

- `src/llm` -- the `Tool` type only.
- `src/scope` -- the diff as a `Buffer` (the grounder's input).
- `src/snapshot` -- `isDenylisted(path)` and
  `denylistedUntracked(repo)` (untracked, non-ignored paths from
  `git ls-files --others --exclude-standard -z` that match the default
  denylist, case-folded, by basename or full path, sorted).
- Callers: `src/cli` (tree choice, file context, grounder, tools),
  `src/verify` (tools, verifier snippet via the CLI's prompt builder),
  `src/review` (grounder), `src/snapshot` (reuses `pinIndexTree`'s OID).

## 4. Deliberate changes

Applied from `spec.md` "Deliberate changes" and "Cross-cutting rules":

- Change 23: the `git_diff` tool and the grounder's range corpus are not
  ported (`explorationTools` returns three tools; `newQuoteGrounder` takes
  no range).
- Change 10: `grep_repo` forces `GIT_LITERAL_PATHSPECS=0`.
- Change 24 is not exercised here (names come from `-z` lists in scope).
- `grep_repo` validates patterns with JS `new RegExp`; error text differs
  from Go and git reports any other error back to the model.
- `parseOffsetLimit` clamps huge values to 2^30.
- Git output is `Buffer`; decoding with U+FFFD only for model-facing
  text; the diff reaches the grounder as `Buffer`.
- Tool-result JSON is encoded by the llm area (sorted keys, no HTML
  escaping).
- Every git child process is killed on abort.
- Model-facing em dashes (tool descriptions, trailers, `searched` text)
  are kept, written as `\u2014` escapes in TS source; this doc and code
  comments never contain the character.

Windows-only concerns in the Go code (case-insensitive `.git`
segments are still needed on macOS) stay. Debug tracing (`roast:context`)
may log tool names, paths, and result sizes, never file content, match
lines, or quotes.

## 5. Test plan

Seams. Most tests here need a temporary Git repository and call the area's
functions directly (module seam): the tools' guarantees are about bytes
and bounds that are expensive to observe through a whole review. A
handful of CLI-seam tests (in-process `run`, fake inference server that
scripts tool calls and records the tool results it receives) prove the
wiring: the finder in interactive mode and the verifier receive the three
tools, results reach the model, and a staged review serves the index.
Assert on result objects (`error` present or absent, `more_below`,
`returned_range`, match membership, sizes, truncation markers), not on
whole human-readable strings.

Path confinement

- Empty, absolute, `..`, nested `..`, and symlink-out paths are rejected;
  normal paths and `.` accepted (TestResolveUnderRepo_PathEscape).
- Live tree serves only the review corpus: `read_file`,
  `numberedSnippet`, grounder, `grep_repo`, `list_files` never expose
  `.git/config`, `.GIT/config`, `.Git/HEAD`, `gitlink/config`, `.env`,
  `build/out.go`, `credentials.json`, `./.git/config`,
  `a/../.git/config`; tracked, untracked non-ignored, and tracked
  denylist-shaped files are served; `list_files` refuses `.git`,
  `build`, `gitlink` as directories
  (TestLiveTreeServesOnlyTheReviewCorpus).
- What the live guard blocks is exactly what pinning leaves out
  (TestPinnedTreeLeavesOutWhatTheLiveGuardBlocks).
- Pinned reads reject `0:foo.go`, `1:foo.go`, `/foo.go`, `:foo.go`, `''`,
  `./foo.go`, `../foo.go`, `sub/../foo.go`, `sub//foo.go`, `foo.go/.`;
  the grounder does not ground them; `read_file` errors
  (TestStagedContentRejectsGitRevisionMagic).

Tree selection

- Staged readers serve the index, not the worktree
  (TestReadFileTool_StagedServesIndexNotWorktree,
  TestNumberedSnippet_StagedVsWorktree,
  TestGrepRepoTool_StagedSearchesTheIndex).
- Staged deletion is named as absent from the index
  (TestReadFileTool_StagedDeletionIsNamedNotJustAbsent).
- Captured-worktree readers ignore later checkout edits
  (TestCapturedWorktreeReadersIgnoreLaterCheckoutEdits).
- Under `GIT_INDEX_FILE`, all staged sources agree on the hook's index
  (TestStagedContextSourcesAgreeUnderGitIndexFile).
- Concurrent index writes after pinning are invisible
  (TestStagedReadersSeeOneTreeUnderConcurrentIndexWrites).
- Tool descriptions name the tree they serve
  (TestExplorationToolDescriptionsDiscloseTheirTree; assert the three
  variants differ per tree, not their text).

File context

- Middle truncation keeps both ends with real line numbers
  (TestNumberedSnippet_Truncation); the captured-worktree ceiling header
  names its corpus (TestNumberedSnippetCapturedWorktreeTruncationLabel).
- Budget fitting omits files that do not fit and continues
  (TestBuildFileContext_BudgetFitting); empty list -> `(no files)`
  (TestBuildFileContext_Empty).

read_file

- Windowing, `more_below`, past-EOF (TestReadFileTool_Windowing).
- String offsets/limits are coerced (TestReadFileTool_StringIntCoercion).
- Staged windowing and pathological lines behave like live
  (TestReadFileTool_StagedWindowingAndPathologicalLines).
- A cut line does not swallow the next line
  (TestLongLineDoesNotSwallowTheNextLine).
- Huge single-line and huge multi-line blobs are not buffered whole
  (TestReadFileToolDoesNotBufferAWholeSingleLineBlob,
  TestReadFileToolDoesNotBufferWholeBlob). TS: assert the result is
  bounded and, through an injectable spawn, that the child was killed
  rather than measuring heap.

list_files

- Hidden directories are skipped (TestListFilesTool_HiddenDirSkip).
- The 500-entry cap adds a marker (TestListFilesTool_Cap).
- `**` matches every depth (TestListFilesGlobstarMatchesEveryDepth).

grep_repo

- Literal match, invalid regexp error, no-match result
  (TestGrepRepoTool_LiteralMatch, TestGrepRepoTool_InvalidRegexp,
  TestGrepRepoTool_NoMatch).
- Live grep sees untracked files under review and still honors
  `.gitignore` (TestGrepRepoTool_SeesUntrackedFilesUnderReview,
  TestGrepRepoTool_StillHonorsGitignore).
- Zero matches carry `note` and `searched`, and `searched` differs per
  tree (TestGrepRepoTool_ZeroMatchesCarriesAbsenceCaveat,
  TestGrepRepoTool_ZeroMatchesNamesWhichTreeWasSearched).
- Pinned matches are not OID-prefixed
  (TestGrepRepoTool_StagedMatchesAreNotOIDPrefixed).

Bounds (hardening)

- Every tool result stays within 65536 bytes plus 512 bytes of trailer
  for wide, tall, minified, and many-match files and for 400 long paths,
  on both live and pinned trees; `wide.txt` with `limit 3` returns
  `returned_range [1, 1]` and resumes at `offset>=2`; grep and list mark
  truncation (TestToolResultsAreBounded).

Grounding

- Exact and whitespace-variant quotes ground; deleted code grounds via
  its own file's section; diff content does not ground another file;
  hybrid `-`/`+` quotes do not ground; old-side multiline quotes across an
  interleave do; confabulated, empty, and NUL-carrying quotes do not;
  header-shaped hunk lines do not steal the key; git-quoted paths key
  their section (TestQuoteGrounder).
- Staged corpus is the index only, plus the staged diff
  (TestQuoteGrounderStagedCorpusIsTheIndex,
  TestQuoteGrounderStagedAdmitsTheDiff).
- A diff containing invalid UTF-8 bytes grounds a quote with the same
  bytes and does not ground a quote with U+FFFD in their place (the diff
  is a `Buffer`; new, no Go twin).
- The normalizer equals the `strings.Fields` definition, including
  non-ASCII whitespace and invalid UTF-8, and the streaming form equals
  the whole form under random chunking (TestNormalizeWSMatchesFields).
  Port as a property test with a reference implementation.
- `normalizedDiffSides` equals a straightforward reference
  (TestNormalizedDiffSidesMatchesReference); property test.
- Huge files ground at the end without holding the file; a 1M-line diff
  grounds (TestGrounderBoundsHugeFiles). TS: drop the allocation
  assertions, keep the correctness ones.

Added for deliberate changes and cross-cutting rules (no Go twin)

- `grep_repo` with `GIT_LITERAL_PATHSPECS=1` exported in the parent
  environment still excludes untracked denylisted files on a live tree
  (spawn through an injectable seam and assert the child environment has
  `GIT_LITERAL_PATHSPECS=0`, plus a behavior check against a real repo).
- Invalid patterns (`(`, `[a`) return `invalid pattern`; a pattern valid
  for `new RegExp` but rejected by `git grep -E` returns `grep failed`
  with git's stderr; assert on the `error` key, not its text.
- `offset` and `limit` of `1e30`, `"99999999999999999999"`, and
  `9007199254740993` clamp to 2^30 without an error; zero and negative
  values become 1.
- Aborting the signal kills the child of a streamed `read_file`,
  `grep_repo`, and a blocking `cat-file -s`, observed through the
  injectable spawn.
- Tool results with `<`, `>`, `&`, U+2028 in file text reach the model
  unescaped, with sorted keys (assert at the CLI seam on the recorded
  request; the encoder itself is tested in the llm area).
- `explorationTools` returns exactly `read_file`, `list_files`,
  `grep_repo`.

## 6. Go baseline references

At commit `cd08f10`:

- `internal/context/context.go` -- constants, `ResolveUnderRepo`,
  `resolveLive`, `liveCorpusAllows`, `StagedContent`,
  `stagedContentCeiling`, `stagedPathIsMagic`, `NumberedSnippet`,
  `BuildFileContext`, `ExplorationTools`, `GitDiffTool` (not ported), the
  tool bodies, `readLineCapped`, `globstarMatch`, `noGrepMatches`,
  `parseOffsetLimit`.
- `internal/context/grounding.go` -- `NewQuoteGrounder`, `fileSource`,
  `cappedOutput`, `streamContains`, `splitDiffByFile`, `sectionPaths`,
  `cutDiffPath`, `normalizedDiffSides`, `normalizeWS`, `wsNormalizer`.
- `internal/context/tree.go` -- `Tree`, `PinnedWorktree`,
  `PinIndexTree`.
- Tests: `internal/context/context_test.go`, `gitdiff_test.go`,
  `grounding_test.go`, `hardening_test.go`, `list_files_test.go`.
- Callers consulted: `internal/cli/cli.go` (tree choice, budgets
  400000/100000, snippet sizes 120000/60000, grounder built pre-fit with
  empty range, tool wiring), `internal/llm/agent.go` (results JSON-encoded,
  errors become `{"error": ...}`), `internal/review/review.go`
  (`Validate` drop order), `internal/scope/scope.go` (`PatchFlags`),
  `internal/snapshot/snapshot.go` (denylist).

## 7. Resolved

1. `git_diff` and the grounder's range corpus are not ported; they are
   absent on purpose (`spec.md` deliberate change 23).
2. `grep_repo` patterns are validated with JS `new RegExp`; different
   error text is accepted and git reports any remaining error to the model
   (maintainer decision, section 2.10).
3. Git output is `Buffer`; decode with U+FFFD only for model-facing text,
   so scope hands the diff over as a `Buffer` (`spec.md` cross-cutting
   "Bytes and text").
4. `grep_repo` forces `GIT_LITERAL_PATHSPECS=0` in the child environment
   (`spec.md` deliberate change 10), with a test.
5. Huge `offset` and `limit` numbers are clamped to 2^30 (`MAX_WINDOW`).
6. Tool-result JSON is encoded by the llm area's encoder: sorted keys, no
   HTML escaping (`spec.md` cross-cutting "JSON encoding").
