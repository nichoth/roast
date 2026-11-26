# Stored credentials, login, logout

`src/credentials/`, `src/config/credential.ts`, `src/cli/login.ts`,
`src/cli/openrouter-login.ts`, `src/cli/logout.ts`. Design: ADR-0002.

## Resolution order

- `ROAST_<ROLE>_API_KEY`, then a profile's `api_key_env`, then
  `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, then stored credentials; the
  last three only at that provider's built-in endpoint.
- Initial resolution (`resolveCredential`) and override rebinding must
  agree: both reach the provider variable and stored key through
  `ambientCredential`, so a role picks the same credential with or
  without a same-provider protocol override.

## Store

- Project scope is `<worktree>/.env.roast` in dotenv format, with the
  primary checkout as a fallback. User scope is JSON at
  `$XDG_CONFIG_HOME/roast/credentials.json`, else
  `~/.config/roast/credentials.json`.
- Project login and logout migrate legacy keys from
  `<git-common-dir>/roast/credentials.json` into the primary checkout.
  Project writes verify the file is untracked and ignored first.
- `loadProjectConfig` attaches `openCredentialStore(ctx.cwd, ctx.env)`
  through `withStoredCredentials`; any new path that resolves roles
  from a `loadConfig` result must attach it too, or stored keys are
  silently unused. `ResolvedRole` carries the store so an endpoint
  override can rebind.
- `CredentialStore.lookup` is synchronous (roles resolve
  synchronously), so the async open resolves both scope paths up front
  and lookup reads files lazily with sync `fs`, caching only successful
  loads. The JSON reader decodes with the strict zod schema but reads
  the validated input, as `config/load.ts` does.
- Files are read lazily: a bad file fails resolution only when a role
  reaches it (no env credential first). `roast doctor` also loads each
  scope's file that exists (results `project-credentials` /
  `user-credentials`, `src/cli/doctor.ts`), so a broken file fails
  doctor even when env credentials shadow it. Doctor reads the
  user-scope file too, so a doctor test that expects a clean exit
  isolates `HOME`.

## Login and logout

- `readSecret` (`src/cli/terminal.ts`) reads without echo only on a
  raw-capable terminal; with test stdin it reads plain lines from the
  shared `ctx.lines`, so tests pass several answers as `"key1\nkey2\n"`.
- `login` with no argument and `init`'s login offer share
  `providersNeedingLogin` (built-in providers of roles that resolve no
  credential) and `loginProvider` (one provider, given scope path).
- `logout` shares `loginPath` (scope and the outside-a-repository usage
  error) and `providerNames` with login; keep scope rules in that one
  helper.
- Browser opening goes through `terminalHooks`; tests swap it with
  `captureBrowser` (`test/helpers/terminal.ts`), which returns the URLs
  it was asked to open. Login prints every URL too, so a failing opener
  never blocks it.

## Tests

- Put files at `<repo>/.env.roast` and
  `$XDG_CONFIG_HOME/roast/credentials.json` from `tempRepo().env`.
- `providerServer` (`test/helpers/provider-server.ts`) answers
  `GET /v1/models` for key validation; `answerModels` sets the status
  per credential. With `runRoast({ redirectTo })`, login's validation
  request reaches it.
- OpenRouter login is a PKCE exchange: the fake mints keys at
  `POST /api/v1/auth/keys` and checks them at `GET /api/v1/key`
  (`answerKey`). Tests read the opened URL (`awaitOpened`) and hit its
  callback with `callOpenRouterBack` (`test/cli/openrouter-login.ts`),
  which uses the real fetch. Any test that might wait for a callback
  shortens the wait with `shortBrowserTimeout`, so a regression fails
  fast.
