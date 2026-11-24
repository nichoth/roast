# 32: OpenRouter PKCE browser login

**Blocked by:** 31, 41, 42
**Touches:** `src/cli/openrouter-login.ts` (`browserLogin`,
`hasDisplay`, `headlessCode`, `callbackCode`, `callbackHandler`,
`listenLoopback`, `exchangeCode`, `randomToken`, `loginTimeouts`),
`src/cli/login.ts` (dispatch for `login: 'browser'` providers),
`test/helpers/provider-server.ts` (`POST /api/v1/auth/keys`,
`GET /api/v1/key`, `answerKey`), `test/cli/openrouter-login.ts`
(`startRoast`, `awaitOpened`, `callOpenRouterBack`)
**Spec:** `spec/13-login.md` 2.8, 3.2 to 3.3, 4, 5 (OpenRouter rows and
the new TS tests); spec.md Further Notes (headless check)
**Status:** done

## What to build

`npx roast login openrouter` mints and stores an OpenRouter key through
OAuth PKCE. Roast opens `https://openrouter.ai/auth` with an S256
challenge, `key_label=roast`, a random state, and a `callback_url` on a
loopback listener. It waits for the callback, checks the state,
exchanges the code plus verifier at `POST /api/v1/auth/keys`, checks the
minted key with `GET /api/v1/key` using `Bearer`, and stores it in the
chosen scope. If there is no display (Linux without `DISPLAY` /
`WAYLAND_DISPLAY`) or `--no-browser` is set, the URL is printed without
`callback_url` and the user pastes the code (headless mode).

The loopback server listens on `127.0.0.1:0` and then the same port on
`::1` (2.8 step 1). It has a header timeout. It answers a mismatched
state with >= 400 and a second matching callback with 409. It is closed
on every path, including success, rejected key, exchange failure,
timeout, and cancellation. All provider requests use the swappable
`fetch`, `redirect: 'manual'` (any 3xx is an endpoint error), a 30 s
timeout, and 32 KiB body reads.

Tests run login concurrently, read the opened URL from the captured
`openBrowser`, and hit its `callback_url` with the real `fetch`. They
set `DISPLAY` in the injected env on Linux and shorten
`loginTimeouts.browser`, so a regression fails fast instead of waiting
five minutes.

The headless flow also needs a manual check against the live
OpenRouter service before release. That check is tracked in ticket 38,
not here.

## Acceptance criteria

- [x] The opened approval URL has origin and path
      `https://openrouter.ai/auth` and `code_challenge_method=S256`,
      `key_label=roast`, a non-empty state, and `callback_url`
      `http://localhost:<port>/callback`. The exchange body carries the
      code and a verifier whose base64url SHA-256 equals the challenge.
- [x] After the callback, the minted key `sk-or-minted-<code>` is stored
      for the project only. The callback answered 200, and the key check
      used `Authorization: Bearer <minted key>`.
- [x] A callback with a mismatched state answers >= 400. Login then
      fails with no exchange request. A second matching callback
      answers 409.
- [x] No callback within the shortened timeout fails without an
      exchange and stores nothing.
- [x] A minted key that the provider rejects is not stored, after
      exactly one exchange. An exchange answered 401 exits 3.
- [x] `--no-browser` prints a URL without `callback_url`, opens
      nothing, reads a pasted (trimmed) code from stdin, and stores the
      minted key.
- [x] On Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY` in `io.env`,
      the headless mode is chosen.
- [x] After success, rejected key, exchange failure, and timeout, the
      loopback port no longer accepts connections.
- [x] A redirect answer to the exchange or the key check is an endpoint
      error (exit 4) and is not followed.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
