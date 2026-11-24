# TypeScript

Applies to `src/`, `test/`, and `scripts/`. Notes for one area are in
that area's file (index in `AGENTS.md`).

## Tooling

- `npm test` builds `dist/cli.js`, then bundles and runs the tapzero
  suite; it does not typecheck. A new test module must be imported from
  `test/index.ts`. esbuild drops unused imports without resolving them,
  so only `npm run typecheck` catches a broken import.
- `npm run test:one -- test/<area>/<file>.ts` bundles one test module
  to `test/one-bundle.js` and runs it through tap-spec. Test modules
  cannot run directly under Node: their `.js` import specifiers only
  resolve once bundled. It does not typecheck; run `typecheck` too.
- Lint with `npm run lint`: it preloads `scripts/eslint-ts6.ts`, which
  gives eslint the TypeScript 6 API because typescript-eslint throws on
  the TypeScript 7 that `typecheck` uses.
- Node runs `scripts/` directly (type stripping), so they use only
  erasable syntax: no enums, namespaces, or parameter properties.
- `baseOptions` in `scripts/esbuild-options.ts` holds the esbuild
  options every bundle shares (text loaders for `.tmpl`, `.md`, `.sh`;
  `mainFields: ['module', 'main']`, which `jsonc-parser`'s UMD build
  needs); `scripts/bundle.ts` adds the `require` shim banner. A test
  that bundles code itself uses both.
- `npm run build` also writes `dist/THIRD_PARTY_LICENSES.txt`
  (`scripts/licenses.ts`) and fails, naming the package, when a bundled
  package lacks an allowlisted `license` field or a license file. A new
  runtime library must pass it; extending `ALLOWED_LICENSES` needs
  maintainer approval. `@substrate-system/debug` fails it today, so no
  `src/` module may import it yet. Runtime libraries are
  `devDependencies` (bundled); `dependencies` stays empty.

## Source conventions

- Keep source ASCII: write `\uXXXX` escapes. Some editing tools decode
  escapes into literal characters when writing; check with
  `grep -nP '[^\x00-\x7f]'` after writing a file. eslint `--fix`
  (quote-props) rewrites a quoted `'\u00e9'` object key into a literal
  non-ASCII identifier; put such keys in a const and use a computed key.
- eslint rejects control characters in regex literals
  (`no-control-regex`) and labeled statements (`no-labels`); scan char
  codes and use helper functions instead.
- Startup guards live in `src/startup.ts`, not `src/cli.ts`: importing
  the entry runs the CLI, so testable helpers sit in other modules.
- Module-level swappable functions use a mutable hooks object plus a
  delegating export (`terminalHooks`, `skillHooks.lookPath`), because
  tests cannot reassign an ESM `let` export. Swap the object's field
  and restore it in `t.cleanup`.
- Shared helpers; import these, never re-implement:
  `src/gocompat/` (`strings.ts`: Go TrimSpace/Ext/`%.2f`/strconv.Quote/
  byte-order sort and `truncateUtf8`; `duration.ts`: Go durations as
  bigint nanoseconds; `match.ts`: Go `path.Match`),
  `src/textsafe/textsafe.ts`, `src/fsutil/atomic.ts`
  (`writeFileAtomic`, options cover trust, credentials, and gate temp
  names and error messages), `src/git/git.ts` (the only git runner;
  pass the CLI context's `env`, it reads `process.env` only when none is
  given), `src/util/pool.ts` (`mapPool`).

## CLI core (`src/cli/`)

- Commands are `CommandDef`s (`command.ts`) listed in `commands.ts`;
  `run.ts` builds the yargs tree from that list plus `registerCommand`
  (tests), and calls the handler only after parsing succeeds.
- A handler gets a `RunContext` (cwd, env, signal, fetch, one shared
  `LineReader`) and throws `UsageError` / `ExitSignal` / any error; it
  never writes the error itself or reads process globals.
- A group with `subcommands` and no handler prints its help.
- yargs number parsing is off (`parse-numbers: false`). Declare an
  integer flag as `type:'string'` and parse decimal digits in the
  handler, throwing `UsageError` on a bad value (see `parseLimit` in
  `runs.ts`).
- Terminal detection and browser opening are swapped through
  `terminalHooks` (`terminal.ts`).
- With only the default `$0` command registered, yargs omits the
  Commands section from root help; it appears once a second command
  registers.

## Review command (`src/cli/review.ts`)

- End-to-end review tests use `settingsRepo` (`test/helpers/review.ts`):
  a temp repo with an uncommitted change, a config on a fake `chat`
  server, keys in env, `review.snapshot: false`, and approval via
  `roast trust --yes`. It chdirs into the repo.
- yargs keeps only the last occurrence of an array flag under
  `duplicate-arguments-array: false`; review slice flags are re-read
  from `ctx.argv` (`review-flags.ts`). Flags whose "changed" state
  matters have no yargs default (`undefined` = not given).
- The structured finder call offers `findings` plus the agent's
  `__roast_continue`; assert tool presence, not exact lists.
- Verification (step 17) runs only with `doVerify` and at least one
  finding. `verify` (`src/verify/verify.ts`) never throws; an abort
  becomes undecided verdicts, so the run still writes its record and
  exits 4. Its result types `notes` as `string[]|null` (Go parity), so
  CLI code after step 17 takes `VerifiedResult`, not `Result`.
- Verifier CLI tests (`test/cli/review-verify.ts`) put the verifier on
  its own profile and model and tell its requests apart by the
  `submit_verdict` tool. The default role key variable
  (`ROAST_VERIFIER_API_KEY`) backs any profile, so an invalid-key test
  must delete it from the env.
- The entry exits within the tick of the first SIGINT, and identical
  signals sent back to back coalesce, so a second-signal test needs a
  slow wind-down (a fake `git` that exits slowly on SIGTERM).

## Tests

- Use the `test` wrapper in `test/helpers/test.ts`, which adds Go-style
  `t.cleanup` (tapzero has no teardown hook). tapzero's `Test` has no
  `notOk`; write `t.ok(!x, ...)`.
- CLI tests run in-process with `runRoast` (`test/helpers/run.ts`),
  which makes a temp repo with an isolated env (`test/helpers/repo.ts`:
  `tempRepo`, `tempDir`, which also sets `GIT_CEILING_DIRECTORIES`).
  `test/cli/process.ts` and `test/tooling/bundle.ts` spawn `dist/cli.js`,
  so they need a fresh `npm run build` (`npm test` does that).
- Test environments come from `isolatedEnv`, which starts from
  `cleanEnv(process.env)` (`test/helpers/env.ts`): every `ROAST_*`,
  `OPENAI_*`, `OPENROUTER_*`, and `ANTHROPIC_*` variable is stripped. A
  new provider whose key variable has another prefix goes in its
  `AMBIENT_PREFIXES`. Tests set credentials in `io.env`, never in
  `process.env`.
- A review test needs an approved `.roast.json` on the fake server:
  `settingsRepo` approves, or call `approveProjectConfig`. A test
  asserting a config error approves a valid config and then edits it,
  so a trust failure cannot mask the error. A doctor test that probes a
  custom endpoint approves in its temp repo (`approveDoctorConfig`,
  `test/cli/doctor.ts`), never in this checkout.
- Untracked files are part of a review's diff, so a test that checks
  which file's text reached the fake server keeps decoys out of scope
  (for example through `.git/info/exclude`).
- Fakes: `startInferenceServer` (`test/helpers/inference-server.ts`)
  speaks the three protocols; `providerServer`
  (`test/helpers/provider-server.ts`) adds key-check and OpenRouter
  routes. `runRoast({ redirectTo })` uses `redirectingFetch`, so a
  profile on a built-in endpoint reaches the fake. `requestRecorder` and
  `reviewMeta` (`test/helpers/review.ts`) read what the fake received
  and the run's `meta.json`.
- Swap terminals and the browser with `simulateTerminals` /
  `captureBrowser` (`test/helpers/terminal.ts`).
- Tests that spawn processes use `test/helpers/spawn.ts` (`ROOT`,
  `run`).
- Git runner tests observe a child by putting a fake `git` shell script
  first on the injected `PATH` (spawn resolves the command through
  `env.PATH`); see `test/git/git.ts`.
- Live tests live under `test/live/` (entry `index.ts`,
  `npm run test:live`); each passes with a "skipped" note when its
  `ROAST_LIVE_*` key is unset, so the TAP stream is never empty.
