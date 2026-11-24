# 30: Gate offer during review

**Blocked by:** 20, 29
**Touches:** `src/gate/bootstrap.ts` (`bootstrap`, `Outcome`,
`BootstrapOptions`), `src/cli/gate-offer.ts` (`maybeBootstrapGate`),
the root and `review` command wiring in `src/cli/run.ts` /
`src/cli/review.ts`, `test/cli/gate-offer.ts`
**Spec:** `spec/01-cli.md` 2.9, 3.4 (bootstrap after `--error-format`
validation); `spec/12-gate.md` 2.11, 3 (`bootstrap.ts`,
`bootstrap-gate.ts`), 5 (Bootstrap and the Shared dispatcher bootstrap
rows)
**Status:** done

## What to build

When a user runs bare `npx roast` or `npx roast review` in a repository
that has a toplevel `.roast.json` and no recorded gate decision, Roast
offers the pre-commit gate before the review starts. The offer runs
before trust, scope, or any network. On a terminal it asks once (yes
installs and records `enabled`; no records `declined` and never asks
again). Without a terminal it prints a hint once per repository and
records `roast.gate-notice=sent`. It never installs a hook without
consent and never fails the review: an error prints a warning and the
review continues.

The offer is skipped when:

- `--error-format json` is set (`--format json` does not skip it);
- `GIT_INDEX_FILE` is set, meaning Roast is running inside a hook;
- `gate.offer: false` (this does not consume the notice);
- cwd is not in a repository;
- the config exists only in a subdirectory;
- the toplevel config fails to load (the review then reports the error).

`ROAST_NO_HOOK` has no effect.

The bootstrap also refreshes a stale Roast-owned dispatcher or sidecar
(steps 3 and 4 of 2.11). It never adopts an inherited shared gate.

The prompt reads from the one shared stdin line reader. Terminal
detection uses the swappable `interactiveTerminals`, so tests simulate
terminals and feed answers through `io.stdin`. Observe outcomes through
local git config and hook files, not stderr text.

## Acceptance criteria

- [x] With terminals simulated and stdin `y\n`, a review in a repo with
      a toplevel approved config installs the hook and sets
      `roast.gate=enabled`. The review then proceeds against the fake
      server.
- [x] With stdin `n\n`, `roast.gate=declined` is recorded and no hook is
      written. A second review with terminals simulated does not consume
      any stdin for the offer.
- [x] Without terminals, the first review sets
      `roast.gate-notice=sent` and writes no hook. A second review
      leaves the config unchanged.
- [x] `GIT_INDEX_FILE` set in `io.env` suppresses the offer: no
      `roast.gate*` keys change.
- [x] `gate.offer: false` neither prompts nor hints and leaves
      `roast.gate-notice` unset.
- [x] `ROAST_NO_HOOK=1` in `io.env` does not stop the offer.
- [x] A config only in a subdirectory gives no offer. A toplevel config
      gives one, also under `--format json`. `--error-format json` gives
      none.
- [x] A toplevel config that fails to load gives no offer, and the
      review exits 2 with the config error.
- [x] A declined repo with a stale legacy shared dispatcher gets the
      dispatcher refreshed. An inherited shared gate in a repo with no
      local decision is not adopted (`roast.gate` stays unset).
- [x] A bootstrap failure, such as an unwritable hooks directory after
      a yes, does not change the review's exit code.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
