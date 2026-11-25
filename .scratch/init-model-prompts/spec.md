# Prompt for models and providers in `init`

**Status:** ready-for-agent

## Problem Statement

`npx roast init` only learns the finder and verifier models from the
`--finder-model` and `--verifier-model` flags. A user who runs it without
them gets placeholder model IDs, a login offer for Anthropic and OpenAI
(the providers the placeholder roles happen to land on), and a project
config that refuses to run a review until they hand-edit it. Nothing in
the command tells them which providers exist or that OpenRouter is one.

A user with a local model server, such as a Tiiny device that serves
OpenAI Chat Completions on the LAN, has no path through `init` at all.
They must write an inference profile by hand (endpoint, protocol, key
variable, model) and then discover that a custom endpoint needs trust
approval before a review will run.

## Solution

When `init` runs in an interactive terminal and a role's model flag is
missing, it asks for that role's provider and model. The provider menu
lists the built-in providers (Anthropic, OpenAI, OpenRouter) and a
"Custom endpoint" entry for local servers and gateways. A built-in
provider choice suggests a model ID the user can accept with Enter. A
custom choice asks for the endpoint, protocol, key variable, and model.
`init` then writes the project config, offers login for built-in
providers as it does today, and, when the config names a custom
endpoint, shows the trust summary and offers to approve it.

Without an interactive terminal, `init` behaves as it does today: it
writes placeholders for missing models and prints a hint naming the
flags.

## User Stories

1. As a new user, I want `npx roast init` to ask me which provider and
   model each role should use, so that I get a working project config
   without reading the config reference first.
2. As a new user, I want a suggested model ID for each built-in
   provider, so that I can accept a sensible default with Enter.
3. As a user, I want the verifier's provider menu to default to the
   provider the finder did not use, so that the two roles come from
   different providers unless I choose otherwise.
4. As a user who passes `--finder-model` only, I want `init` to prompt
   for the verifier alone, so that flags and prompts combine.
5. As a user who passes both model flags, I want no model prompts, so
   that the existing scripted usage is unchanged.
6. As a user with a local model server, I want a "Custom endpoint"
   choice that asks for the endpoint URL, protocol, key variable, and
   model ID, so that I can point Roast at my device from `init`.
7. As a user of a local server, I want the protocol to default to
   `chat`, so that I can accept the protocol most local servers speak.
8. As a user of a local server, I want to enter model IDs the device
   uses, such as `Qwen/Qwen3.6-35B-A3B`, without Roast rejecting them
   or sending them to OpenRouter, so that the device's own IDs work.
9. As a user who puts both roles on the same custom endpoint, I want
   the verifier's endpoint, protocol, and key variable prompts to
   default to my finder answers, so that I type them once.
10. As a user who leaves the key variable blank for a custom endpoint, I
    want the role to fall back to the role key variable
    (`ROAST_FINDER_API_KEY` or `ROAST_VERIFIER_API_KEY`), and to be told
    so, so that I know which variable to export.
11. As a user who chose a custom endpoint, I want `init` to show the
    trust summary and offer approval, defaulting to No, so that my first
    review is not refused for an endpoint I entered seconds ago.
12. As a user who chose a custom endpoint, I want a hint to export the
    key variable instead of a login offer, so that I know how the
    credential reaches the endpoint.
13. As a user who mistypes an answer, I want `init` to show what was
    wrong and ask again, so that I do not lose the answers I already
    gave.
14. As a user who presses Ctrl-C or sends EOF partway through, I want
    nothing written, so that I can start over cleanly.
15. As a user in a directory that already has `.roast.json`, I want
    `init` to refuse before asking any questions, so that I do not
    answer prompts for nothing.
16. As a user who chooses the same model on the same endpoint for both
    roles, I want a one-line note, so that I know verification adds
    little in that setup.
17. As an agent or CI job running `npx roast init` without a terminal, I
    want today's placeholder behavior and a hint naming the model flags,
    so that non-interactive callers are not blocked by a prompt.
18. As a user of a custom endpoint whose model I have not decided, I
    want Enter at the model prompt to write a placeholder, so that I can
    finish `init` and set the model later.

## Implementation Decisions

- **Trigger.** Prompting is per role: a role prompts only when its
  model flag is missing or blank. A flag always wins for its role.
  Prompts run only when both stdin and stderr are interactive terminals
  (the existing interactive-terminal check). No new flag is added, and
  `--no-login` keeps its current meaning (it does not suppress model
  prompts).
- **Non-interactive fallback.** Without interactive terminals, missing
  models become the existing placeholders, and `init` prints a hint
  that names `--finder-model` and `--verifier-model`. Provider
  placement for placeholder roles is unchanged.
- **Early checks.** `init` resolves the Git toplevel and checks that the
  project config does not exist before the first prompt. The final
  exclusive create stays, so a race still fails safely. All writes
  (project config, `.gitignore` entry, trust approval, stored
  credentials) happen after the last model prompt; EOF or an abort
  signal at any prompt exits with nothing written.
- **Prompt flow per role.** The finder is asked fully, then the
  verifier. Each role asks for a provider from a numbered menu:
  Anthropic, OpenAI, OpenRouter, Custom endpoint. The menu accepts a
  number or a provider name. The finder's menu default follows the
  existing starter placement (OpenAI). The verifier's menu default is
  the other provider by the existing `otherProvider` rule: Anthropic and
  OpenAI swap, OpenRouter stays OpenRouter, and Custom stays Custom.
- **Built-in provider model prompt.** Shows a suggested model ID that
  Enter accepts. The answer must pass the existing `placeModel` check
  and must place onto the chosen provider. A mismatch (for example a
  bare OpenAI ID under Anthropic) asks again with the same message the
  flag path gives through `UnplaceableModelError`, or a mismatch message
  naming the chosen provider. There is no placeholder escape at a
  built-in provider's model prompt; Ctrl-C or a non-interactive run is
  the way out.
- **Suggested model IDs.** New constants in the shared defaults module
  (the one the starter and runtime settings already share):
  - Anthropic: `claude-opus-5-5`
  - OpenAI: `gpt-6.1-terra`
  - OpenRouter: `anthropic/claude-opus-5-5` or `openai/gpt-6.1-terra`,
    choosing the vendor the other role is not using (finder defaults to
    the Anthropic slug when the verifier is not yet known).

  The `UnplaceableModelError` example text uses the same constants so
  the two cannot drift.
- **Custom endpoint prompts, in order:**
  1. Endpoint URL, validated by the existing endpoint rule
     (`endpointProblem`): an http(s) URL with no credentials, query, or
     fragment. Plain `http` is accepted.
  2. Protocol, one of `chat`, `responses`, `anthropic`, default `chat`.
  3. Key variable name, matching `^[A-Z_][A-Z0-9_]*$`, or blank. Blank
     omits `api_key_env` from the profile, so the role's credential
     comes from the role key variable.
  4. Model ID: any non-empty trimmed string with no whitespace or
     control characters. It does not go through `placeModel`. Blank
     writes the placeholder for that role.

  When the verifier also chooses Custom, its endpoint, protocol, and key
  variable prompts default to the finder's answers.
- **Validation everywhere.** Every prompt asks again on invalid input
  and prints the validator's own message. Prompts read lines through the
  shared line reader used by the login prompts (login orchestration
  shares `ctx.lines`), so scripted stdin works across model prompts,
  login, and trust.
- **Starter rendering.** The starter function gains the ability to
  render a custom inference profile (endpoint, protocol, optional
  `api_key_env`, model) alongside built-in ones. Its input changes from
  two model strings to a per-role choice (built-in provider plus model,
  or custom endpoint details). The flag path maps onto the same input,
  so flags and prompts render through one function. Rendered output for
  flag-only invocations is unchanged.
- **Profile naming.** Built-in profiles keep their current names. A
  custom profile is named `custom`; when both roles use custom
  endpoints with different settings or models, they are
  `custom-finder` and `custom-verifier`, mirroring the existing
  `-finder` / `-verifier` split for built-in providers.
- **Same-model note.** When both roles resolve to the same model on the
  same endpoint and protocol, `init` prints one line saying verification
  adds little in that setup. Same provider with different models gets
  no note.
- **After writing.** The order is: write the project config, add the
  state ignore entry, then (unless `--no-login`) the existing login
  offer for built-in providers that lack a credential. For each custom
  role, print a hint naming the variable to export: the profile's key
  variable, or the role key variable when it was left blank.
- **Trust offer.** When the written config needs approval (a custom
  endpoint or key variable changes the trust projection), `init` prints
  the same summary `npx roast trust` prints and asks for approval with a
  No default, reusing the existing trust summary writer and No-default
  prompt. Yes records the approval exactly as `npx roast trust` would;
  No prints a hint to run `npx roast trust` later. The trust offer runs
  only in interactive terminals. ADR-0001 and ADR-0003 are respected:
  approval is explicit, shows every security-relevant value, and uses
  the existing trust hash.
- **Credentials.** A custom endpoint never receives a stored login key;
  that rule is unchanged. `init` does not fetch `GET /models` or contact
  a custom endpoint.

## Testing Decisions

- Good tests here check external behavior only: the exit code, the
  written project config as loaded by the config loader and resolved
  into roles (endpoint, protocol, model, credential variable), whether
  the config is approved for trust, and stored credentials. They do not
  check prompt wording, menu text, or the rendered file's comments.
- **Primary seam: the `init` command.** Tests run `init` in-process
  through the existing CLI test runner inside a temporary Git
  repository, with simulated interactive terminals and scripted stdin.
  This is how the current `init` login-offer tests work, and they are
  the prior art, along with the trust command tests that check
  approval. Cases:
  - each built-in provider chosen by number and by name, with the
    suggested model accepted and with a typed model
  - one model flag plus a prompt for the other role
  - both flags: no model prompts
  - no interactive terminals: placeholders written, no prompts
  - a custom endpoint with a key variable and without one
  - both roles on the same custom endpoint, accepting the verifier
    defaults
  - a custom model ID with mixed case and a slash, resolved onto the
    custom endpoint, not OpenRouter
  - invalid menu choice, invalid endpoint, invalid key variable name,
    and a model that does not fit the chosen provider, each followed by
    a valid answer
  - EOF partway through: nothing written
  - an existing project config: refused before any prompt
  - trust offer answered Yes (approved) and No (not approved)
  - the login offer still runs for built-in providers after prompts
- **Secondary seam: the starter function.** A pure function with
  existing tests. Use it for rendering cases that are cheaper without a
  terminal: a custom profile with and without `api_key_env`, profile
  naming for custom and split profiles, and unchanged output for
  flag-only input. Assert by loading the rendered text with the config
  loader, not by matching text.
- CLI tests that resolve roles need valid test credentials and the fake
  provider server routing, as the existing login-offer tests set up.

## Out of Scope

- Keyless inference profiles for local servers that need no key. Roast
  still requires a credential for every role. The Tiiny device uses a
  bearer key, so it does not need this; a keyless server can point the
  key variable at a dummy value until a separate feature lands.
- Flags for custom endpoints (endpoint, protocol, key variable per
  role). Without a terminal, a custom endpoint remains a hand edit of
  `.roast.json`.
- Listing models from a provider or custom endpoint (`GET /models`)
  during `init`.
- Model routing across several local models; see
  `.scratch/tiiny-model-routing/` for that research.
- Changes to the bundled agent skill: agents run `init` without a
  terminal and see no behavior change.

## Further Notes

- Docs to update with the feature: the README section
  "### 2. Create the project config" (the prompts, the custom endpoint
  option, the trust offer, and the non-interactive fallback); the config
  area notes in `docs/agents/config.md` (prompt flow, where suggested
  model IDs live, that custom model IDs skip `placeModel`); and the
  release checklist in `docs/agents/packaging.md` (update the suggested
  model IDs and the README `init` example together). No test compares
  README text to the constants.
- Tiiny facts used for this spec come from the prior research in
  `.scratch/tiiny-model-routing/`: OpenAI Chat Completions at
  `http://openai.api.tiiny/v1`, a bearer key, and model IDs such as
  `Qwen/Qwen3.6-35B-A3B` and `openai/gpt-oss-20b`.
