# Config, roles, and providers

`src/config/`, `src/cli/config.ts`, `src/cli/resolve.ts`. Credential
lookup order is in `auth.md`.

## Loading

- `loadConfig(path)` parses `.roast.json` as JSONC with exact-case keys
  and unknown keys rejected. `version: 1` is required; a literal
  `api_key` is rejected. There are no built-in roles or models: a role
  missing from the config fails in `resolveRole`.
- `jsonc.ts` parses into null-prototype objects (`newObject` /
  `setKey`, so `__proto__` is an ordinary key). `schema.ts` (zod) checks
  shape and types only, and `load.ts` keeps the validated *input*, never
  zod's output (zod's record output turns a `__proto__` key into a
  prototype). Range and cross-field checks are plain functions in
  `load.ts` so the Go-era check order holds.
- `findConfig(start, stop)` walks up to `stop` (the Git toplevel),
  comparing directories after `realpath`: macOS temp dirs are
  `/var/...` while `git rev-parse --show-toplevel` prints
  `/private/var/...`.
- The CLI loads config only through `loadProjectConfig(explicit, ctx)`
  (`src/cli/config.ts`), which attaches the stored-credentials store. A
  missing config is a usage error naming `npx roast init`.
- Relative prompt-override paths resolve against the config file's
  directory: read prompts through `promptPath(cfg, ...)`, never the raw
  config string. The trust projection hashes the raw string, so
  approvals survive worktree moves.

## Settings

Only credentials come from outside the config. Every other setting is
in it (`limits`, `interactive`, `gate`, `review.snapshot`); an explicit
0 differs from unset, and `load.ts` checks ranges. The CLI resolves
them with `flagOrConfigInt` / `flagOrConfigDuration` (`resolve.ts`:
flag, then config, then default).

## Schema and starter

- `roast.schema.json` (repo root, shipped through `package.json`
  `files`) is generated: `npm run schema` renders
  `src/config/json-schema.ts` from the zod schema. Adding, removing, or
  retyping a config field changes the zod schema and the config types
  in the same change, then regenerates; never edit the JSON by hand.
  `test/config/schema.ts` fails on drift. Editor-only constraints (enum,
  pattern, minimum, required) go in the zod `.meta()`.
- The `roast init` starter (`starter.ts`) shows commented-out defaults
  from `defaults.ts`, the same module runtime settings use.
- `starter()` takes a `StarterChoice` per role -- either a `RoleChoice`
  (provider + model) for built-in providers or a `CustomChoice`
  (endpoint, protocol, apiKeyEnv, model) for custom endpoints.
  `starterFromModels()` is the backward-compat wrapper that maps model
  strings onto choices via `placeModel` / `otherProvider`.
  `choiceFromModel()` builds a `RoleChoice` from a flag value.
- `placeModel` places a model by its ID alone: a
  `<vendor>/<model>[:<variant>]` ID goes to OpenRouter, a bare ID to the
  provider `inferFamily` names. Custom model IDs skip `placeModel`
  entirely -- they stay on whatever custom endpoint the user typed. A
  placeholder role follows an OpenRouter role onto OpenRouter; otherwise
  it takes the other direct provider.
- Custom profile naming: a single custom role uses `custom`; when both
  roles are custom with different settings or models, they split to
  `custom-finder` and `custom-verifier`; identical settings share
  `custom`.
- Suggested model IDs for each built-in provider live in
  `SUGGESTED_MODELS` (`defaults.ts`). The `UnplaceableModelError`
  example text uses them so the two cannot drift.
- Interactive prompt flow lives in `src/cli/init.ts`:
  `promptRoleChoice` per role, calling `promptProvider` then
  `promptModel` (built-in) or `promptCustomEndpoint` (custom). The
  menu order is hardcoded in `PROVIDER_MENU` (Anthropic, OpenAI,
  OpenRouter, Custom endpoint). `suggestedModel()` picks the default
  from `SUGGESTED_MODELS`; for OpenRouter, it picks the slug for the
  vendor the other role is not using. A typed model at a built-in
  provider must pass `placeModel` and land on the chosen provider.
- When the finder chooses Custom, the verifier's default provider is
  also Custom, and its endpoint, protocol, and key variable prompts
  default to the finder's answers.
- After writing a config with custom endpoints, `init` offers trust
  approval (using `writeTrustSummary` and `promptNoDefault`) and prints
  a credential hint naming the variable to export.

## Providers

- `lookupProvider(name)` and `providerAt(endpoint, protocol)`
  (`provider.ts`) are the one place that says which endpoint,
  protocols, standard key variable, key page, and login method a
  provider has. Trust standardness, ambient credentials, and the `init`
  starter consult it; add a provider there, not in those callers. A
  provider's first protocol is the one starter profiles use.
- A new provider's key variable must be stripped from test
  environments: see `cleanEnv` in `typescript.md`.
- `defaultBaseURL(protocol)` stays separate: it is the implicit endpoint
  of a profile that omits one; OpenRouter is never one.
- A role that gets no ambient key reports any set provider key variable
  as withheld (`withheldKey`, `credential.ts`), preferring the
  protocol's default provider.
- `parseEndpoint` (`provider.ts`) is the one endpoint parser (treats
  `https:///v1` and `https:v1` as an empty host); `endpoint.ts` and
  `sameEndpoint` use it.

## Roles (`role.ts`, `credential.ts`, `provider.ts`)

- Resolution takes `env` explicitly and never reads `process.env`.
- `ResolvedRole` is frozen with a non-enumerable `apiKey` and `stored`,
  so JSON, spread, and `util.inspect` omit the secret. Change a role
  with `updateRole(role, changes)`; a `{...role}` spread drops the key.
- `StoredCredentials` lives in `credential.ts` (re-exported by
  `load.ts`).

## Tests

- Role tests build configs with `configFrom` / `resolveFinder` and the
  in-memory `FakeStore` in `test/config/helpers.ts`.
- Configs the tests load as realistic examples go in
  `test/config/examples.ts`; the schema test validates each with ajv.
