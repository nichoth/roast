# 06: Built-in providers and role/credential resolution

**Blocked by:** 05
**Touches:** `src/config/provider.ts` (`BuiltinProvider`,
`builtinProviders`, `lookupProvider`, `providerAt`, `defaultBaseURL`,
`sameEndpoint`), `src/config/credential.ts` (`StoredCredentials`,
`CredentialSource`, `describeSource`, `roleKeyVar`, `ambientCredential`,
`overrideEndpoint`, internal `rebindCredential` /
`applyEndpointOverrides`), `src/config/role.ts` (`ResolvedRole`,
`resolveRole`, `resolveFinderFlip`, `validateRole`, `validateEndpoint`),
`src/config/family.ts` (`inferFamily`, `canonicalFamily`), `test/config/`
**Spec:** `spec/02-config.md` 2.5-2.7, 2.9-2.11, 3 (`provider.ts`,
`credential.ts`, `role.ts`, `family.ts`, Dependencies), 5 (Resolution and
credentials, Providers and families); `spec/08-finder-prompts.md` 2.20
(author-aware finder selection contract); spec.md "Implementation
Decisions"
**Status:** done

## What to build

Given a loaded project config and an injected environment, Roast resolves
the `finder` and `verifier` roles to a `ResolvedRole`: endpoint, protocol,
model, output-token cap, session header, author routes, and the API key
with a `CredentialSource` describing where it came from. The built-in
provider registry (`lookupProvider`, `providerAt`) is the one place that
says which endpoint, protocols, standard key variable, key page, and
login method each provider has. Ambient provider keys go only to their
provider's built-in endpoint; a custom endpoint gets a key only from a
named `api_key_env` or `ROAST_<ROLE>_API_KEY`, and validation names any
key that was withheld. Endpoint and protocol overrides (`--<role>-base-url`,
`--<role>-protocol`) return a new role whose credential is rebound through
the same `ambientCredential` path as initial resolution, so both agree.
The finder flip (`--author-model`) picks a different-family profile or
author route and returns an optional note or warning.

`env` is always passed explicitly; nothing in this area reads
`process.env`. `apiKey` never appears in any `toJSON`, debug output, or
`describeSource` rendering.

Per the approved seam resolution 5, `StoredCredentials.lookup` is
synchronous (`lookup(provider):{key, scope}|null`, or throws for an
unusable file), so `resolveRole` stays synchronous. This ticket keeps the
stored-credential step in the resolution order (02 section 2.6) and
exercises it with an in-memory fake store; the real file-backed store and
its wiring into `loadProjectConfig` are ticket 08. `src/config` must not
import `src/credentials`.

Out of scope: the CLI wiring cases that assert which `Authorization`
header reaches the fake server, the `--author-model` CLI flag, and
"environment does not flip the finder" at the CLI seam all need `review`
and are verified in ticket 20. `describeCredential` is not ported.

## Acceptance criteria

- [x] Named profiles resolve with defaults; an `anthropic` profile gets
      the native Anthropic defaults.
- [x] Legacy global and removed per-role environment variables have no
      effect on resolution.
- [x] Precedence matrix (protocol x endpoint unset / default / custom /
      ambient gateway x `api_key_env` x `*_BASE_URL` set x role key)
      yields the expected endpoint, key, source kind, and `withheld`.
- [x] `OPENROUTER_API_KEY` is used only at OpenRouter with `chat` or
      `responses` and is reported as withheld elsewhere.
- [x] A custom endpoint with no named credential gets no ambient key, and
      `validateRole` fails naming both the withheld variable and the role
      variable (assert the variable names appear, not the wording).
- [x] A trailing slash on a default endpoint still matches the built-in
      provider.
- [x] Author-route profiles follow the same credential rule.
- [x] The override table in 02 section 2.9 holds, including rebinding the
      credential, a stored credential not following an override to
      another endpoint, and an unset profile variable on a built-in
      endpoint preferring the provider variable.
- [x] With a fake store: a stored key is used at a built-in endpoint,
      ranks below every env variable, is never used at a custom endpoint,
      and a store that throws fails resolution only when reached.
- [x] No `CredentialSource` rendering, and no JSON serialization of a
      `ResolvedRole`, contains the secret.
- [x] A missing credential on a built-in provider fails validation with
      a message that suggests login (assert it names `npx roast login`).
- [x] An endpoint with embedded userinfo fails validation.
- [x] `lookupProvider` returns each built-in by exact name only;
      `providerAt` matches the example table; every registered
      (endpoint, protocol) pair maps back to its own provider.
- [x] `providerAt` treats `https:///v1` and `https:v1` as an empty host.
- [x] `inferFamily` matches the table in 02 section 2.10.
- [x] `resolveFinderFlip` selects a named profile, selects an exact author
      route, refuses a same-family target, and treats slash IDs like bare
      IDs (assert the chosen profile and whether a note or warning
      exists).
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
      the Go build and `go test ./...` still pass.
