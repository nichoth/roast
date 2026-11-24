# 12: Repository navigation tools

**Blocked by:** 11, 13
**Touches:** `src/context/tools.ts` (`explorationTools`),
`src/context/read-file.ts`, `src/context/list-files.ts`,
`src/context/grep.ts`, `src/context/glob.ts` (`globstarMatch`),
`src/context/offset-limit.ts` (`parseOffsetLimit`); consumes `Tool` from
`src/llm/types.ts` and `encodeToolResult` from `src/llm/json.ts`
(ticket 13); `test/context/tools-*.ts`, `test/index.ts`
**Spec:** `spec/05-context.md` sections 2.1, 2.7-2.10, 2.12, 3
(`tools.ts`, `glob.ts`), 4, 5 groups "read_file", "list_files",
"grep_repo", "Bounds (hardening)", "Tree selection" (tool items), and
"Added for deliberate changes"; `spec.md` deliberate changes 10 and 23,
cross-cutting "JSON encoding", "Process lifetime"
**Status:** done

## What to build

`explorationTools(repo, tree)` returns exactly three tools, in order:
`read_file`, `list_files`, `grep_repo`. Each has the exact description
and JSON schema from spec 05 section 2.7-2.10 (model-facing em dashes
written as `\u2014` escapes), with corpus sentences chosen by the tree
(live, staged, captured worktree). Each `run(args, signal)` resolves to a
plain result object; every failure the model can cause is an
`{error: ...}` result, never a throw.

- `read_file`: windowed reads (`offset`/`limit` via `parseOffsetLimit`:
  defaults 1/500, string coercion, clamp to 2^30, zero and negatives
  become 1), `returned_range`, `more_below`, per-line cap of 32768 bytes
  without swallowing the next line, streamed so a huge blob is never
  buffered whole, staged reads naming a staged deletion as absent from
  the index.
- `list_files`: hidden directories skipped, `**` globstar matching every
  depth, the 500-entry cap with a truncation marker, refusing `.git`,
  ignored, and symlink-to-`.git` directories.
- `grep_repo`: `git grep -E` over the live tree (tracked plus untracked
  non-ignored files, still honoring `.gitignore`) or the pinned tree
  (matches not OID-prefixed), 200-match and 2048-byte-line caps, an
  `invalid pattern` error for patterns `new RegExp` rejects, a
  `grep failed` error carrying git's stderr otherwise, and a zero-match
  result carrying `note` and a per-tree `searched` text. It always runs
  with `GIT_LITERAL_PATHSPECS=0` in the child environment (deliberate
  change 10), so the secret-file denylist pathspecs cannot be disabled
  from the parent environment.

Every result stays within 65536 bytes of content plus 512 bytes of
trailer. Path checks reuse ticket 11's `resolveLive` and staged-path
guard; streaming reuses ticket 11's `gitStream` / `gitCapped` and
`LineReader`. Every child is killed on abort.

Seam resolution 6: the `Tool` type is the one ticket 13 defines in
`src/llm/types.ts`; this ticket must not define its own. Results are
plain objects; key order and JSON text are the job of the single
tool-result encoder `encodeToolResult` in `src/llm/json.ts`. `goQuote`
for `%q` formatting comes from `src/gocompat/` (ticket 03).

Out of scope: the `git_diff` tool (not ported). Proving at the CLI seam
that the finder and verifier receive these tools and that results reach
the model unescaped with sorted keys lands with review in tickets 20 and
21.

## Acceptance criteria

Module seam (call `tool.run(args, signal)`) against temporary Git
repositories, plus an injectable spawn seam where noted; assert on result
keys (`error` present or absent, `more_below`, `returned_range`, match
membership, sizes, truncation markers), never on whole messages.

- [x] `explorationTools` returns exactly `read_file`, `list_files`,
  `grep_repo`, and the descriptions differ per tree (live, staged,
  captured worktree).
- [x] `read_file` windows correctly, sets `more_below`, handles a window
  past EOF, coerces string offsets and limits, and behaves the same on
  staged and live trees, including pathological lines.
- [x] A cut long line does not swallow the following line.
- [x] A staged `read_file` serves the index rather than the worktree and
  reports a staged deletion as absent from the index.
- [x] `offset`/`limit` of `1e30`, `"99999999999999999999"`, and
  `9007199254740993` clamp to 2^30 without an error; zero and negative
  values become 1.
- [x] Huge single-line and huge multi-line blobs return bounded results
  and the child process is killed rather than drained (injectable
  spawn).
- [x] `list_files` skips hidden directories, matches `**` at every
  depth, caps at 500 entries with a marker, and refuses `.git`, `build`
  (ignored), and `gitlink` (symlink to `.git`) as directories.
- [x] `grep_repo` finds a literal match, returns an `error` for an
  invalid regexp, and returns a no-match result carrying `note` and a
  `searched` value that differs per tree.
- [x] Live `grep_repo` sees untracked files under review and still
  honors `.gitignore`; staged `grep_repo` searches the index and its
  matches are not OID-prefixed.
- [x] With `GIT_LITERAL_PATHSPECS=1` in the parent environment, live
  `grep_repo` still excludes untracked denylisted files, and the spawned
  child's environment has `GIT_LITERAL_PATHSPECS=0`.
- [x] Invalid patterns `(` and `[a` return an `error`; a pattern valid
  for `new RegExp` but rejected by `git grep -E` returns an `error` from
  git's failure.
- [x] No tool on a live or pinned tree serves `.git/config`,
  `.GIT/config`, `.Git/HEAD`, `gitlink/config`, an untracked `.env`, an
  ignored `build/out.go`, or an untracked `credentials.json`.
- [x] Every tool result, encoded with `encodeToolResult`, stays within
  65536 + 512 bytes for wide, tall, minified, and many-match files and
  for 400 long paths on live and pinned trees; `wide.txt` with `limit 3`
  returns `returned_range [1, 1]` and resumes at `offset >= 2`; grep and
  list mark truncation.
- [x] Aborting the signal kills the child of a streamed `read_file` and
  of `grep_repo` (injectable spawn).
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
  the Go build and Go tests still pass.
