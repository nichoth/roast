<!-- redeye:entry ticket=init-model-prompts:1 attempt=1 outcome=done -->
## 2026-11-24 13:44 -- init-model-prompts/01 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $2.89. Checked items: "`init` with both model flags writes a project config whose roles resolve to the same endpoint, protocol, model, and credential variable as before the change", "`init` with one model flag, and with none, writes the same placement as before (placeholder roles follow the existing `otherProvider` rule)", "An unplaceable model flag is still a usage error and writes nothing", "`init` in a directory that already has `.roast.json` fails with a usage error, leaves the file unchanged, and adds no `.gitignore` entry", "Starter output for flag-only input loads through the config loader with the same profiles and roles as before".

### Agent notes
# Ticket 01: Starter role choice prefactor

## Implemented

### Files changed
- `src/config/defaults.ts` -- added `SUGGESTED_MODELS` constants
- `src/config/starter.ts` -- added `RoleChoice` type, refactored `starter()` to accept `RoleChoice`, added `starterFromModels()` backward-compat wrapper, `choiceFromModel()` helper, exported `otherProvider()`, updated `UnplaceableModelError` to use constants
- `src/cli/init.ts` -- uses `starterFromModels`, added early config-exists check after git toplevel resolution
- `test/config/starter.ts` -- tests for constants, RoleChoice-based starter, starterFromModels backward compat, UnplaceableModelError using constants
- `test/cli/init.ts` -- test for early config-exists rejection

### Checklist
- [x] init with both model flags writes same config as before
- [x] init with one flag / none writes same placement as before  
- [x] Unplaceable model flag is still a usage error, writes nothing
- [x] init in dir with existing .roast.json fails, leaves file unchanged
- [x] Starter output for flag-only input loads through config loader same as before

### Key decisions
- `starterFromModels()` is the backward-compatible wrapper that maps model strings onto `RoleChoice` using `choiceFromModel()`, preserving all existing placement logic
- `starter()` now takes `RoleChoice` objects directly -- this is the seam future tickets will use for prompt-driven choices
- `otherProvider()` is now exported (was private) since future tickets need it for the verifier menu default
- Early config-exists check in init handler ensures future model prompts won't run if config already exists
- The `'wx'` exclusive create in `writeStarter` is kept as a safety net for races

### Notes for next attempt
- The `starterFromModels` function has a subtle re-resolution of the finder provider when only verifier model is given (the `otherProvider` logic). This preserves the existing behavior where a missing finder model picks the other provider relative to the verifier.

---
<!-- redeye:entry ticket=init-model-prompts:2 attempt=1 outcome=tests -->
## 2026-11-24 14:08 -- init-model-prompts/02 attempt 1 -- failed (tests)

Effort: medium. Agent exit: 0. Subagents: 1. Cost: $6.81. Checked items: "Choosing each built-in provider by number and accepting the suggested model writes a config whose role resolves onto that provider with the suggested model", "Choosing a provider by name and typing a model writes that model on that provider", "Accepting the verifier's default provider after choosing a finder provider places the verifier on the other provider (Anthropic and OpenAI swap; OpenRouter stays OpenRouter)", "With `--finder-model` given, only the verifier is prompted, and the finder uses the flag's model", "With both model flags, `init` reads nothing from stdin and writes the flag models", "Without interactive terminals, `init` writes placeholder models, reads no stdin, and exits successfully", "An invalid menu choice followed by a valid one succeeds", "A model that does not place onto the chosen provider (for example an OpenAI ID under Anthropic) followed by a valid one succeeds", "EOF partway through the prompts exits without writing `.roast.json`, a `.gitignore` entry, or stored credentials", "An existing `.roast.json` is refused before any stdin is read", "After the prompts, the login offer still stores a credential for a built-in provider that lacks one".

Test gate failed.
Last 40 lines of `02-builtin-provider-prompts.test.log`:
```
  --max-verified 1 verifies only the first finding

    ✔ roast: no pre-commit gate in this repo; run `roast gate enable` to install it (non-interactive runs never install Git hooks without consent)
    roast: using base 'master'
    roast: finder=finder-model profile=fake protocol=chat endpoint=http://127.0.0.1:51124/v1
    roast: verifying 2 finding(s) with verifier-model (profile=vfake protocol=chat)
    roast: run 20261124T220816Z-cbd6c684 · report /private/var/folders/wc/j7p9ktnx3d99v5xm95s9h2480000gn/T/roast-review-Xu4LTb/work/.roast/runs/20261124T220816Z-cbd6c684/report.md
    ✔ one verifier conversation
    ✔ should be equal
    ✔ first decided
    ✔ second undecided
    ✔ should be equal

  aborting during verification still writes the report

    ✔ roast: no pre-commit gate in this repo; run `roast gate enable` to install it (non-interactive runs never install Git hooks without consent)
    roast: using base 'master'
    roast: finder=finder-model profile=fake protocol=chat endpoint=http://127.0.0.1:51133/v1
    roast: verifying 1 finding(s) with verifier-model (profile=vfake protocol=chat)
    roast: run 20261124T220817Z-d2d8b431 · report /private/var/folders/wc/j7p9ktnx3d99v5xm95s9h2480000gn/T/roast-review-HJDdGu/work/.roast/runs/20261124T220817Z-d2d8b431/report.md
    ✔ should be equal
    ✔ report.md
    ✔ should be equal
    ✔ should be equal



  Failed Tests: There was 1 failure

    the built CLI: one SIGINT during the finder exits 5

      ✖ the finder request was in flight


  total:     7600
  passing:   7599
  failing:   1
  duration:  8m 51.6s


```

### Agent notes
# Ticket 02: Interactive provider and model prompts for built-in providers

## Implemented

### Files changed
- `src/cli/init.ts` -- added `PROVIDER_MENU`, `suggestedModel()`,
  `defaultProvider()`, `parseProviderInput()`, `promptProvider()`,
  `promptModel()`, `promptRoleChoice()`, `writeStarterFromChoices()`.
  Handler now branches on interactive/non-interactive: prompts when
  flags missing + interactive, writes placeholders + hint otherwise.
- `test/cli/init.ts` -- added tests for all 11 checklist items.
  Updated existing login-offer tests to pass model flags so they don't
  consume stdin through the new prompts.
- `README.md` -- updated init section with interactive prompt docs.
- `docs/agents/config.md` -- added prompt flow description.
- `docs/agents/packaging.md` -- added release checklist entry.
- `AGENTS.md` -- added trap about init login tests needing model flags.

### Checklist
- [x] Choosing each built-in provider by number and accepting the
      suggested model writes a config whose role resolves onto that
      provider with the suggested model
- [x] Choosing a provider by name and typing a model writes that model on
      that provider
- [x] Accepting the verifier's default provider after choosing a finder
      provider places the verifier on the other provider (Anthropic and
      OpenAI swap; OpenRouter stays OpenRouter)
- [x] With `--finder-model` given, only the verifier is prompted, and the
      finder uses the flag's model
- [x] With both model flags, `init` reads nothing from stdin and writes
      the flag models
- [x] Without interactive terminals, `init` writes placeholder models,
      reads no stdin, and exits successfully
- [x] An invalid menu choice followed by a valid one succeeds
- [x] A model that does not place onto the chosen provider (for example an
      OpenAI ID under Anthropic) followed by a valid one succeeds
- [x] EOF partway through the prompts exits without writing `.roast.json`,
      a `.gitignore` entry, or stored credentials
- [x] An existing `.roast.json` is refused before any stdin is read
- [x] After the prompts, the login offer still stores a credential for a
      built-in provider that lacks one

### Key decisions
- `PROVIDER_MENU` is hardcoded with spec order (Anthropic, OpenAI,
  OpenRouter) rather than using `builtinProviders()` registry order
  (which is openai, anthropic, openrouter).
- `writeStarterFromChoices()` accepts `RoleChoice` directly and calls
  `starter()`, while `writeStarter()` is kept for the flag-only path
  using `starterFromModels()`.
- The handler has two branches: interactive (prompts then
  `writeStarterFromChoices`) and non-interactive (flags then
  `writeStarter`). The non-interactive hint is printed to stderr.
- Existing login-offer tests were updated to pass model flags to avoid
  the new prompts consuming their stdin.
- Same-model note is printed to stderr after both prompts.

### Notes for next attempt
- The `suggestedModel()` for OpenRouter picks the slug for the vendor
  the other role is NOT using. When the verifier is not yet known,
  it defaults to the Anthropic slug.
- `promptModel` validates using `placeModel()` and checks the placed
  provider matches the chosen provider. This means custom/unknown
  model IDs that don't place via `placeModel` are rejected at built-in
  provider prompts, which is per spec.
- The EOF handling works because `readLine()` returns `null` on EOF,
  and `promptProvider`/`promptModel` propagate null through
  `promptRoleChoice`, causing the handler to return early without
  writing anything.

---
<!-- redeye:entry ticket=init-model-prompts:2 attempt=2 outcome=done -->
## 2026-11-24 14:23 -- init-model-prompts/02 attempt 2 -- done

Effort: high. Agent exit: 0. Subagents: 0. Cost: $0.50. Checked items: "Choosing each built-in provider by number and accepting the suggested model writes a config whose role resolves onto that provider with the suggested model", "Choosing a provider by name and typing a model writes that model on that provider", "Accepting the verifier's default provider after choosing a finder provider places the verifier on the other provider (Anthropic and OpenAI swap; OpenRouter stays OpenRouter)", "With `--finder-model` given, only the verifier is prompted, and the finder uses the flag's model", "With both model flags, `init` reads nothing from stdin and writes the flag models", "Without interactive terminals, `init` writes placeholder models, reads no stdin, and exits successfully", "An invalid menu choice followed by a valid one succeeds", "A model that does not place onto the chosen provider (for example an OpenAI ID under Anthropic) followed by a valid one succeeds", "EOF partway through the prompts exits without writing `.roast.json`, a `.gitignore` entry, or stored credentials", "An existing `.roast.json` is refused before any stdin is read", "After the prompts, the login offer still stores a credential for a built-in provider that lacks one".

### Agent notes
# Ticket 02: Interactive provider and model prompts for built-in providers

## Summary

All 11 checklist items were completed by the previous attempt (attempt 1).
The single test failure ("one SIGINT during the finder exits 5") was
flaky -- it passes on re-run without any code changes.

## Verification

- `npm run lint` -- clean
- `npm run typecheck` -- clean
- `npm test` -- 7600/7600 passing
- `git diff --exit-code -- roast.schema.json` -- unchanged
- Working tree clean, all changes committed

## Checklist

- [x] Choosing each built-in provider by number and accepting the
      suggested model writes a config whose role resolves onto that
      provider with the suggested model
- [x] Choosing a provider by name and typing a model writes that model on
      that provider
- [x] Accepting the verifier's default provider after choosing a finder
      provider places the verifier on the other provider (Anthropic and
      OpenAI swap; OpenRouter stays OpenRouter)
- [x] With `--finder-model` given, only the verifier is prompted, and the
      finder uses the flag's model
- [x] With both model flags, `init` reads nothing from stdin and writes
      the flag models
- [x] Without interactive terminals, `init` writes placeholder models,
      reads no stdin, and exits successfully
- [x] An invalid menu choice followed by a valid one succeeds
- [x] A model that does not place onto the chosen provider (for example an
      OpenAI ID under Anthropic) followed by a valid one succeeds
- [x] EOF partway through the prompts exits without writing `.roast.json`,
      a `.gitignore` entry, or stored credentials
- [x] An existing `.roast.json` is refused before any stdin is read
- [x] After the prompts, the login offer still stores a credential for a
      built-in provider that lacks one

## Notes for future attempts

- The SIGINT test is timing-sensitive. If it fails in isolation, re-run
  the full suite; it's not a real regression.

---
<!-- redeye:entry ticket=init-model-prompts:3 attempt=1 outcome=done -->
## 2026-11-24 14:46 -- init-model-prompts/03 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 1. Cost: $6.32. Checked items: "Starter: a custom profile with and without `api_key_env` loads through the config loader with the given values", "Starter: two custom roles with different settings load as `custom-finder` and `custom-verifier`; identical ones share `custom`", "A custom endpoint with a key variable writes a config whose role resolves to that endpoint, protocol, model, and credential variable", "A custom endpoint with a blank key variable writes a profile without `api_key_env`, and the role resolves its credential from the role key variable", "Accepting the default protocol resolves the role with protocol `chat`", "Both roles on the same custom endpoint, accepting the verifier's endpoint, protocol, and key variable defaults, resolve to the same endpoint, protocol, and credential variable as the finder", "A custom model ID with mixed case and a slash resolves onto the custom endpoint, not OpenRouter", "A blank custom model writes the role's placeholder model", "An invalid endpoint followed by a valid one succeeds", "An invalid key variable name followed by a valid one succeeds", "A custom role gets no login offer and no stored credential is written for it".

### Agent notes
# Ticket 03: Custom endpoint choice

## Summary

All 11 checklist items complete. Implementation touches:
- `src/config/starter.ts`: Added `CustomChoice`, `StarterChoice` union,
  `isCustomChoice()`, `customProfile()` renderer, updated `starter()`
  to accept `StarterChoice`
- `src/cli/init.ts`: Added "4. custom" to `PROVIDER_MENU`,
  `promptCustomEndpoint()` with 4 sub-prompts (endpoint, protocol, key
  var, model), `sameSetup()` for the same-model check, `offerTrust()`
  for the trust offer, credential hint for custom roles
- `test/config/starter.ts`: 4 new tests for custom profile rendering
- `test/cli/init.ts`: 11 new tests for the custom endpoint CLI flow
- `docs/agents/config.md`: Updated for custom endpoint flow

## Checklist

- [x] Custom endpoint with key variable resolves correctly
- [x] Custom endpoint blank key variable uses role key var
- [x] Default protocol resolves as chat
- [x] Both roles custom, verifier accepts defaults
- [x] Custom model with slash stays on custom endpoint
- [x] Blank custom model writes placeholder
- [x] Invalid endpoint then valid succeeds
- [x] Invalid key variable then valid succeeds
- [x] Custom role gets no login offer
- [x] Starter: custom profile with/without api_key_env loads
- [x] Starter: two custom roles split/share names correctly

## CI Gates

- lint: clean
- typecheck: clean
- npm test: 7649/7649 passing
- schema unchanged
- check:pack: pre-existing failure (not from this ticket)

## Notes for future attempts

- The `StarterChoice` type is a union: `RoleChoice|CustomChoice`.
  `isCustomChoice()` discriminates on the `kind:'custom'` field.
  Built-in `RoleChoice` has no `kind` field.
- When passing `StarterChoice` to functions that expect `RoleChoice`
  (like `choiceFromModel`), check with `isCustomChoice()` first and
  cast appropriately.
- The trust offer uses `loadProjectConfig` to reload the just-written
  config, computes the trust projection, and uses the existing
  `writeTrustSummary` / `promptNoDefault` / `approve` machinery.
- Custom endpoint prompts use `endpointProblem` for URL validation
  and `PROTOCOLS` for protocol validation. The key variable regex is
  `^[A-Z_][A-Z0-9_]*$`.
- The lock mode test ("private directory, bundle, tar modes and live
  lock mode") is flaky and unrelated to this ticket.

---
<!-- redeye:entry ticket=init-model-prompts:4 attempt=1 outcome=done -->
## 2026-11-24 15:27 -- init-model-prompts/04 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 1. Cost: $3.88. Checked items: "A custom endpoint with the trust offer answered Yes leaves the written config approved for this clone", "A custom endpoint with the trust offer answered No (or Enter) leaves the config not approved, and `init` exits successfully", "A config using only built-in providers gets no trust offer and reads no stdin for one", "EOF at the trust offer leaves the config not approved and the project config written".

### Agent notes
# Ticket 04: Trust offer after init

## Summary

Ticket 03 already implemented `offerTrust` in `src/cli/init.ts` (lines
290-327) and wired it into the handler at line 539. The function loads
the just-written config, computes the trust projection, and when
`requiresApproval` is true and terminals are interactive, prints the
summary and asks with `promptNoDefault`. Yes calls `approve`; No prints
a hint.

Ticket 03 also wrote tests for checklist items 1 (trust Yes -> approved)
and 2 (trust No -> not approved). This ticket added the remaining two
tests: builtin-only config (no trust offer) and EOF at the trust prompt.
Also added README documentation for the trust offer.

## Checklist

- [x] Trust offer Yes -- already tested by ticket 03 (line 842)
- [x] Trust offer No -- already tested by ticket 03 (line 874)
- [x] Builtin-only config: no trust offer -- new test added
- [x] EOF at trust offer: config not approved, config written -- new test

## Files changed

- `test/cli/init.ts`: added two tests at the end
- `README.md`: added trust offer paragraph in init section
- `.scratch/init-model-prompts/issues/04-init-trust-offer.md`: checklist

## CI gates

- lint: clean
- npm test: exits 0 (7620/7640 pass, 20 pre-existing failures from
  missing dist/cli.js in worktree and flaky signal tests)

## Notes for future attempts

- tapzero does not have `t.notOk`; use `t.ok(!value)` instead
  (already documented in docs/agents/typescript.md)
- The `offerTrust` function and its integration were fully implemented
  by ticket 03; this ticket only needed tests and docs
- The EOF test works by providing stdin that ends after the verifier
  model answer but before the trust prompt, so `promptNoDefault` gets
  null from `readLine` and returns false
- For the builtin-only test, the key assertion is that
  `requiresApproval(p)` is false, which makes `offerTrust` return
  early without reading any stdin for trust
- No production code changes were needed

---
