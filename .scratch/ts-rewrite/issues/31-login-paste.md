# 31: `login` paste flow, part 1 -- storing a key

**Blocked by:** 08
**Touches:** `src/cli/login.ts` (`login` command, `runLogin`, `loginPath`,
`providerNames`, `pasteLogin`, `validateKey`, `keyCheckPath`),
`src/cli/terminal.ts` (raw-mode `readSecret`, if not already there),
`test/helpers/provider-server.ts` (shared fake provider server, also used
by `init` tests), `test/cli/login.ts`
**Spec:** `spec/13-login.md` 2.1, 2.2, 2.3 ("With a provider argument"),
2.5, 2.7, 2.9, 3, 5 (Paste login rows); `spec/03-trust-credentials.md`
2.12 to 2.13 (the credentials API this uses); spec.md deliberate changes
8, 9
**Status:** done

## What to build

A user can store a provider API key with `npx roast login <provider>`
(project scope by default, `--global` for user scope). They paste the
key at a no-echo prompt after Roast opens the provider's key page
(`--no-browser` skips opening). Roast checks the key against the
provider's `GET /v1/models` before storing it and never prints the key.

This is the first of three tickets split from the original `login` /
`logout` ticket. It covers the paste providers (OpenAI, Anthropic) on the
success path, plus the shared `loginPath` (scope rules and the
outside-a-repository usage error) and `providerNames`.

Key validation uses the swappable `fetch` with `redirect: 'manual'`, and
reads bodies at most 32 KiB (deliberate changes 8 and 9). Build it that
way now; the tests for redirects, retries, and cancellation are ticket
41. No-argument `login`, `loginProvider`, and `logout` are ticket 42.

The test fake answers `GET /v1/models` with a status per credential
(`answerModels`). It is reached through the swapped `fetch` that
routes the built-in endpoints. Browser opening is captured with the
swappable `openBrowser`.

## Acceptance criteria

- [x] `login anthropic` with a pasted key (surrounding spaces trimmed)
      stores it in the project `credentials.json` (0600 in a 0700 dir),
      and a later review on the built-in endpoint sends it.
- [x] `login openai --global` stores only in the user file, and the
      validation request carried `Authorization: Bearer <key>`.
- [x] The key page URL is passed to `openBrowser`, except with
      `--no-browser`. An opener that fails does not fail login.
- [x] Logging in again replaces the stored key.
- [x] No part of any pasted key appears in stdout, and stdout is
      non-empty.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
