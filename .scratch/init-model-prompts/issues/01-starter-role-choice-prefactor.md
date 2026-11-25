# 01: Starter takes a choice for each role; suggested model IDs become shared constants

**What to build:** A prefactor with no change visible to users. `starter()`
takes a choice for each role (a built-in provider plus a model) instead of
two model strings. The flag path in `init` maps `--finder-model` and
`--verifier-model` onto that input through the existing `placeModel` /
`otherProvider` placement, so flag-only and flagless runs render the same
project config as today. Suggested model IDs for each built-in provider
move into the shared defaults module (Anthropic `claude-opus-5-5`, OpenAI
`gpt-6.1-terra`, OpenRouter `anthropic/claude-opus-5-5` and
`openai/gpt-6.1-terra`), and the `UnplaceableModelError` example text uses
those constants so the two cannot drift. `init` checks that the project
config does not exist right after resolving the Git toplevel, before any
other work, and keeps the final exclusive create so a race still fails
safely.

This makes tickets 02 and 03 easy: prompts produce the new per-role choice
and render through the same function as flags.

**Blocked by:** None (can start immediately)

**Touches:** `src/config/starter.ts` (`starter`, `placeModel`,
`UnplaceableModelError`, `otherProvider`), `src/config/defaults.ts` (new
suggested-model constants), `src/cli/init.ts` (`writeStarter`, the
`initCommand` handler), `test/config/starter.ts`, `test/cli/init.ts`

**Status:** done

- [x] `init` with both model flags writes a project config whose roles
      resolve to the same endpoint, protocol, model, and credential
      variable as before the change
- [x] `init` with one model flag, and with none, writes the same placement
      as before (placeholder roles follow the existing `otherProvider`
      rule)
- [x] An unplaceable model flag is still a usage error and writes nothing
- [x] `init` in a directory that already has `.roast.json` fails with a
      usage error, leaves the file unchanged, and adds no `.gitignore`
      entry
- [x] Starter output for flag-only input loads through the config loader
      with the same profiles and roles as before
