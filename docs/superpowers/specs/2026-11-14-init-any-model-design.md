# `roast init` with any model in either role

## Intent

`npx roast init --finder-model ... --verifier-model ...` should accept any
OpenAI or Anthropic model in either role. Today the starter config always
puts the finder on an `openai` profile (Responses API) and the verifier on an
`anthropic` profile (Messages API), so `--finder-model claude-...` writes a
config that sends a Claude model ID to OpenAI. A user who wants Claude as the
finder and Codex as the verifier has to hand-edit the roles after `init`.

## Goals

- Each model flag picks the provider that serves the model, worked out from
  the model ID.
- `init` with no flags behaves as today: placeholder models, finder on
  OpenAI, verifier on Anthropic.
- The starter config keeps using only default endpoints and the standard key
  variables, so it still needs no `npx roast trust` approval.

## Non-goals

- Providers other than OpenAI and Anthropic. They need a custom endpoint, and
  so trust approval; users edit `.roast.jsonc` for those.
- New CLI flags (`--finder-provider` etc.).
- Warning when both roles use the same model family.

## Anti-goals

- Writing a config that silently pairs a model with the wrong provider. An
  ID `init` cannot place is an error, not a guess.

## Approaches

1. **Work out the provider from the model ID with `config.InferFamily`
   (picked).** Shortest command, reuses the existing family detection that
   author routes already use. Needs `codex-` added to the OpenAI family.
2. `--finder-provider` / `--verifier-provider` flags. Explicit, but four
   flags for the common case and still lets a user write a mismatched config.
3. Both. Most flexible, most CLI surface; not needed while the error message
   points to `.roast.jsonc`.

## Design

- `config.InferFamily` treats a `codex-` prefix as `openai`.
- Provider for a role:
  - model given: `InferFamily(model)`; `openai` or `anthropic` is used,
    anything else (including an empty family) is a usage error naming the
    flag and model, saying `init` writes only OpenAI and Anthropic profiles
    and to edit `.roast.jsonc` for other providers.
  - model omitted: placeholder model, on the provider the other role does
    not use. With both omitted, finder is `openai`, verifier `anthropic`.
- Profiles: one per distinct (provider, model) pair, in finder-then-verifier
  order. A profile is named after its provider (`openai`, `anthropic`). When
  both roles use the same provider with different models, the names are
  `<provider>-finder` and `<provider>-verifier`. When both roles use the same
  provider and model, they share one profile.
- Provider settings stay as today: OpenAI is
  `https://api.openai.com/v1`, `responses`, `OPENAI_API_KEY`; Anthropic is
  `https://api.anthropic.com/v1`, `anthropic`, `ANTHROPIC_API_KEY`.
- `config.Starter` returns an error alongside the bytes; `init` maps it to a
  usage error (exit 2) and writes nothing.
- The starter's profile comment stops saying "these two use OpenAI and
  Anthropic" and describes whatever profiles were written.

## Docs

- `README.md`: replace the swap-the-roles example with the one-line
  `init --finder-model claude-... --verifier-model gpt-...-codex`, and update
  the "starter config uses OpenAI ... for the finder" paragraph.
- Check `internal/skill/assets/roast/SKILL.md` and `docs/security-model.md`
  still read correctly (no change expected).

## Tests

- `internal/cli/init_test.go`: the review test asserts which endpoint each
  role's model reaches, with roles in both orders (Claude finder / OpenAI
  verifier, and the reverse). Its model IDs change from `a`/`b` to IDs
  `InferFamily` can place.
- An unplaceable model is a usage error and leaves no `.roast.jsonc`.
- Placeholder pairing when one or both flags are omitted.
- Same-provider cases parse with `config.Load` and resolve each role to the
  expected model.
- No assertions on the generated comment text.

## Left to the builder

Where the provider-resolution helper lives (`starter.go` is the natural
place) and the exact error wording.
