# 40: Prompts, part 3 -- user prompt rendering and Go differential test

**Blocked by:** 03, 09, 39 (runs after 39 so the two do not conflict in
`test/index.ts`)
**Touches:** `src/prompts/render.ts` (`renderFinderUser`,
`renderVerifierUser`, `dataText`, `FinderUserVars`, `VerifierVars`),
`test/prompts/render.ts`, `test/diff/prompts.ts` (temporary),
`test/index.ts`
**Spec:** `spec/08-finder-prompts.md` 2.16, 2.17, 3 (`render.ts`), 5
("Prompts": the render items and the differential item);
`spec/15-packaging.md` 2.13 (Go baseline build); `spec.md` "Testing
Decisions", "Cross-cutting rules" (output strings)
**Status:** done

## What to build

The user prompt half of the prompt layer, with no model calls.

`renderFinderUser` and `renderVerifierUser` are typed TS functions that
reproduce the baseline `finder_user.tmpl` / `verifier_user.tmpl` output
exactly (2.16, 2.17), with `dataText` defanging closing wrapper tags using
RE2 semantics (ASCII `\s`, Unicode simple case folding, ASCII word
boundary) and `formatFixed2` from `gocompat` for confidence. U+2014
characters in copied template lines are written as `—` escapes in
the TS source. They live in `src/prompts/render.ts`, separate from
`finderSystem` / `verifierSystem` in `index.ts` (ticket 39). `index.ts`
may re-export them but must not pass `FinderUserVars` or `VerifierVars`
through a `Record<string, unknown>` helper; a previous attempt failed
typecheck that way.

Temporary differential test (deleted at M6 with the harness): under
`test/diff/`, run by `npm run test:diff`, render both user prompts in Go
and in TS from the same inputs and compare bytes. Reuse ticket 09's
baseline mechanism (worktree at `cd08f10`, `GOFLAGS` removed, cache under
`node_modules/.cache/roast-diff/`) to build a small Go helper that calls
the baseline `prompts.FinderUser` / `prompts.VerifierUser` on JSON input;
skip with a TAP skip when `go` is not on `PATH`, as the harness does.
Inputs must include a hostile case (closing tags in mixed case, `ſ`,
`\v`, `</claimx`), a survey case, and the 0.125-multiple confidence ties.

Suggested order: `dataText` and its unit tests first, then the two
render functions with unit tests, then the differential test last.
Commit after each.

This is the last of three tickets split from the original prompts
ticket. The finder stage (`find`, tool schemas, validation) is ticket 16.

## Acceptance criteria

- [x] `dataText` defangs `</CODE_QUOTE >` and a `ſ`-folded `</claim`,
  and leaves `</\vclaim` and `</claimx` unchanged.
- [x] `renderFinderUser` survey output contains a `<manifest>` block and
  no `<diff>` or `<files>` block; diff output contains `<diff>` and
  `<files>` and no `<manifest>`.
- [x] `renderVerifierUser` output never contains the finder's reasoning
  (the type has no such field) and, for untrusted text containing
  closing tags, each wrapper tag closes exactly once and the final
  instruction line is last.
- [x] The temporary differential test produces byte-identical
  `finder_user` and `verifier_user` renderings from Go and TS for every
  fixture input, and reports a skip (exit 0) when `go` is unavailable.
- [x] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
