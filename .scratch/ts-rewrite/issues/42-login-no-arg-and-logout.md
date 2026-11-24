# 42: `login` paste flow, part 3 -- no-argument `login` and `logout`

**Blocked by:** 41
**Touches:** `src/cli/login.ts` (`runLoginMissing`,
`providersNeedingLogin`, `loginProvider`), `src/cli/logout.ts` (`logout`
command, `runLogout`), `test/cli/login.ts`, `test/cli/logout.ts`
**Spec:** `spec/13-login.md` 2.3 ("Without a provider argument"), 2.4,
2.6, 2.10, 2.11, 2.12, 3, 5 (No-argument login, Logout)
**Status:** done

## What to build

`npx roast login` with no argument logs in to each built-in provider the
project config's roles use that has no credential yet, in role order.
`npx roast logout [provider] [--global]` deletes stored keys from the
chosen scope.

This also builds the shared pieces that `init` (ticket 34) and the
OpenRouter browser flow (ticket 32) reuse:

- `providersNeedingLogin` and `loginProvider`. `loginProvider` reads
  answers through one `LineReader` passed in, never a fresh reader.

Leave a clear dispatch point in `loginProvider` for `login: 'browser'`
providers. Ticket 32 fills it in. Until then OpenRouter login may fail
with a plain error.

Reuse `loginPath`, `providerNames`, and `pasteLogin` from tickets 31 and
41; do not duplicate them.

## Acceptance criteria

- [x] `login` with no argument logs in to each needed provider in role
      order from one stdin string. It exits 2 with no files, requests,
      or browser opens when there is no project config. It skips
      providers that have an env or stored credential, and with every
      provider covered it exits 0 without a terminal.
- [x] `logout anthropic` removes only that provider's project key, and a
      later review sends no credential. `logout` with no argument
      removes every stored key. Only the chosen scope changes.
- [x] `logout` with nothing stored exits 0 (named, unnamed,
      `--global`) and creates no file. An unknown provider or project
      scope outside a repository exits 2 and changes nothing.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
