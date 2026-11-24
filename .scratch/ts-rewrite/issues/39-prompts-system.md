# 39: Prompts, part 2 -- template assets and system prompts

**Blocked by:** 15 (runs after it so the two do not conflict in
`test/index.ts`)
**Touches:** `src/prompts/index.ts` (`finderSystem`, `verifierSystem`,
internal `loadOverride`), text-asset imports of
`internal/prompts/templates/*.tmpl`, `src/assets.d.ts` (`*.tmpl` already
declared by 01), `test/prompts/system.ts`, `test/index.ts`
**Spec:** `spec/08-finder-prompts.md` 2.13, 2.14, 2.15, 3
(`src/prompts/` templates and `index.ts`), 5 ("Prompts": the system
prompt items and the asset byte test); `spec/15-packaging.md` 2.5 (text
assets); `spec.md` "Testing Decisions", "Cross-cutting rules" (output
strings)
**Status:** done

## What to build

The system prompt half of the prompt layer, with no model calls.

The twelve baseline templates are imported as strings through the esbuild
text loader directly from `internal/prompts/templates/` (they move to
`src/prompts/templates/` only at M6, ticket 37), so the Go embed and the
TS bundle read the same bytes.

`finderSystem(mode, scope, quick, langs, overridePath)` assembles the
base, scope framing, mixed addendum, language addenda, and quick addendum
in the order of 2.13. `mode` is the string `classifyMode` returns and
`langs` is the list `resolveLangs` returns (both ticket 15); this module
takes them as plain values and does not call them.
`verifierSystem(overridePath)` returns the override or
`verifier_system`. Override files are read verbatim (no trimming, no
rendering, no defanging); a read failure is a plain `Error` with the 2.14
prefixes. Callers pass paths already resolved through the config's
`promptPath` (ticket 05); this module does not resolve them.

This is the second of three tickets split from the original prompts
ticket. Do not write `renderFinderUser`, `renderVerifierUser`,
`dataText`, or `src/prompts/render.ts`, and do not import them from
`index.ts`: they are ticket 40. The finder stage (`find`, tool schemas,
validation) is ticket 16.

## Acceptance criteria

- [x] Each of the twelve imported template strings equals the bytes of
  its file under `internal/prompts/templates/` decoded as UTF-8.
- [x] `finderSystem` output contains the expected template assets in the
  expected order for prose, code, and mixed modes in both `diff` and
  `repo` scope (asserted by asset containment and index order, not
  wording); prose diff mode has no diff framing.
- [x] The frontend addendum appears once for `react`, `frontend`, or
  both; the hooks addendum only for `react`; the go addendum only for
  `go`; `web` adds nothing; the quick addendum is always last.
- [x] An override replaces only the base, byte for byte, while scope,
  mixed, language, and quick pieces still appear; a missing override
  file rejects with an `Error` that is not a `UsageError`.
- [x] `verifierSystem` returns the override verbatim when given and the
  `verifier_system` asset otherwise.
- [x] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
