# Packaging, build, and release

`package.json`, `scripts/`, `tsconfig*.json`. Spec:
`.scratch/ts-rewrite/spec/15-packaging.md`.

## The package

- One pure-JS package. `bin.roast` is `dist/cli.js`, a single esbuild
  ESM bundle. `files` lists exact paths, so build by-products such as
  `dist/meta.json` never ship.
- `dependencies` stays empty and there is no `optionalDependencies`,
  `main`, or `exports`: anything in `dependencies` installs into every
  user's project. Runtime libraries (`yargs`, `zod`, `jsonc-parser`) are
  `devDependencies` that the bundle inlines.
- `roast.schema.json` stays at the package root: `init` writes a
  `$schema` of `node_modules/@substrate-system/roast/roast.schema.json`.
- `os` is `darwin`/`linux` and `engines.node` is `>=22.18`;
  `@types/node` tracks that major so code cannot use a newer API.
- `overrides.typescript` (`$typescript`) lets npm install typescript-eslint,
  whose `typescript` peer range stops below 7, without `--force`; lint
  still runs eslint against the TypeScript 6 API
  (`scripts/eslint-ts6.ts`). Drop both once typescript-eslint accepts
  TypeScript 7. Test installs without `force`: an `npm_config_force`
  in the shell hides a broken resolution.
- There is no committed lockfile (`package-lock=false` is the whole npm
  config). CI writes one with `npm install --package-lock-only
  --package-lock=true` before `npm ci`, which refuses to run without it.

## Build

- `npm run build` runs `npm run schema`, then `scripts/bundle.ts`: it
  recreates `dist/`, bundles `src/cli.ts`, writes `dist/meta.json` and
  `dist/THIRD_PARTY_LICENSES.txt`, and makes `dist/cli.js` executable.
  Version, commit, and date are injected through esbuild `define`s; the
  test bundle has none, so it reports `dev`.
- Text assets (prompt templates under `src/prompts/templates/`,
  `src/skill/assets/roast/SKILL.md`, `src/gate/pre-commit.sh`) are
  imported as strings through the text loader. `test/tooling/assets.ts`
  checks each one equals its file.
- `npm run schema` regenerates `roast.schema.json` from the zod schema;
  CI fails on an uncommitted change to it.
- Build before `npx roast` in this repo: it resolves the root package's
  own bin, and with no executable `dist/cli.js` a `roast` on `PATH` (for
  example Homebrew) can answer instead.

## Checks and release

- `npm run check:pack` (`scripts/check-pack.ts`, after a build) dry-run
  packs the package and fails unless the tarball lists every required
  file, the manifest has a `license` and no dependencies, and
  `dist/cli.js` has the shebang and owner execute bit. It runs on
  `process.cwd()`, so `test/tooling/check-pack.ts` runs it in fixtures.
  npm 12 prints `npm pack --json` as an object keyed by package name,
  older npm as an array.
- Release is local, through the npm lifecycle: `npm version <x>` runs
  lint (`preversion`), updates the README toc and `CHANGELOG.md`
  (`auto-changelog`), commits and tags, then `postversion` pushes and
  publishes; `prepublishOnly` builds and runs `check:pack`. A failing
  `prepublishOnly` after the tag is pushed is fixed by a follow-up patch
  release, never by re-tagging.
- Update the suggested model IDs in `SUGGESTED_MODELS` (`defaults.ts`)
  and the README `init` example together when model names change.
