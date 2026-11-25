# 03: "Custom endpoint" choice for local servers and gateways

**What to build:** The provider menu gains a fourth entry, "Custom
endpoint", for local model servers (such as a Tiiny device serving
OpenAI Chat Completions on the LAN) and gateways. Choosing it asks, in
order:

1. Endpoint URL, validated by `endpointProblem`: an http(s) URL with no
   credentials, query, or fragment. Plain `http` is accepted.
2. Protocol: `chat`, `responses`, or `anthropic`, default `chat`.
3. Key variable name matching `^[A-Z_][A-Z0-9_]*$`, or blank. Blank
   omits `api_key_env`, so the credential comes from the role key
   variable (`roleKeyVar`: `ROAST_FINDER_API_KEY` /
   `ROAST_VERIFIER_API_KEY`).
4. Model ID: any non-empty trimmed string with no whitespace or control
   characters. It does not go through `placeModel`, so IDs such as
   `Qwen/Qwen3.6-35B-A3B` stay on the custom endpoint. Blank writes the
   role's placeholder.

The verifier's menu default is Custom when the finder chose Custom. When
the verifier also chooses Custom, its endpoint, protocol, and key
variable prompts default to the finder's answers.

The starter renders a custom inference profile (endpoint, protocol,
optional `api_key_env`, model) alongside built-in ones. A custom profile
is named `custom`. When both roles use custom endpoints with different
settings or models, they are `custom-finder` and `custom-verifier`. The
same-model note from ticket 02 applies when both custom roles share
endpoint, protocol, and model.

After writing, a custom role gets no login offer. Instead `init` prints a
hint naming the variable to export: the profile's key variable, or the
role key variable when it was left blank. `init` never contacts the
custom endpoint and never sends it a stored login key.

Docs: README "### 2. Create the project config" (the custom endpoint
option); `docs/agents/config.md` (custom model IDs skip `placeModel`,
custom profile naming).

**Blocked by:** 02

**Touches:** `src/cli/init.ts`, `src/config/starter.ts`,
`src/config/endpoint.ts` (`endpointProblem`, `PROTOCOLS`),
`src/config/credential.ts` (`roleKeyVar`), `test/cli/init.ts`,
`test/config/starter.ts`, `README.md`, `docs/agents/config.md`

**Status:** done

- [x] A custom endpoint with a key variable writes a config whose role
      resolves to that endpoint, protocol, model, and credential variable
- [x] A custom endpoint with a blank key variable writes a profile without
      `api_key_env`, and the role resolves its credential from the role
      key variable
- [x] Accepting the default protocol resolves the role with protocol
      `chat`
- [x] Both roles on the same custom endpoint, accepting the verifier's
      endpoint, protocol, and key variable defaults, resolve to the same
      endpoint, protocol, and credential variable as the finder
- [x] A custom model ID with mixed case and a slash resolves onto the
      custom endpoint, not OpenRouter
- [x] A blank custom model writes the role's placeholder model
- [x] An invalid endpoint followed by a valid one succeeds
- [x] An invalid key variable name followed by a valid one succeeds
- [x] A custom role gets no login offer and no stored credential is
      written for it
- [x] Starter: a custom profile with and without `api_key_env` loads
      through the config loader with the given values
- [x] Starter: two custom roles with different settings load as
      `custom-finder` and `custom-verifier`; identical ones share
      `custom`
