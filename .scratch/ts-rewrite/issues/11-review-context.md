# 11: Review context

**Blocked by:** 10
**Touches:** `src/context/` (`tree.ts`, `git.ts`, `lines.ts`,
`paths.ts`, `blob.ts`, `snippet.ts`, `normalize.ts`, `grounding.ts`);
exports `Tree`, `LIVE_TREE`, `pinned`, `staged`, `pinnedWorktree`,
`pinIndexTree`, `resolveUnderRepo`, `resolveLive`,
`stagedPathCanonical`, `numberedSnippet`, `buildFileContext`,
`normalizeWS`, `WsNormalizer`, `Grounder`, `newQuoteGrounder`,
`splitDiffByFile`, `LineReader` (`readLineCapped`), `gitStream`,
`gitCapped`; `test/context/*.ts`, `test/index.ts`
**Spec:** `spec/05-context.md` sections 1, 2.1-2.6, 2.11, 2.12, 3
(except `tools.ts` and the tool bodies), 4, 5 groups "Path confinement",
"Tree selection" (snippet and grounder items), "File context",
"Grounding"; `spec.md` cross-cutting "Bytes and text", "Process
lifetime"
**Status:** done

## What to build

Everything the finder and verifier read from the repository besides the
diff itself, minus the model-callable tools (ticket 12):

- The reviewed tree (`Tree`, live vs pinned index vs captured worktree)
  and `pinIndexTree(repo, signal)`, which writes the current index
  (honoring `GIT_INDEX_FILE`) into a tree object through a temporary
  index copy without touching the live index, refs, or commits.
- Path confinement: `resolveUnderRepo` (the single chokepoint for
  model-supplied live paths, rejecting empty, absolute, escaping, and
  `.git` paths case-insensitively), `resolveLive` (adds the corpus rules:
  untracked denylisted paths and ignored paths are refused, fail closed),
  and the staged-path magic guard for `<oid>:<path>` reads.
- Blob reads from a pinned tree, plain and with a byte ceiling that kills
  the child once it is exceeded.
- `numberedSnippet` (real 1-indexed line numbers, middle truncation that
  keeps both ends, never throws) and `buildFileContext` (budget fitting
  that skips files that do not fit and continues; `(no files)` when
  empty).
- Quote grounding: `normalizeWS` (Go `strings.Fields` whitespace, byte
  level, plus a streaming `WsNormalizer`), the per-file corpus with an
  8 MiB cache ceiling and bounded streaming past it, the diff corpora
  from `splitDiffByFile` on the scope's diff `Buffer`, and
  `newQuoteGrounder(repo, tree, diff)` returning an async `Grounder`.

Seam resolutions: git calls go through the shared runner in `src/git/`
(ticket 03, resolution 1). The streaming helpers this area needs
(`gitStream`, `gitCapped`) are built on top of it in `src/context/git.ts`;
do not add another general-purpose runner. The denylist comes from
`src/snapshot/denylist.ts` (ticket 10). `goQuote` and `isGoSpace` come
from `src/gocompat/` (ticket 03).

Every git child this area spawns is killed when the caller's signal
aborts, including blocking calls (`cat-file -s`, `check-ignore`,
`ls-files`, `write-tree`). Git output stays `Buffer`; decoding with
U+FFFD happens only for model-facing text.

Out of scope: `read_file`, `list_files`, `grep_repo`, and
`explorationTools` are ticket 12. The grounder range corpus and the
`git_diff` tool are not ported (deliberate change 23). The CLI choosing
the tree and calling these functions is ticket 20; `snapshot.pinWorktree`
is ticket 22, so captured-worktree tests build their tree with Git
plumbing directly (temporary index, `add`, `write-tree`).

## Acceptance criteria

Module seam against temporary Git repositories; assert on return values
and booleans, never on whole human-readable strings.

- [x] `resolveUnderRepo` rejects empty, absolute, `..`, nested `..`, and
  symlink-out paths and accepts normal paths and `.`.
- [x] On the live tree, `numberedSnippet` and the grounder never expose
  `.git/config`, `.GIT/config`, `.Git/HEAD`, `gitlink/config` (symlink
  to `.git`), an untracked `.env`, an ignored `build/out.go`, an
  untracked `credentials.json`, `./.git/config`, or `a/../.git/config`,
  while tracked, untracked non-ignored, and tracked denylist-shaped
  files are served.
- [x] What the live guard blocks is exactly what a pinned worktree tree
  leaves out.
- [x] Pinned reads reject `0:foo.go`, `1:foo.go`, `/foo.go`, `:foo.go`,
  `''`, `./foo.go`, `../foo.go`, `sub/../foo.go`, `sub//foo.go`, and
  `foo.go/.`, and the grounder does not ground quotes cited at them.
- [x] `pinIndexTree` returns the index tree without changing the live
  index; under `GIT_INDEX_FILE` the snippet and grounder agree with
  that index; index writes after pinning are invisible to readers.
- [x] A staged `numberedSnippet` serves the index, not the worktree; a
  captured-worktree snippet ignores later checkout edits.
- [x] `numberedSnippet` middle truncation keeps both ends with real line
  numbers, and the captured-worktree ceiling header differs from the
  live one.
- [x] `buildFileContext` omits files that do not fit the budget and
  continues with later ones; an empty list yields the empty marker.
- [x] The grounder grounds exact and whitespace-variant quotes; grounds
  deleted code through its own file's diff section; does not ground diff
  content against another file; does not ground hybrid `-`/`+` quotes;
  grounds old-side multiline quotes across an interleave; rejects
  confabulated, empty, and NUL-carrying quotes; is not fooled by
  header-shaped hunk lines; keys git-quoted paths to their section.
- [x] The staged grounder's corpus is the index plus the staged diff.
- [x] A diff `Buffer` with invalid UTF-8 grounds a quote with the same
  bytes and does not ground one with U+FFFD in their place.
- [x] Property tests: `normalizeWS` equals a `strings.Fields` reference
  (non-ASCII whitespace, invalid UTF-8, NUL not whitespace), the
  streaming normalizer equals the whole form under random chunking, and
  the normalized diff sides equal a straightforward reference.
- [x] A file over 8 MiB grounds a quote at its end, and a 1M-line diff
  grounds, both returning correct results.
- [x] Aborting the signal kills the child of a blocking `cat-file -s`
  and of a streamed blob read (observed through an injectable spawn).
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
  the Go build and Go tests still pass.
