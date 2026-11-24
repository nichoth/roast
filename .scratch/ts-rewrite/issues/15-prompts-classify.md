# 15: Prompts, part 1 -- mode and language classification

**Blocked by:** 03, 04
**Touches:** `src/review/classify.ts` (`classifyMode`, `classifyLangs`,
`resolveLangs`), `test/review/classify.ts`, `test/index.ts`
**Spec:** `spec/08-finder-prompts.md` 2.11, 2.12, 3 (`classify.ts`), 5
("Classification"); `spec.md` "Testing Decisions"
**Status:** done

## What to build

The classification helpers the finder prompt layer needs, as pure
functions with no model calls and no prompt text.

`classifyMode` and `classifyLangs` use `goExt` from `gocompat` (ticket
03), never `path.extname`, so dotfiles such as `docs/.md` classify like
Go. `resolveLangs` implements the `--lang` rules of 2.12 and throws the
CLI's `UsageError` (ticket 04); wiring it into `review` is ticket 20.

This is the first of three tickets split from the original prompts
ticket. Stay inside `src/review/classify.ts` and its test. Do not create
anything under `src/prompts/`: system prompt assembly is ticket 39 and
user prompt rendering is ticket 40.

Keep the extension and language tables small and flat. A previous
attempt failed typecheck with `TS1117` (duplicate keys in an object
literal) in this file, so build lookup tables from arrays or a `Map`
rather than a hand-written object literal with repeated keys.

## Acceptance criteria

- [ ] `classifyMode` returns `code` for an empty list, `prose` when every
  extension is prose, `mixed` when some are, `code` when none, and
  compares extensions case-insensitively; `docs/.md` counts as prose.
- [ ] `classifyLangs` maps, dedupes, and sorts tags and ignores unknown
  extensions.
- [ ] `resolveLangs` returns `[]` for prose without validating flags,
  auto-classifies with no flag values, returns `[]` for a lone `none`,
  throws `UsageError` for `none` combined with another pack and for an
  unknown pack (case-sensitive, untrimmed), and otherwise keeps flag
  order and duplicates.
- [ ] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
