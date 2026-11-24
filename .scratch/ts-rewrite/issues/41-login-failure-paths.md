# 41: `login` paste flow, part 2 -- rejected keys, errors, and cancellation

**Blocked by:** 31
**Touches:** `src/cli/login.ts` (`pasteLogin`, `validateKey`),
`src/cli/terminal.ts` (raw-mode `readSecret` Ctrl-C handling),
`test/helpers/provider-server.ts`, `test/cli/login.ts`
**Spec:** `spec/13-login.md` 2.3 ("With a provider argument"), 2.5, 2.7,
2.9, 2.12, 4, 5 (Paste login failure rows, and the redirect and `\x03`
rows); spec.md deliberate changes 8, 9, 22
**Status:** done

## What to build

The failure paths of `npx roast login <provider>` for the paste
providers. Ticket 31 built the success path; extend it, do not rewrite
it.

Roast allows up to three attempts at the key prompt. Key validation
uses the swappable `fetch` with `redirect: 'manual'`. Any 3xx is an
endpoint error and the key never crosses origins (deliberate change 8).
Bodies are read at most 32 KiB (change 9). Ctrl-C (`\x03`) at a raw-mode
secret prompt is cancellation, exit 5 (change 22).

No-argument `login`, `loginProvider`, and `logout` are ticket 42.

## Acceptance criteria

- [x] A rejected key is asked for again and the next good one stored.
      Three rejected keys exit non-zero after exactly 3 checks, with no
      file written. An empty pasted line counts as an attempt and sends
      no request.
- [x] A 5xx or network failure on the key check exits with a code other
      than 0, 2, or 3 and writes no file.
- [x] A key check answered with a redirect to another origin exits 4,
      and the redirect target never receives `x-api-key` or
      `Authorization`.
- [x] `\x03` at a raw-mode secret prompt exits 5 and stores nothing.
      Stdin EOF before a key exits 4.
- [x] Usage errors (exit 2, no files written) for an unknown provider,
      for no terminal (with and without `--global`), and for project
      scope outside a repository.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
