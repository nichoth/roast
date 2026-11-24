# 01: M0 scaffold -- bundle, test pipeline, `--version`, CI job

**Blocked by:** None (can start immediately)
**Touches:** `package.json` (devDependencies, scripts), `tsconfig.json`,
`tsconfig.build.json`, `tsconfig.launcher.json` (new; the launcher's
current config moves here), `eslint.config.js` (new, copied from
`../template-ts-browser/eslint.config.js`), `.gitignore`,
`scripts/bundle.ts` (default, `--test`, `--live` modes), `src/cli.ts`,
`src/cli/run.ts` (minimal `run(argv, io)`), `src/buildinfo.ts`
(`BuildInfo`, `buildInfo`, `formatBuildInfo`), `src/assets.d.ts`,
`test/index.ts`, `test/tooling/*.ts`, `test/live/index.ts` (empty entry),
`.github/workflows/ci.yml` (new `typescript` job)
**Spec:** `spec/15-packaging.md` 2.1 to 2.5, 2.8, 2.9, 2.14 (items 1 to 4,
6 to 10), 2.16, 3, 5.1, 5.2; `spec/01-cli.md` 2.1 (version check), 2.10;
`spec/00-decisions.md` "Packaging and tooling"; spec.md "Runtime"
**Status:** done

## What to build

The tooling that lets every later ticket land TypeScript code and tapzero
tests, while the Go build, the launcher, and the platform release flow keep
working unchanged (this is the transitional M0 form in 15 / 2.14, not the
final 2.1 manifest).

`npm run bundle` produces `dist/cli.js`, a single esbuild ESM bundle with
the 2.5 options: shebang plus `createRequire` banner, `mainFields:
['module', 'main']`, text loaders for `.tmpl`, `.md`, `.sh`, the three
`__ROAST_*__` defines from `package.json` version, `git rev-parse
--short=7 HEAD`, and `git log -1 --format=%cI` (each `unknown` when git
fails), the metafile written to `dist/meta.json`, and `chmod 0o755`.
`npm run build:test` bundles `test/index.ts` to `test/test-bundle.js`
(no shebang, `require` shim kept, no defines). `npm run test:tap` pipes it
to `tap-spec` under `bash -o pipefail`. `npm run test:ts` runs bundle,
build:test, test:tap. `--live` bundles `test/live/index.ts` to
`test/live-bundle.js`; the entry exists but holds no tests yet (the LLM
tickets add them). The `--diff` mode belongs to ticket 09; the
third-party notices step (2.5 step 4) belongs to ticket 02, so leave a
clear hook for it in `scripts/bundle.ts`.

`package.json`: add the 2.1 devDependencies (keep the baseline ones, move
`jsonc-parser`, `yargs`, `zod` out of `dependencies`, `@types/node` to
`^22.18.0`), add scripts `lint` (transitional, with the `--ignore-pattern`
list in 2.14 item 2), `typecheck`, `bundle`, `build:test`, `test:tap`,
`test:ts`. Leave `bin`, `files`, `workspaces`, `engines`,
`optionalDependencies`, `build`, `test`, `version`, `prepublishOnly`,
`check:pack`, `release` with their baseline meaning. `build:launcher`
becomes `tsc -p tsconfig.launcher.json`.

`src/cli.ts` is the bundle entry. Its first statements check
`process.versions.node` against 22.18 (numeric major/minor) and, below it,
write a one-line error naming both versions and exit 2 before the CLI body
is loaded (dynamic `import()` after the check). It installs a
`process.on('warning')` filter that drops only the `node:zlib` zstd
`ExperimentalWarning`. Export the version check and the warning filter as
functions that take their input as arguments so they are unit testable.
It then calls `run(process.argv.slice(2), io)` and sets the exit code.

`src/cli/run.ts` exports `run(argv, io)` (the `CliIO` / `RunResult` shapes
in `spec/01-cli.md` 3.2). In M0 it only handles root `--version` / `-v`
(prints `roast version <build string>`), `--help`, and treats everything
else as not yet implemented. It must already create yargs with
`.locale('en')` and `.detectLocale(false)`. Ticket 04 grows this into the
full CLI core; keep it minimal.

`src/buildinfo.ts` follows 15 / 2.8 and 3 (`formatBuildInfo`, sentinels
`dev` / `unknown` / `unknown` read through `typeof` guards). Use these
names, not the `buildString()` name in `spec/01-cli.md` 3.6.

CI: add the `typescript` job in `ci.yml` with the 2.12 matrix
(`ubuntu-26.04`, `macos-latest` by Node 22 and 24) and steps checkout,
setup-node, install (the baseline lockfile-then-`npm ci` pair), `npm run
lint`, `npm run typecheck`, `npm run test:ts`. Existing jobs unchanged.
`.gitignore` gains `test/*.js`. `.npmrc` keeps `force=true`.

## Acceptance criteria

- [x] `node dist/cli.js --version` exits 0 and its stdout contains the
      `package.json` version.
- [x] `node dist/cli.js --help` exits 0, and its stdout under
      `LC_ALL=de_DE.UTF-8 LANG=de_DE.UTF-8` equals its stdout under
      `LC_ALL=C`.
- [x] `dist/cli.js` starts with `#!/usr/bin/env node` and has the owner
      execute bit.
- [x] The startup version check returns an error naming `22.18` for a
      version below the floor (for example `22.17.1`, `20.0.0`) and passes
      for `22.18.0` and `24.0.0`; the entry exits 2 when it fails.
- [x] The warning filter drops a zstd `ExperimentalWarning` and passes any
      other warning (another `ExperimentalWarning`, a
      `DeprecationWarning`) through.
- [x] Each text asset imported through the loader (the 12
      `internal/prompts/templates/*.tmpl`,
      `internal/skill/assets/roast/SKILL.md`,
      `internal/gate/pre-commit.sh`) equals the file read from disk.
- [x] `formatBuildInfo` uses the `(commit <c>)` form when the version is
      `dev` or the date is `unknown`, and the `(<c>, <d>)` form otherwise;
      in the test bundle `buildInfo.version` is `dev`.
- [x] `npm run test:tap` exits non-zero when the test bundle fails an
      assertion or crashes, even though `tap-spec` exits 0.
- [x] Importing `src/cli/run.ts` from the test bundle executes nothing (no
      output, no exit).
- [x] `npm run lint`, `npm run typecheck`, `npm run test:ts` pass;
      `npm run build:launcher`, `go build ./...`, and `go test ./...`
      still pass.
