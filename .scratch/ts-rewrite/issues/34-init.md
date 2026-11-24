# 34: `init`

**Blocked by:** 29, 31, 32, 41, 42
**Touches:** `src/config/starter.ts` (`SCHEMA_REF`, placeholder model
constants, `isPlaceholderModel`, `UnplaceableModelError`, `placeModel`,
`starter`), `src/cli/init.ts` (`init` command, `writeStarter`,
`offerLogin`), the shared default constants that both the starter and
`src/cli/` review flags read, `test/config/starter.ts`,
`test/cli/init.ts` (`initLoginRepo`)
**Spec:** `spec/14-doctor-init-skill.md` 2.3 (2.3.1 to 2.3.3), 3
(`src/config/starter.ts`, `src/cli/init.ts`), 5 (init and starter);
`spec/12-gate.md` 2.13 (`ensureStateIgnored` from `init`);
`spec/13-login.md` 2.10; `spec/15-packaging.md` 2.1 rule 4, 5.5
**Status:** done

## What to build

A user starts a project with `npx roast init [--finder-model <id>]
[--verifier-model <id>] [--no-login]`. Roast writes a starter
`.roast.json` in the working directory: exclusive create, never
overwrite, mode 0644, and the absolute path printed. It then adds
`/.roast/` to the toplevel `.gitignore` through `ensureStateIgnored`
from ticket 29. On a terminal, it then offers to log in to each built-in
provider the new config uses that has no credential yet.

Model placement (`placeModel`, 2.3.1):

- A `<vendor>/<model>[:<variant>]` ID goes to OpenRouter.
- A bare ID goes to the provider `inferFamily` names.
- An unplaceable ID is a usage error naming the role, with finder
  checked first and nothing written.

Placeholders are used when no model is given. A placeholder role follows
an OpenRouter role onto OpenRouter, and otherwise takes the other direct
provider. Different models never share a profile. Two OpenRouter models
get the `openrouter-finder` / `openrouter-verifier` profiles.

The starter text (2.3.2) is JSONC with a trailing comma (the config
loader allows it). Its `$schema` points into
`node_modules/@substrate-system/roast/` at `roast.schema.json`. Write it
exactly as the Go baseline writes it: the spec files disagree on whether
it has a leading `./`, and the test only checks the `node_modules/...`
location. The starter shows commented-out defaults. These must be
rendered from, or checked against, the same constants the CLI uses for
its defaults, so they cannot drift.

The login offer (2.3.3) uses `providersNeedingLogin`, `loginPath`, and
`loginProvider` from tickets 31, 42, and 32. It passes one shared `LineReader`
to both `promptYesDefault` and `loginProvider`. It runs only when
`interactiveTerminals` is true and `--no-login` is unset. Nothing in it
changes the exit code.

## Acceptance criteria

- [x] The placement table holds for the unit `starter`. Each output
      parses through the config loader with the expected profile count,
      and different models never share a profile.
- [x] Two OpenRouter models give profiles `openrouter-finder` and
      `openrouter-verifier`. No models give `openai` and `anthropic`.
- [x] Unplaceable models are rejected as either role, and the error
      carries the right role and model.
- [x] `init --finder-model <bare openai id> --verifier-model <bare
      anthropic id>` writes a config. After `trust` where required, a
      review against the fake provider sends each model with the right
      credential.
- [x] An unplaceable `--finder-model` exits 2 and writes nothing.
- [x] With placeholder models, a review fails with exit 2 before any
      request reaches the fake.
- [x] An existing `.roast.json` makes `init` exit 2 and leaves the file
      byte-identical.
- [x] `init` adds `/.roast/` to the toplevel `.gitignore`.
- [x] `$schema` names a `.json` file inside
      `node_modules/@substrate-system/roast/`.
- [x] With terminals simulated, stdin `y` plus a key for each of
      anthropic then openai stores both keys in project scope only. With
      `n` and `n`, nothing is stored, validated, or opened.
- [x] `--no-login` never offers. Without a terminal, `init` never
      prompts.
- [x] A failing login (three rejected keys) still exits 0 and stores
      nothing.
- [x] The starter's commented-out defaults equal the CLI's default
      values: both come from shared constants, or a test parses the
      comments and compares.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
