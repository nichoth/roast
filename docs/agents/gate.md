# Gate

`src/gate/`, `src/cli/gate.ts`, `src/cli/gate-offer.ts`.

## Hook behavior

- The hook (`src/gate/pre-commit.sh`, imported as `HOOK_SCRIPT`) runs
  only `node_modules/.bin/roast` at the Git toplevel, never `PATH`. It
  first calls the hidden `roast gate settings` (prints
  `timeout_seconds=` and `severity=` lines from the config's `gate`
  section, defaults 180/HIGH), then `roast review --staged ...
  --max-severity <severity>`. Any failure, including a settings query
  that exits non-zero, warns and allows the commit; only review exit 1
  blocks.
- The hook runs from the Git toplevel without `--config`, so it sees
  only a toplevel `.roast.json` (`gateConfigPath` in
  `src/cli/config.ts`). `gate enable` refuses and the review-time
  bootstrap stays silent without one; `gate enable` tests write a
  toplevel config first.
- Installed hooks are refreshed by content comparison with the script,
  so editing it needs no version bump.
- `HOOK_SCRIPT` stays byte-identical to the script the Go releases
  installed, so those hooks are not reported stale. `hook.ts` handles
  hook bodies as `Buffer`s so strip keeps every foreign byte. Hook
  writes use `fsutil` `writeFileAtomic` with `mode`.

## Tests

- Hook execution tests drive a real `git commit` with a shell stub that
  `newStub(t, repo...)` (`test/gate/exec-helpers.ts`) writes at each
  repo's `node_modules/.bin/roast`. It answers `gate settings` from
  `STUB_TIMEOUT` / `STUB_SEVERITY` and logs only the review call
  (`ARGS:` plus the staged diff), so `stub.ran` is empty when no review
  happened.
- Gate tests build repos with `gateRepo(t)` (`test/gate/helpers.ts`:
  global/system git config cut out, maintenance off, toplevel
  `.roast.json`); hook execution tests use `seededRepo`, `newStub`, and
  `commit` from `test/gate/exec-helpers.ts`.
- Simulate a non-local `roast.gate` with
  `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, never a global file.
- `ROAST_TEST_SKIP_GATE_TIMEOUT=1` skips the sleeping tests.
- The review-time offer (`src/cli/gate-offer.ts`, `src/gate/bootstrap.ts`)
  runs at the start of every `review` / bare `roast` with a toplevel
  config. Without terminals it records `roast.gate-notice=sent`; with
  `simulateTerminals(t, true)` it reads the first stdin line. A review
  test that feeds stdin to a later prompt (trust, keys) must first record
  `roast.gate` or set `gate.offer: false`, or account for the offer
  taking that line. Offer tests are in `test/cli/gate-offer.ts`.
