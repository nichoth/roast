# `roast init` with any model in either role -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx roast init --finder-model M1 --verifier-model M2` puts each
model on the provider that serves it, so Claude can be the finder and an
OpenAI model the verifier (or any other OpenAI/Anthropic pairing).

**Architecture:** `config.Starter` works out each role's provider from its
model ID with `config.InferFamily`, builds only the profiles the roles need,
and returns an error for a model it cannot place. `init` computes the starter
before creating the file and maps that error to a usage error.

**Tech Stack:** Go, cobra, the existing `internal/config` JSONC loader.

**Spec:** `docs/superpowers/specs/2026-11-14-init-any-model-design.md`

## Global Constraints

- Only two providers, each on its default endpoint with its standard key
  variable, so the starter needs no `npx roast trust` approval:
  - `openai`: endpoint `https://api.openai.com/v1`, protocol `responses`,
    `api_key_env` `OPENAI_API_KEY`
  - `anthropic`: endpoint `https://api.anthropic.com/v1`, protocol
    `anthropic`, `api_key_env` `ANTHROPIC_API_KEY`
- `init` with no flags writes what it writes today: placeholder models,
  finder on profile `openai`, verifier on profile `anthropic`.
- No new CLI flags.
- A model `init` cannot place is a usage error (exit 2) and no `.roast.json`
  is written.
- Tests must not assert on generated comment text (user rule: no brittle
  text tests). Assert through `config.Load` and the config structs.
- No em dashes or arrow characters in comments or docs.
- `go mod tidy` and staticcheck must stay clean.

## Review Focus

1. A failed `init` must leave no file behind. Today `writeStarter` creates
   the file before rendering; rendering must happen first. Pinned by
   `TestInitRejectsAModelItCannotPlace` (Task 2).
2. A provider-prefixed ID such as `anthropic/claude-opus-5-5` makes
   `InferFamily` answer `anthropic`, but the default endpoint would reject
   that ID. Treat any ID containing `/` as unplaceable. Pinned in
   `TestStarterRejectsModelsItCannotPlace` (Task 1).
3. A bare family name (`openai`, `anthropic`) passes `InferFamily` but is
   not a model ID. Treat it as unplaceable. Same test.
4. Codex IDs without a `gpt-` prefix (`codex-mini-latest`) must land on
   OpenAI. Pinned in `TestInferFamily` and `TestStarterPlacesEachRole`.
5. Both roles on one provider: same model shares one profile, different
   models get two profiles with distinct names; both must load and resolve.
   Pinned in `TestStarterPlacesEachRole`.

---

### Task 1: Provider-aware starter config

**Files:**
- Modify: `internal/config/config.go` (`InferFamily`, around line 719)
- Modify: `internal/config/starter.go`
- Create: `internal/config/starter_test.go`
- Modify: `internal/config/config_test.go` (`TestInferFamily`, line 258)

**Interfaces:**
- Produces:
  - `func Starter(finderModel, verifierModel string) ([]byte, error)`
  - `type UnplaceableModelError struct { Role, Model string }` with
    `Error() string`. `Role` is `"finder"` or `"verifier"`.
  - Unchanged: `PlaceholderFinderModel`, `PlaceholderVerifierModel`,
    `SchemaRef`, `IsPlaceholderModel`.

- [ ] **Step 1: Write the failing tests**

In `TestInferFamily`, add entries `"codex-mini-latest": "openai"` and
`"gpt-5-codex": "openai"`.

In `internal/config/starter_test.go`, add a helper
`loadStarter(t, finder, verifier string) Config` that calls `Starter`,
fails on error, writes the bytes with `writeConfig`, and returns
`Load(path)`. Add a helper `roleProfile(cfg Config, role string)
InferenceProfile` returning `cfg.InferenceProfiles[cfg.Roles[role].Profile]`.

`TestStarterPlacesEachRole`, table-driven, for each case assert the finder's
and verifier's profile `Protocol`, `BaseURL`, `APIKeyEnv`, and `Model`, plus
`len(cfg.InferenceProfiles)`:

| finder | verifier | finder protocol | verifier protocol | profiles |
|---|---|---|---|---|
| `""` | `""` | `responses` (placeholder) | `anthropic` (placeholder) | 2 |
| `claude-opus-5-5` | `gpt-5-codex` | `anthropic` | `responses` | 2 |
| `gpt-5` | `claude-sonnet-5-5` | `responses` | `anthropic` | 2 |
| `claude-opus-5-5` | `""` | `anthropic` | `responses` (placeholder) | 2 |
| `""` | `gpt-5` | `anthropic` (placeholder) | `responses` | 2 |
| `codex-mini-latest` | `claude-opus-5-5` | `responses` | `anthropic` | 2 |
| `claude-opus-5-5` | `claude-sonnet-5-5` | `anthropic` | `anthropic` | 2 |
| `gpt-5` | `gpt-5` | `responses` | `responses` | 1 |

For placeholder roles, `Model` is `PlaceholderFinderModel` /
`PlaceholderVerifierModel`. For the no-flag case also assert
`cfg.Roles["finder"].Profile == "openai"` and
`cfg.Roles["verifier"].Profile == "anthropic"`. For the two same-provider
different-model cases assert the two role profile names differ.

`TestStarterRejectsModelsItCannotPlace`: for each of `gemini-2.5-pro`,
`some-model`, `anthropic/claude-opus-5-5`, `openai`, call `Starter` once as
finder (verifier `""`) and once as verifier (finder `""`); assert the error
is an `*UnplaceableModelError` (`errors.As`) with the matching `Role` and
`Model`, and the bytes are nil.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/config/ -run 'TestInferFamily|TestStarter'`
Expected: build failure (`Starter` returns one value,
`UnplaceableModelError` undefined).

- [ ] **Step 3: Implement**

`InferFamily`: add `strings.HasPrefix(m, "codex-")` to the `openai` case.

`starter.go`:
- A `starterProvider` table keyed `"openai"` / `"anthropic"` holding the
  endpoint, protocol, and key variable from Global Constraints.
- `placeModel(model string) (provider string, ok bool)`: `ok` only when
  `model` has no `/`, is not exactly a family name, and
  `InferFamily(model)` is `openai` or `anthropic`.
- Provider choice: a given model uses `placeModel`; an omitted (`""`) model
  takes the provider the other role does not use; both omitted gives finder
  `openai`, verifier `anthropic`. An omitted model is written as its
  placeholder.
- Profile naming: same provider and same model, one profile named after the
  provider, used by both roles. Same provider, different models,
  `<provider>-finder` and `<provider>-verifier`. Otherwise each profile is
  named after its provider. Write profiles finder first.
- Render the `inference_profiles` block and the two role profile names into
  the template instead of the fixed `openai` / `anthropic` blocks. Keep the
  rest of the template (commented-out `review`, `limits`, `gate` defaults)
  byte-for-byte. Reword the profile comment so it does not say "these two"
  or name the providers, for example: "These use default provider
  endpoints with the standard key variables, so they need no `npx roast
  trust` approval."
- `UnplaceableModelError.Error()`: say the role's model is not an OpenAI or
  Anthropic model ID that `init` can configure, and that other providers
  are set up by editing `.roast.json`. Exact wording is the implementer's.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/config/`
Expected: PASS, including `TestSchemaMatchesConfigStruct` (no struct
change).

- [ ] **Step 5: Commit**

```bash
git add internal/config/
git commit -m "feat(config): place starter roles on the provider of their model"
```

### Task 2: `init` uses the provider-aware starter

**Files:**
- Modify: `internal/cli/init.go` (`writeStarter`, `newInitCommand` flag help)
- Modify: `internal/cli/init_test.go`

**Interfaces:**
- Consumes: `config.Starter(finderModel, verifierModel string) ([]byte,
  error)`, `*config.UnplaceableModelError{Role, Model}` from Task 1.
- Produces: no new exported names.

- [ ] **Step 1: Write the failing tests**

Change `TestInitWritesAConfigWhoseModelsAReviewUses` into a table over two
orderings, each in its own repo:
- `--finder-model gpt-test --verifier-model claude-test`, want requests
  `["/v1/responses gpt-test", "/v1/messages claude-test"]`
- `--finder-model claude-test --verifier-model gpt-test`, want
  `["/v1/messages claude-test", "/v1/responses gpt-test"]`

Keep the rest of the test (env keys, `providerServer`,
`redirectDefaultTransport`, review with `--max-verified=1`).

`TestInitRejectsAModelItCannotPlace`: in a fresh repo,
`runRoast(t, "init", "--finder-model", "gemini-2.5-pro")`; assert
`out.code == ExitUsage`, the error text contains `--finder-model`, and
`os.Stat` of `.roast.json` returns `fs.ErrNotExist`. Also assert the
toplevel `.gitignore` was not created or changed (the starter failing
should stop `init` before `ensureStateIgnored`).

In `TestInitRefusesToOverwriteAnExistingConfig`, change `--finder-model a`
to `--finder-model gpt-test` so it still exercises the overwrite path and
not the new rejection.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/cli/ -run TestInit`
Expected: the reversed-roles case fails (claude-test reaches
`/v1/responses`), and the rejection test fails (exit 0, file written).
Build fails first until `init.go` handles the new `Starter` signature; fix
only the signature call to see the behavioral failures.

- [ ] **Step 3: Implement**

In `writeStarter`, call `config.Starter` before `os.OpenFile`. On an
`*config.UnplaceableModelError`, return a `&usageError{}` whose message
starts with `--<role>-model <model>:` and carries the error's text. Write
the rendered bytes after opening the file. Update the `--finder-model` /
`--verifier-model` help strings to say the provider follows from the model
ID (OpenAI or Anthropic).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/cli/ -run TestInit && go test ./...`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `go tool -modfile=.github/tools/staticcheck/go.mod staticcheck ./...`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add internal/cli/init.go internal/cli/init_test.go
git commit -m "feat(init): accept any OpenAI or Anthropic model in either role"
```

### Task 3: Docs

**Files:**
- Modify: `README.md` (section "2. Create the project config")
- Check only: `internal/skill/assets/roast/SKILL.md` line 24,
  `docs/security-model.md` line 62

- [ ] **Step 1: Rewrite the README section**

Replace the paragraph that says the starter uses OpenAI for the finder and
Anthropic for the verifier: `init` picks each role's provider from its model
ID (OpenAI or Anthropic, on their default endpoints); a model from another
provider is an error, and those are configured by editing `.roast.json`
(link to [Project config](#project-config)). Keep the sentences about
placeholders and different model families.

Replace the `init` Example body (the role-swap instructions and `jsonc`
block) with one sentence and one command, Claude as finder and Codex as
verifier:

```sh
npx roast init --finder-model 'claude-opus-5-5' --verifier-model 'gpt-5-codex'
```

Leave the user's other uncommitted README edits in place. Use `--`, never an
em dash; no arrow characters.

- [ ] **Step 2: Check the other docs**

Read the two "Check only" locations; they should still be accurate (they
describe the starter as using default endpoints). Change them only if a
sentence now contradicts the code.

- [ ] **Step 3: Verify the command in the README**

Build a binary into a scratch directory
(`go build -o <scratch>/roast ./cmd/roast`), create a scratch Git repo,
and run `<scratch>/roast init --finder-model claude-opus-5-5
--verifier-model gpt-5-codex` inside it. Confirm `.roast.json` puts the
finder on the `anthropic` profile and the verifier on the `openai` profile.
Delete the scratch repo and binary.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: show init with Claude as finder and Codex as verifier"
```
