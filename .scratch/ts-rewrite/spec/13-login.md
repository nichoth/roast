# Area: `login` and `logout`

## 1. Purpose

`login` obtains a **credential** (an API key) for a **built-in provider**
and keeps it as a **stored credential**, scoped to the project (inside the
Git directory) or, with `--global`, to the user (ADR-0002). OpenAI and
Anthropic use a paste flow: Roast opens the provider's key page, reads a
pasted key, and checks it with one authenticated request before storing
it. OpenRouter uses a browser PKCE key exchange that mints a new key.

With no provider argument, `login` reads the **project config** and logs
in to each built-in provider that the config's roles use and that has no
credential yet. `init` reuses the same pieces for its login offer (the
`init` command itself belongs to the doctor/init/skill area, file 14).

`logout` removes a stored credential from one scope. It never revokes the
key at the provider.

Stored credentials rank below every environment variable; this area only
writes and deletes them. The credentials file format, paths, permissions,
and atomic writes are owned by the trust-and-credentials area; this file
uses its interface (section 3.4).

## 2. Behavior contract

### 2.1 Built-in provider data used here

From the provider registry (config area, `src/config/provider.ts`), in
registry order:

1. `openai`: endpoint `https://api.openai.com/v1`, protocols
   `responses, chat`, keyEnv `OPENAI_API_KEY`, keyPage
   `https://platform.openai.com/api-keys`, login `paste`.
2. `anthropic`: endpoint `https://api.anthropic.com/v1`, protocols
   `anthropic`, keyEnv `ANTHROPIC_API_KEY`, keyPage
   `https://console.anthropic.com/settings/keys`, login `paste`.
3. `openrouter`: endpoint `https://openrouter.ai/api/v1`, protocols
   `chat, responses`, keyEnv `OPENROUTER_API_KEY`, keyPage
   `https://openrouter.ai/settings/keys`, login `browser`.

`providerNames()` is the registry names joined with `", "`:
`openai, anthropic, openrouter`. Provider names are matched exactly
(case-sensitive) with `lookupProvider`.

Constants:

- `pasteAttempts = 3` -- pasted keys checked before giving up.
- `validateTimeout = 30s` -- bounds each key check request and the
  OpenRouter code exchange request (each request separately).
- `browserLoginTimeout = 5 minutes` -- wait for the browser callback.
  Swappable by tests.
- `openRouterAuthURL = "https://openrouter.ai/auth"`.
- `openRouterKeyLabel = "roast"` -- fixed so no project or directory
  name reaches a third party.
- Provider error and validation response bodies, and the exchange reply,
  are read at most 32 KiB (`32 << 10` bytes; spec.md change 9).

### 2.2 Streams

- stdout carries only the result lines: `stored <provider> credential
  (<scope> scope)` after a successful login, and logout's
  `removed ...` / `no ... stored ...` lines. A key, or any part of a key,
  never reaches stdout (a test checks that no 4-character substring of a
  pasted key, accepted or rejected, appears on stdout).
- Every prompt, URL, hint, and retry message goes to stderr.
- `<scope>` is `project` or `user` (credentials area scope constants).

### 2.3 `roast login [provider]`

Flags (both boolean, default false):

- `--global`: store the key for the user instead of this project.
- `--no-browser`: print the URL instead of opening a browser.

Arguments: at most one positional; more is a usage error (exit 2). Unknown
flags and malformed flag values are usage errors (cli area shared rules).

Help text (need not match cobra byte for byte): short `Store an API key
for a built-in provider`; long: get an API key for a built-in provider and
store it for this project (inside the Git directory), or for the user with
`--global`; environment variables still take precedence; with no
provider, log in to each built-in provider the project config's roles use
that has no credential yet.

#### With a provider argument (`runLogin`), in order

1. `lookupProvider(name)`; unknown -> usage error
   `unknown provider "<name>"; built-in providers: openai, anthropic,
   openrouter` (Go `%q` quoting of the name).
2. `interactiveTerminals(stdin, stderr)` false -> usage error
   `login needs an interactive terminal; set <keyEnv> instead`. This is
   checked before scope, so it wins over "not in a Git repository".
3. `loginPath(global)` (section 2.5); errors returned as is.
4. `loginProvider(provider, flags, path, scope, stdin, lines)` with a
   fresh shared line reader over stdin.

#### Without a provider argument (`runLoginMissing`), in order

1. Load the project config the normal CLI way (`loadProjectConfig("")`,
   cli area), which attaches the stored-credentials store for the working
   directory's repository and the user. No config found -> usage error
   `no project config (.roast.json) found; name a provider (\`npx roast
   login <provider>\`, one of openai, anthropic, openrouter) or run \`npx
   roast init\``. Other load errors are returned as is (already usage
   errors). No browser is opened and no request is sent in either case.
2. `providersNeedingLogin(cfg)` (section 2.4); its errors are usage
   errors.
3. Empty list -> write `every built-in provider the roles use already has
   a credential` plus newline to stderr, exit 0. This happens before the
   terminal check, so it succeeds without a terminal.
4. `interactiveTerminals` false -> usage error `login needs an interactive
   terminal` (no `set ...` hint).
5. `loginPath(global)`.
6. One shared line reader over stdin; for each provider in order call
   `loginProvider`. The first error stops the loop and is returned; keys
   stored by earlier iterations stay stored.

### 2.4 `providersNeedingLogin(cfg)`

Returns, in role-name order and without repeats, the built-in providers
of the config's roles that resolve no credential:

1. Take the role names present in `cfg.roles`, sorted ascending (so
   `finder` before `verifier`).
2. For each, `resolveRole(cfg, name, env)`. A resolution error (including
   a broken stored-credentials file reached during resolution) -> usage
   error carrying the resolution error's message.
3. Skip the role if its resolved `apiKey` is non-empty (any source: role
   variable, `api_key_env`, provider variable, project or user stored
   key).
4. `providerAt(role.baseURL, role.protocol)`; skip when there is none
   (custom endpoint: login cannot serve it) or the provider is already in
   the output (compared by name).
5. Append the provider.

Shared with `init` (section 2.10).

### 2.5 `loginPath(global)`

Returns `{path, scope}`:

- `global` true -> credentials `userCredentialsPath(env)` with scope `user`. The
  user path is `$XDG_CONFIG_HOME/roast/credentials.json` when
  `XDG_CONFIG_HOME` is non-empty, else `~/.config/roast/credentials.json`.
  A failure to find the home directory is returned as is (not a usage
  error, so exit 4); its message starts `user credentials: `.
- otherwise -> credentials `await projectCredentialsPath(cwd)` with scope
  `project`
  (`<git-common-dir>/roast/credentials.json`). Any failure (cwd not in a
  Git repository) -> usage error `not in a Git repository; use --global
  to store the key for the user`.

Shared by login, logout, and init. Keep scope rules in this one helper.

### 2.6 `loginProvider(...)`

1. Dispatch on `provider.login`: `paste` -> paste flow (2.7); `browser`
   -> OpenRouter flow (2.8); anything else -> plain error `login to
   <name> is not supported; set <keyEnv>` (unreachable with the current
   registry).
2. On a key, call credentials
   `saveCredential(path, provider.name, key, now)`. It
   replaces any key that provider already had in that file and keeps other
   providers' keys. Its errors (for example an existing file readable by
   group/others) are returned as is (exit 4).
3. Write `stored <name> credential (<scope> scope)\n` to stdout.

Logging in again replaces the stored key. Nothing is written to any file
on any failure path.

### 2.7 Paste flow (`pasteLogin`)

1. Write to stderr `Create a <name> API key at:\n  <keyPage>\n`.
2. Unless `--no-browser`: `openBrowser(keyPage)`. On failure write
   `could not open a browser (<err message>); open the URL above\n` to
   stderr and continue. A failing opener never fails login.
3. Up to `pasteAttempts` (3) times:
   1. `readSecret(stderr, stdin, lines, "Paste the key: ")`. Read errors
      -> error `read key: <err>`, returned immediately (exit 4). With a
      non-TTY stdin, EOF with no text on the line is such an error
      (`read key: EOF`); a final line without a trailing newline is
      accepted. The result is whitespace-trimmed.
   2. Empty key -> write `no key entered\n` to stderr; the attempt is
      used up; no request is sent.
   3. `validateKey(provider, key)` (2.9). Rejected -> write `<name>
      rejected the key; try again\n` to stderr and use up the attempt.
      Any other error is returned immediately (exit 4; no retry).
   4. Accepted -> return the key.
4. After 3 used attempts -> auth-kind error with message
   `llm: authentication failed: no accepted <name> key after 3 tries;
   nothing stored` (exit 3).

`readSecret` (cli area, section 2.16 there): on a real TTY stdin it reads
one line without echo (raw mode) and then writes a newline to stderr; a
`\x03` (Ctrl-C) byte in raw mode is cancellation, exit 5 (spec.md change
22; Go's `ISIG` raised SIGINT instead); on
any other stdin it reads one line from the shared line reader. Tests feed
several answers in one stdin string (`"key1\nkey2\n"`), so the same line
reader must serve every read in a command, including init's yes/no
prompts.

### 2.8 OpenRouter PKCE flow (`browserLogin`)

#### Secrets

- `verifier` = base64url without padding of 32 bytes from a CSPRNG
  (43 characters).
- `state` = base64url without padding of 16 CSPRNG bytes (22 chars).
- `challenge` = base64url without padding of SHA-256 over the ASCII bytes
  of `verifier`.

#### Approval URL

`https://openrouter.ai/auth?<query>` where the query holds:

| param                   | value                                  |
|-------------------------|----------------------------------------|
| `callback_url`          | callback mode only (below)             |
| `code_challenge`        | `challenge`                            |
| `code_challenge_method` | `S256`                                 |
| `key_label`             | `roast`                                |
| `state`                 | `state`                                |

Go encodes with `url.Values.Encode`: keys sorted ascending,
form-urlencoded (`:` -> `%3A`, `/` -> `%2F`, space -> `+`). TS must
produce the same string (sort the keys, then `URLSearchParams`).

#### Mode selection

Headless mode when `--no-browser`, or when there is no display: on Linux
only, both `DISPLAY` and `WAYLAND_DISPLAY` empty or unset (read from the
command's env, not `process.env`). macOS always has a display. Otherwise
callback mode.

#### Headless mode (`headlessCode`)

1. Write to stderr `Open this URL in a browser and approve Roast:\n
   <url>\n` (two-space indent; no `callback_url` in the query).
2. Write `Paste the code the page shows: ` (no newline) to stderr.
3. Read one plain line (echoed, not `readSecret`) from the shared line
   reader. EOF with no text -> error `read code: EOF`; other read errors
   -> `read code: <err>`. Trim whitespace.
4. Empty -> plain error `no code entered; nothing stored` (exit 4).
5. The browser is never opened in this mode.

#### Callback mode (`callbackCode`)

1. Listen on loopback (`listenLoopback`), up to 10 attempts:
   1. Listen TCP on `127.0.0.1:0` (OS-chosen port). Failure -> return
      that error at once.
   2. Listen TCP on `[::1]:<same port>`. Success -> use both listeners.
   3. Failure: probe whether `[::1]:0` can be listened on at all. If not
      (no IPv6 loopback) -> use the IPv4 listener alone. If it can, the
      port is taken on `::1`: close the IPv4 listener and retry.
   4. After 10 attempts -> the last `::1` error.
   Any listen failure is returned as `listen for the browser callback:
   <err>` (exit 4).
2. Serve an HTTP server on every listener with a 10 s header-read timeout
   and the callback handler (below).
3. Set `callback_url` = `http://localhost:<port>/callback` and build the
   approval URL. The host is the literal `localhost` so the browser may
   resolve it to either loopback address.
4. Write `Approve Roast in your browser:\n  <authURL>\n` to stderr, then
   `openBrowser(authURL)`; on failure write `could not open a browser
   (<err>); open the URL above\n` and keep waiting.
5. Wait for the first of:
   - the callback result -> its code or its error;
   - cancellation of the command signal -> cancellation error (exit 5);
   - `browserLoginTimeout` -> plain error `no approval from the browser
     within 5m0s; nothing stored` (Go duration formatting of the timeout;
     exit 4).
6. On every return path (success, error, timeout, cancellation) close the
   server and all listeners before returning, so the exchange and key
   check run with the port already released. A test checks the port no
   longer accepts connections after login ends, on the success, rejected
   key, exchange failure, and timeout paths.

Callback handler:

- Only `GET /callback` is routed (Go 1.22 mux: `HEAD` also matches; other
  methods on that path get 405, other paths 404).
- Query `state` not equal to the expected state (including missing) ->
  400, text/plain body `This login link does not match the one Roast
  started.\n`. The wait is not settled; a forged callback only leads to
  the timeout. No exchange happens.
- Matching state: `code` = query `code`. Empty code -> result error
  `OpenRouter returned no code; nothing stored`.
- Only the first matching callback is accepted (one-slot buffer). A later
  matching callback -> 409, body `Roast already received a response.\n`.
- Accepted with error -> 400, `Content-Type: text/plain; charset=utf-8`,
  body `Login failed. Return to your terminal.\n`.
- Accepted with a code -> 200, `Content-Type: text/plain; charset=utf-8`,
  body `Roast received the key. You can close this tab.\n`. This page is
  sent before the exchange runs, so it shows even if the exchange later
  fails.
- An `error` query parameter from OpenRouter is not inspected; a callback
  without a code is the "no code" case.

#### Exchange (`exchangeCode`)

`POST https://openrouter.ai/api/v1/auth/keys` (provider endpoint with
trailing `/` removed, plus `/auth/keys`), header `Content-Type:
application/json`, no credential header, body (Go marshals a map, so keys
are sorted):

```json
{"code":"<code>","code_challenge_method":"S256","code_verifier":"<verifier>"}
```

30 s timeout. Outcome:

- transport failure -> endpoint-kind error `llm: inference endpoint
  failure: exchange code at <url>: <err>` (exit 4);
- 401 or 403 -> auth-kind error `llm: authentication failed: openrouter
  refused the approval code; nothing stored` (exit 3);
- other non-2xx -> endpoint-kind `... exchange code at <url>: HTTP <code>
  <reason>` (Go `resp.Status`, for example `503 Service Unavailable`);
- 2xx: decode the first JSON value from at most 32 KiB of the body; take
  string field `key` (other fields ignored). Decode failure or empty key
  -> endpoint-kind `... exchange code at <url>: no key in reply`.

#### Minted key check

`validateKey(provider, mintedKey)` (2.9, path `/key`). Rejected ->
auth-kind error `llm: authentication failed: openrouter rejected the key
it minted; nothing stored` (exit 3). Other errors returned as is. There is
no retry anywhere in the browser flow; success returns the minted key to
`loginProvider`, which stores it.

### 2.9 Key check (`validateKey`)

One request that succeeds only with a valid key:

- URL: provider endpoint with trailing `/` removed, plus `/key` for
  `openrouter` (OpenRouter lists models without a key), else `/models`:
  `https://api.openai.com/v1/models`,
  `https://api.anthropic.com/v1/models`,
  `https://openrouter.ai/api/v1/key`.
- Method `GET`, no body, 30 s timeout, chained to the command signal.
- Headers: when `provider.protocols[0] === 'anthropic'`:
  `x-api-key: <key>` and `anthropic-version: 2023-06-01`; otherwise
  `Authorization: Bearer <key>`. No other headers are required.
- Sent through the command's swappable `fetch` (tests redirect built-in
  endpoints to the fake). Every redirect is refused (`redirect:
  'manual'`; any 3xx is an endpoint-kind error, spec.md change 8), so
  neither `Authorization` nor `x-api-key` can cross origins. Go forwarded
  `x-api-key` on a cross-origin redirect; this is a deliberate change.
- The body is drained up to 32 KiB and discarded. A 3xx response is an
  endpoint-kind error `llm: inference endpoint failure: check key at
  <url>: redirect refused`.
- 2xx -> accepted. 401 or 403 -> rejected (internal sentinel, not
  surfaced directly). Transport failure -> endpoint-kind `llm: inference
  endpoint failure: check key at <url>: <err>`. Any other status ->
  endpoint-kind `... check key at <url>: HTTP <code> <reason>`.

Debug output (deliberate change 5) may log the URL and status, never the
key or headers.

### 2.10 Reuse by `init` (behavior owned by file 14)

`init`'s login offer, after writing the starter config, calls
`providersNeedingLogin` on the freshly loaded config with stored
credentials attached; if any, and terminals are interactive, it calls
`loginPath(false)` (project scope only), creates one shared line reader,
and for each provider asks `promptYesDefault(stderr, lines, "Log in to
<name> now?")` and on yes calls `loginProvider` with default flags (no
`--global`, browser allowed) and the same `lines`. A `loginProvider` error
is printed as `login to <name> failed: <err>` and does not fail `init`.
This area must export those three functions with that sharing contract.

### 2.11 `roast logout [provider]`

Flags: `--global` (boolean, default false): remove the key stored for the
user instead of this project. No `--no-browser`. At most one positional.
No terminal is required. No network request is made.

Help: short `Remove a stored API key`; long: remove the stored API key
for a built-in provider, or for every provider with no argument, from this
project (or the user with `--global`); the key is not revoked at the
provider.

In order:

1. Provider list: with an argument, `lookupProvider`; unknown -> usage
   error `unknown provider "<name>"; built-in providers: openai,
   anthropic, openrouter`, nothing changed. Without one, every built-in
   provider in registry order (openai, anthropic, openrouter).
2. `loginPath(global)` (outside a repository without `--global` -> the
   same usage error as login; the user file is untouched).
3. `loadCredentials(path)` from credentials (a missing file is an empty
   map; a bad
   file, for example group-readable, is an error, exit 4).
4. For each provider in the list:
   - Not stored: with an explicit argument write `no <name> credential
     stored (<scope> scope)\n` to stdout; without one, say nothing.
   - Stored: credentials `deleteCredential(path, name)` (errors returned), then
     stdout `removed <name> credential (<scope> scope)\n`, then stderr
     `The key was not revoked at <name>; revoke it at:\n  <keyPage>\n`.
5. Exit 0, including when nothing was stored. Logout with nothing stored
   creates no file. Only the chosen scope's file changes.

### 2.12 Exit codes

Using the cli area's mapping (cancellation 5, auth kind 3, usage 2,
anything else 4):

| Situation                                              | Exit |
|--------------------------------------------------------|------|
| Key stored / logout done / no provider needs login     | 0    |
| Unknown provider, extra args, bad flag                 | 2    |
| No interactive terminal (login only)                   | 2    |
| Project scope outside a Git repository                 | 2    |
| No project config, invalid config, role resolution     | 2    |
| 3 rejected or empty pasted keys                        | 3    |
| OpenRouter refused code (401/403) or minted key reject | 3    |
| Key check 5xx/other status or network failure          | 4    |
| Read error / EOF on stdin                              | 4    |
| No code entered, callback without code, timeout        | 4    |
| Listen failure, exchange failure, no key in reply      | 4    |
| Credentials file unreadable/unsafe, save/delete error  | 4    |
| `--global` with no home directory                      | 4    |
| Command signal aborted (SIGINT/SIGTERM)                | 5    |

## 3. TypeScript module design

### 3.1 Files

```
src/cli/login.ts            login command, runLogin, runLoginMissing,
                            providersNeedingLogin, loginProvider,
                            loginPath, providerNames, pasteLogin,
                            validateKey, keyCheckPath
src/cli/openrouter-login.ts browserLogin, hasDisplay, headlessCode,
                            callbackCode, callbackHandler,
                            listenLoopback, exchangeCode, randomToken
src/cli/logout.ts           logout command, runLogout
test/cli/login.ts           login tests (paste and no-argument)
test/cli/openrouter-login.ts
test/cli/logout.ts
test/helpers/provider-server.ts  shared fake (also used by init tests)
```

### 3.2 Exports

```ts
export interface LoginFlags {
    global:boolean;
    noBrowser:boolean;
}

export interface LoginContext {
    cwd:string;
    env:Readonly<Record<string, string|undefined>>;
    signal:AbortSignal;
    fetch:typeof globalThis.fetch;
    stdin:NodeJS.ReadableStream;
    stdout:NodeJS.WritableStream;
    stderr:NodeJS.WritableStream;
    lines:LineReader;            // one per command invocation
}

export interface LoginTarget {
    path:string;
    scope:'project'|'user';
}

export function providerNames ():string
export function loginPath (global:boolean, ctx:LoginContext):LoginTarget
export function providersNeedingLogin (
    cfg:ProjectConfig,
    env:Env
):BuiltinProvider[]
export function loginProvider (
    provider:BuiltinProvider,
    flags:LoginFlags,
    target:LoginTarget,
    ctx:LoginContext
):Promise<void>
export function validateKey (
    provider:BuiltinProvider,
    key:string,
    ctx:LoginContext
):Promise<void>   // throws KeyRejected | llm EndpointError

// openrouter-login.ts
export const loginTimeouts = { browser: 5 * 60_000 }  // tests shorten
export function browserLogin (
    provider:BuiltinProvider,
    flags:LoginFlags,
    ctx:LoginContext
):Promise<string>
```

`KeyRejected` is a module-private error class (Go `errKeyRejected`); it
must never escape `pasteLogin` / `browserLogin` unwrapped.

`LineReader` is the cli area's shared line reader (`src/cli/terminal.ts`).
`readSecret`, `openBrowser`, `interactiveTerminals`, and
`promptYesDefault` come from there; tests swap `openBrowser` and
`interactiveTerminals` as module-level functions.

### 3.3 Implementation notes

- Random bytes: `crypto.randomBytes(n).toString('base64url')` (Node's
  base64url has no padding). SHA-256: `createHash('sha256')
  .update(verifier, 'ascii').digest('base64url')`.
- Loopback: `node:http` `createServer` with `headersTimeout: 10_000`,
  `listen({host: '127.0.0.1', port: 0})`, then the same port with `host:
  '::1', ipv6Only: true`. On `EADDRINUSE` for `::1`, probe `::1:0`; follow
  section 2.8 step 1. Close with `server.close()` plus
  `closeAllConnections()` so keep-alive sockets do not hold the port.
- Use `URLSearchParams` over keys added in sorted order for the approval
  URL query.
- Waiting: race the callback promise, `AbortSignal.timeout(browser)`,
  and `ctx.signal`, in a `try/finally` that closes the servers.
- Requests: `ctx.fetch(url, {signal: AbortSignal.any([ctx.signal,
  AbortSignal.timeout(30_000)])})`. A `TimeoutError` from the request
  timeout is a transport failure (endpoint kind), not cancellation; an
  abort from `ctx.signal` is cancellation.
- Redirects: pass `redirect: 'manual'` and treat any 3xx as an
  endpoint-kind error, for key validation and the code exchange alike.
- Body reads: read at most 32 KiB then cancel the stream.
- Error kinds: the llm area's auth and endpoint error classes; messages
  keep the Go prefixes (`llm: authentication failed: ...`, `llm:
  inference endpoint failure: ...`) by the llm area's convention.
- `hasDisplay(env)`: `process.platform !== 'linux'` -> true; else
  `Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY)`.
- The loopback test client uses the real `fetch`, never the swapped one.

### 3.4 Dependencies

- cli area: `UsageError`, error mapping, `LineReader`, `readSecret`,
  `openBrowser`, `interactiveTerminals`, `loadProjectConfig`,
  `NoProjectConfigError`, command registration.
- config area: `lookupProvider`, `providerAt`, `builtinProviders`,
  `BuiltinProvider`, `resolveRole`, `ProjectConfig`.
- llm area: auth and endpoint error kinds.
- trust-and-credentials area, credentials module
  (`src/credentials/credentials.ts`, see `03-trust-credentials.md`
  section 3): `CredentialScope`, `projectCredentialsPath(dir)` (async;
  throws outside a repository), `userCredentialsPath(env)` (throws
  "user credentials: ..." without a home directory),
  `loadCredentials(path)` (async, missing file is an empty map),
  `saveCredential(path, provider, key, storedAt)` (async; validates the
  provider name and non-empty key, keeps other entries, writes
  atomically with 0600 in a 0700 directory), and
  `deleteCredential(path, provider)` (async; a missing file or absent
  provider does nothing).

## 4. Deliberate changes

- Windows is not supported (decision 2): `openBrowser` uses `open` on
  macOS and `xdg-open` on Linux; the Go `rundll32` branch is gone.
  `hasDisplay` is unchanged in substance (Linux-only check); it reads the
  command's `io.env`, and tests set `DISPLAY` / `WAYLAND_DISPLAY`
  explicitly, so CI never depends on a real display.
- Every redirect is refused, including during key validation, so
  `x-api-key` never crosses origins (spec.md change 8).
- Ctrl-C (`\x03`) at a raw-mode secret prompt is cancellation, exit 5
  (spec.md change 22).
- Provider error and validation bodies are read at most 32 KiB (spec.md
  change 9).
- Debug tracing (decision 5) under `roast:login` may log provider names,
  URLs (the approval URL contains no secret: the verifier is never in
  it), statuses, and the chosen mode; never keys, codes, verifiers,
  headers, or bodies.
- The headless OpenRouter flow (no `callback_url`) needs a manual check
  against the live service before release (spec.md Further Notes).
- No other deliberate changes: messages, URLs, query parameters, headers,
  and exit codes keep Go behavior.

## 5. Test plan

Seam: in-process `run(argv, io)` with injected stdin string, env (isolated
`HOME`, `XDG_CONFIG_HOME`), cwd in a temp Git repository, a swapped
`fetch` that routes the three built-in endpoints to a `node:http` fake
provider (Go `providerServer` + `redirectDefaultTransport`), swapped
`interactiveTerminals` (true unless the test says otherwise), and a
captured `openBrowser` (records URLs, never launches). The fake answers
`GET /v1/models` (records the `x-api-key` or `Authorization` value,
status per credential via `answerModels`), `POST /api/v1/auth/keys`
(records the decoded body, mints `sk-or-minted-<code>`), and
`GET /api/v1/key` (status via `answerKey`). OpenRouter tests run login
concurrently (`startRoast`), wait for the opened URL (`awaitOpened`), and
request its `callback_url` with real `fetch` (`callOpenRouterBack`); they
set `DISPLAY` in the injected env on Linux and shorten
`loginTimeouts.browser`. Assertions are on exit codes, files written, and
requests received, not on human text.

A validation request answered with a redirect (to another origin) fails
with an endpoint error (exit 4), and the fake never receives an
`x-api-key` at the redirect target. A `\x03` fed to a raw-mode secret
prompt exits 5 and stores nothing.

Paste login:

- A pasted key (surrounding spaces trimmed) is stored for the project and
  a later review sends it (TestLoginStoresAPastedKeyForTheProject).
- `--global` stores only in the user file; the check sent `Bearer <key>`
  for OpenAI (TestLoginGlobalStoresTheKeyForTheUserOnly).
- The key page is opened, and not with `--no-browser`
  (TestLoginOpensTheKeyPageUnlessNoBrowser).
- A failing browser opener does not fail login
  (TestLoginSucceedsWhenTheBrowserCannotOpen).
- A rejected key is asked for again and the good one stored
  (TestLoginAsksAgainAfterARejectedKey).
- Three rejected keys: exit non-zero, exactly 3 checks, no file
  (TestLoginStoresNothingAfterThreeRejectedKeys).
- Key check 5xx or network failure: exit neither 0, 2, nor 3; no file
  (TestLoginStoresNothingWhenTheKeyCannotBeChecked).
- Logging in again replaces the key (TestLoginAgainReplacesTheStoredKey).
- Usage errors (exit 2): unknown provider; no terminal (with and without
  `--global`, no files); project scope outside a repository
  (TestLoginUsageErrors).
- No part of any pasted key reaches stdout, and stdout is non-empty
  (TestLoginNeverPrintsTheKeyToStdout).

No-argument login:

- Logs in to each provider the roles use, in role order, reading answers
  from one stdin string (TestLoginWithNoArgumentLogsInToEveryProvider
  TheRolesUse).
- No project config: exit 2, no files, no request, no browser
  (TestLoginWithNoArgumentAndNoProjectConfigIsAUsageError).
- Providers with an env or stored credential are skipped: only the other
  provider is opened and checked; with all covered, nothing is written,
  sent, or opened (TestLoginWithNoArgumentSkipsProvidersThatHaveA
  Credential).

OpenRouter:

- The approval URL is `https://openrouter.ai/auth` with `S256`, `key_label
  =roast`, a state, and `callback_url` `http://localhost:<port>/callback`;
  the exchange body carries the code and a verifier whose S256 is the
  challenge (TestOpenRouterLoginURLCarriesAnS256Challenge).
- The minted key is stored for the project only, the callback answers
  200, and the minted key was checked with `Bearer`
  (TestOpenRouterLoginStoresTheMintedKeyForTheProject).
- A mismatched state answers >= 400, never exchanges, and login fails
  (TestOpenRouterLoginRejectsAMismatchedState).
- No callback within the timeout fails without exchange
  (TestOpenRouterLoginGivesUpWithoutACallback).
- A minted key the provider rejects is not stored, after one exchange
  (TestOpenRouterLoginStoresNothingWhenTheMintedKeyIsRejected).
- `--no-browser` prints a URL without `callback_url`, opens nothing,
  reads a pasted (trimmed) code, and stores the minted key
  (TestOpenRouterLoginNoBrowserReadsAPastedCode).
- The listener is closed on success, rejected key, exchange failure, and
  timeout (TestOpenRouterLoginClosesTheListenerOnEveryPath).

Logout:

- Removes only the named provider's project key; a later review has no
  credential and sends nothing
  (TestLogoutRemovesOnlyThatProvidersProjectKey).
- No argument removes every stored key
  (TestLogoutWithNoProviderRemovesEveryStoredKey).
- Only the chosen scope changes, both directions
  (TestLogoutChangesOnlyTheChosenScope).
- Nothing stored: exit 0 for named, unnamed, and `--global`; no file
  created (TestLogoutWithNothingStoredSucceeds).
- Unknown provider and project scope outside a repository are exit 2 and
  change nothing (TestLogoutUsageErrors).

New TS tests worth adding (behavior already in Go, not pinned there):
empty pasted line counts as an attempt with no request; stdin EOF before
a key is exit 4; exchange 401 is exit 3; a second matching callback gets
409; no-argument login with every provider covered exits 0 without a
terminal.

## 6. Go baseline references

At commit `cd08f10`:

- `internal/cli/login.go` -- command, `runLogin`, `runLoginMissing`,
  `providersNeedingLogin`, `loginProvider`, `loginPath`, `pasteLogin`,
  `validateKey`, `keyCheckPath`.
- `internal/cli/openrouter_login.go` -- PKCE flow, loopback callback,
  exchange.
- `internal/cli/logout.go` -- logout.
- `internal/cli/prompt.go` -- `openBrowser`, `interactiveTerminals`,
  `readSecret`, `promptYesDefault`.
- `internal/cli/init.go` (login offer, lines 75-115) -- reuse contract.
- `internal/config/provider.go`, `internal/config/config.go` (default
  endpoints), `internal/credentials/credentials.go`, `internal/llm/
  errors.go`.
- Tests: `internal/cli/login_test.go`, `internal/cli/logout_test.go`,
  `internal/cli/init_test.go` (`providerServer`),
  `internal/cli/stored_credentials_test.go`,
  `internal/cli/settings_test.go` (`redirectDefaultTransport`).

## 7. Resolved

Resolved (maintainer decisions, see spec.md):

1. `hasDisplay`: tests set `DISPLAY` / `WAYLAND_DISPLAY` explicitly
   through `io.env`; CI never depends on a real display.
2. The headless OpenRouter flow (no `callback_url`) needs a manual check
   against the live service before release (spec.md Further Notes).
3. Ctrl-C (`\x03`) at a raw-mode secret prompt is cancellation, exit 5
   (spec.md change 22).
4. Every redirect is refused, including during key validation, so
   `x-api-key` never crosses origins (spec.md change 8).
5. Credentials names follow `03-trust-credentials.md` section 3
   (resolved earlier).
6. Provider error and validation response bodies are read at most 32 KiB
   (spec.md change 9).
