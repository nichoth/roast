# Area 15: packaging, build, tooling, release, cutover

## 1. Purpose

This area defines how Roast is built, tested, linted, checked, released, and
shipped as one pure-JS npm package, `@substrate-system/roast`. It replaces
the Go toolchain, the six platform packages, the npm launcher, and the
platform release scripts. It also defines two milestones: the M0 scaffold
(tooling that lets the other areas land code and tests) and the M6 cutover
(deleting the Go implementation and releasing `2.0.0`).

Vocabulary: "the bundle" is `dist/cli.js`, the single esbuild ESM output
that `bin.roast` points at. "Third-party notices" is
`dist/THIRD_PARTY_LICENSES.txt`. "The test bundle" is
`test/test-bundle.js`, the esbuild output of `test/index.ts`. "The
baseline" is Go commit `cd08f10`.

Users install Roast as a project dependency
(`npm i -D @substrate-system/roast`) and run it as `npx roast ...`; it is
never a `PATH` binary. Installing it adds no transitive packages.

## 2. Behavior contract

This section is the build and release contract, not CLI behavior.

### 2.1 Package manifest (final form, after M6)

`package.json` at the repo root, exactly these keys (key order is not
significant; values are):

```json
{
  "name": "@substrate-system/roast",
  "version": "2.0.0",
  "description": "Adversarial review",
  "license": "(MIT OR Apache-2.0)",
  "type": "module",
  "bin": {
    "roast": "dist/cli.js"
  },
  "files": [
    "dist/cli.js",
    "dist/THIRD_PARTY_LICENSES.txt",
    "roast.schema.json",
    "LICENSE.txt",
    "LICENSE-MIT.txt",
    "LICENSE-APACHE.txt"
  ],
  "engines": {
    "node": ">=22.18"
  },
  "os": ["darwin", "linux"],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "lint": "eslint src test scripts eslint.config.js",
    "typecheck": "tsc -p tsconfig.json",
    "schema": "node scripts/schema.ts",
    "build": "npm run schema && node scripts/bundle.ts",
    "build:test": "node scripts/bundle.ts --test",
    "test": "npm run build && npm run test:run",
    "test:run": "npm run build:test && npm run test:tap",
    "test:tap": "bash -o pipefail -c 'node test/test-bundle.js | tap-spec'",
    "test:live": "node scripts/bundle.ts --live && node test/live-bundle.js",
    "check:pack": "node scripts/check-pack.ts",
    "toc": "markdown-toc --maxdepth 3 -i README.md",
    "preversion": "npm run lint",
    "version": "npm run toc && auto-changelog && npm run stage:docs",
    "stage:docs": "git add CHANGELOG.md README.md",
    "postversion": "git push --follow-tags && npm publish",
    "prepublishOnly": "npm run build && npm run check:pack"
  },
  "auto-changelog": {
    "package": true,
    "template": "keepachangelog",
    "breakingPattern": "BREAKING CHANGE:"
  },
  "devDependencies": {
    "@substrate-system/debug": "^0.9.64",
    "@substrate-system/redeye": "^0.1.7",
    "@substrate-system/tapzero": "^0.10.15",
    "@types/node": "^22.18.0",
    "@types/yargs": "^17.0.33",
    "auto-changelog": "^2.4.0",
    "esbuild": "^0.27.0",
    "eslint": "^10.6.0",
    "jsonc-parser": "^3.3.1",
    "markdown-toc": "^1.2.0",
    "newneostandard": "^0.14.1",
    "tap-spec": "^5.0.0",
    "typescript": "^7.0.2",
    "typescript-eslint": "^8.62.0",
    "yargs": "^18.2.0",
    "zod": "^4.6.7"
  },
  "keywords": ["AI"],
  "homepage": "https://github.com/nichoth/roast#readme",
  "bugs": { "url": "https://github.com/nichoth/roast/issues" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/nichoth/roast.git"
  },
  "author": "nichoth"
}
```

Rules the manifest must keep:

1. No `dependencies`, `optionalDependencies`, `peerDependencies`, or
   `workspaces`. The runtime libraries (`yargs`, `zod`, `jsonc-parser`,
   `@substrate-system/debug`) are `devDependencies` and bundled into
   `dist/cli.js`. Anything in `dependencies` would install into every
   user's project. (The working tree at the time of writing moved
   `jsonc-parser`, `yargs`, `zod` into `dependencies`; that is wrong for
   the TS package and must be reverted to `devDependencies`.)
2. No `main` or `exports`. Roast is CLI only; importing the package fails.
3. `files` lists exact paths, so `dist/meta.json` (the esbuild metafile)
   and any other build by-product never ship.
4. `roast.schema.json` stays at the package root. `roast init` writes a
   `$schema` of `node_modules/@substrate-system/roast/roast.schema.json`
   (see the init area), so the package name and this path are a contract.
5. `os` makes npm refuse the install on Windows (EBADPLATFORM).
6. `engines.node` `>=22.18` is the floor because Node 22.18 runs `.ts`
   files with type stripping unflagged (the `scripts/*.ts` tooling relies
   on it) and `node:zlib` has zstd from 22.15.
7. `devEngines` (present at the baseline) is removed: `engines` now states
   the same floor.
8. `@types/node` tracks the engine floor's major (22), so code cannot
   typecheck against an API newer than the minimum supported Node.
9. `version` is `2.0.0` only after the M6 release; during M0 to M5 it stays
   whatever the baseline has (`0.0.0`).

The `auto-changelog` options live in the `"auto-changelog"` key
(auto-changelog reads it from `package.json`) and the `git add` is split
into `stage:docs`, so every script fits in 80 columns.

`CHANGELOG.md` keeps its existing history (the upstream 1.4.x entries
stay as committed). From `2.0.0` on, `auto-changelog` regenerates the
new entries from git tags at each `npm version`.

`@types/yargs` is a `devDependency` because yargs 18 does not ship its
own types.

### 2.2 npm config and ignores

`.npmrc` (final form) is the template's single line:

```
package-lock=false
```

The baseline's `force=true` existed only so npm would link the
`os`/`cpu`-restricted workspaces; it is removed at M6 together with
`packages/`. There is still no committed lockfile.

`.gitignore` gains `test/*.js` (the test bundles). At M6 it drops the
Go-era entries `/bin/`, `/THIRD_PARTY_LICENSES/`, `*.test`, `/roast`,
`/roast.exe`. `dist/` stays ignored.

No `.npmignore`: the `files` allowlist governs the tarball.

### 2.3 TypeScript config

`tsconfig.json` (typecheck only; esbuild does all emitting):

```json
{
  "compilerOptions": {
    "module": "ES2022",
    "target": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "test", "scripts"]
}
```

`tsconfig.build.json` (passed to esbuild as `tsconfig` for the bundle):

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["test", "scripts"]
}
```

Differences from `../template-ts-browser/tsconfig.json` and why:

- `lib` has no `DOM` or `WebWorker`; `types` is `["node"]`, not
  `vite/client`. `fetch`, `AbortSignal`, `TextDecoder`, and
  `ReadableStream` come from `@types/node`.
- `noImplicitAny: false` is dropped, so `strict` is fully on.
- `experimentalDecorators`, `emitDecoratorMetadata`, `declaration*`,
  `sourceMap`, `outDir`, `listFiles` are dropped: no decorators, no
  library output, no tsc emit.
- `allowImportingTsExtensions` plus `noEmit`: `scripts/*.ts` run directly
  under Node type stripping, which requires `.ts` in relative imports.
  Code under `src/` and `test/` imports siblings with the `.js` extension
  (template style); `Bundler` resolution maps it to the `.ts` file.
- `include` drops `example` and `lib.es5.d.ts`, adds `scripts`.

Node-run scripts (`scripts/*.ts`) may use only erasable TypeScript syntax:
no `enum`, `namespace`, parameter properties, or decorators. Type-only
imports must use `import type`.

Ambient declarations in `src/assets.d.ts`:

```ts
declare module '*.tmpl' {
    const text:string
    export default text
}
declare module '*.md' {
    const text:string
    export default text
}
declare module '*.sh' {
    const text:string
    export default text
}
declare const __ROAST_VERSION__:string|undefined
declare const __ROAST_COMMIT__:string|undefined
declare const __ROAST_DATE__:string|undefined
```

### 2.4 Lint

`eslint.config.js` is copied from `../template-ts-browser/eslint.config.js`
byte for byte: the `newneostandard({ ts: true })` base, the Standard Style
overrides, the `@typescript-eslint/recommended` block, and the local
`union-spacing` rule. Its rules are not changed. Its `ignores` array is
kept as is (`lib.es5.d.ts`, `dist/**`, `public/**`, `test/*.js`); the
entries that do not match anything in Roast are harmless.

The `lint` script names directories (`src test scripts eslint.config.js`)
instead of the template's `./**/*.{ts,js}`, because flat-config eslint
does not skip dot-directories such as `.scratch/` and `.claude/`.

Consequences the code must respect (from those rules): 4-space indent, no
semicolons, single quotes, `name:Type` with no spaces around the colon,
object literal members as `{ a:1 }` (`key-spacing` with `afterColon:
false`), `A|B` unions with no spaces, `import type` for type-only imports,
unused variables only with a `_` prefix.

During M0 to M5 the legacy files do not follow these rules (they use
`{ cwd: ROOT }` spacing). The transitional `lint` script adds
`--ignore-pattern` flags for them instead of editing the config; see 2.14.

### 2.5 The bundle (`scripts/bundle.ts`)

`npm run build` runs `npm run schema` (2.7), then `node scripts/bundle.ts`,
which:

1. Removes and recreates `dist/`.
2. Calls `esbuild.build` with the options below.
3. Writes the metafile to `dist/meta.json`.
4. Writes `dist/THIRD_PARTY_LICENSES.txt` from the metafile (2.6).
5. `chmod 0o755 dist/cli.js`. npm sets the bin mode on install, but links
   it does not refresh (an existing npx cache entry, `npx roast` inside
   this repo) need the file executable already.
6. Exits non-zero on any esbuild error or notice-generation error. Esbuild
   warnings are printed and do not fail the build.

Esbuild options for the bundle:

```ts
const options:BuildOptions = {
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: 'tsconfig.build.json',
    mainFields: ['module', 'main'],
    keepNames: true,
    minify: false,
    sourcemap: false,
    metafile: true,
    loader: { '.tmpl': 'text', '.md': 'text', '.sh': 'text' },
    banner: { js: BANNER },
    define: {
        __ROAST_VERSION__: JSON.stringify(version),
        __ROAST_COMMIT__: JSON.stringify(commit),
        __ROAST_DATE__: JSON.stringify(date),
    },
    logLevel: 'warning',
}
```

Where:

- `BANNER` is three lines: `#!/usr/bin/env node`, then
  `import { createRequire as __roastRequire } from 'node:module'`, then
  `const require = __roastRequire(import.meta.url)`. The shebang must be
  the first line of the file. The `require` shim exists because esbuild's
  ESM output turns a bundled CommonJS module's `require('node:fs')` into a
  runtime "Dynamic require is not supported" error unless a `require` is
  in scope.
- `mainFields: ['module', 'main']` overrides esbuild's Node default
  (`main` first). `jsonc-parser`'s `main` is a UMD build whose internal
  `require` calls esbuild cannot follow; its `module` field is the ESM
  build.
- `version` is the root `package.json` `version`. `commit` is
  `git rev-parse --short=7 HEAD` and `date` is `git log -1 --format=%cI`
  (committer date, RFC 3339), both run at the repo root. If either `git`
  call fails (a build from a tarball), the value is `unknown`. These are
  the same three values the Go build stamped through `-ldflags -X`.
- `minify: false` and `keepNames: true` keep user-reported stack traces
  readable. `legalComments` keeps esbuild's bundle default (`eof`).

The yargs locale caveat. yargs loads translations with `y18n` from a
`locales/` directory next to its own module file. In the bundle that
directory does not exist. y18n treats a missing locale file as an empty
table and returns the English source strings, so help and error text stay
English. The CLI must still call `.locale('en')` and `.detectLocale(false)`
so yargs never tries to read `LANG`/`LC_ALL` and no locale file is ever
probed. A bundle smoke test (5.1) proves output is identical under a
non-English locale. If a future yargs version throws on the missing
directory, the fix is in the bundle step (copy nothing; pass an explicit
`y18n` instance or stub), never shipping `locales/`.

Text assets. Prompt templates, the agent skill `SKILL.md`, and the
pre-commit hook script are imported as strings through the text loader
(`import finderCore from './templates/finder_core.tmpl'`). The string must
equal the file's bytes decoded as UTF-8; none of these files has a BOM.
Location of the files:

- prompt templates (the 12 `*.tmpl` files): `internal/prompts/templates/`
  during M1 to M5, `src/prompts/templates/` after M6;
- agent skill: `internal/skill/assets/roast/SKILL.md`, then
  `src/skill/assets/roast/SKILL.md`;
- hook script: `internal/gate/pre-commit.sh`, then
  `src/gate/pre-commit.sh`.

Until M6 the TS modules import the assets from their Go locations, so the
Go `//go:embed` directives and the TS bundle read the same file and cannot
drift. M6 moves them with `git mv` and updates the import paths. Go embeds
`all:assets/roast` as a directory; the TS skill module imports each file
explicitly, so a new file under `assets/roast/` needs a new import.

`npx roast` inside this repository resolves the root package's own `bin`.
Build first: with no `dist/cli.js`, a `roast` elsewhere on `PATH` (for
example Homebrew) can answer instead.

### 2.6 Third-party notices (`scripts/licenses.ts`)

Generated by the bundle step from the in-memory metafile. Algorithm:

1. Take `metafile.outputs['dist/cli.js'].inputs`. Keep only input paths
   with `bytesInOutput > 0` (code actually in the bundle) that contain a
   `node_modules/` segment.
2. For each path, the package root is the prefix up to and including the
   package name after the last `node_modules/`: one segment, or two when
   the first starts with `@` (scoped). Nested `node_modules` resolve to
   the innermost package.
3. Read `<root>/package.json`: `name`, `version`, `license` (a string; the
   legacy object or array `licenses` form is an error), and `repository`
   (string or `{ url }`, optional).
4. License files are the files directly in `<root>` whose name matches
   `/^(licen[cs]e|copying|notice)(\..*)?$/i`, sorted by name.
5. Deduplicate by `name@version`.
6. Validate. The build fails, naming the package, when:
   - the `license` field is missing;
   - any SPDX identifier in it (split on `(`, `)`, ` OR `, ` AND `,
     ` WITH `) is not in the allowlist `Apache-2.0`, `BSD-2-Clause`,
     `BSD-3-Clause`, `ISC`, `MIT`, `MPL-2.0`, `Unlicense` (the same list
     the Go CI passed to `go-licenses`);
   - no license file exists.
7. Render, sorted by `name` then `version`:

```
Third-party software bundled in dist/cli.js

Roast's npm package bundles the following packages. Each entry gives the
package, its declared license, and the license text it ships.

==============================================================================
<name>@<version>
License: <license field>
Repository: <url>        (line omitted when the package has none)

<contents of each license file, trimmed, separated by one blank line>

==============================================================================
<next package> ...
```

The file ends with one newline. Output is deterministic for the same
`node_modules`.

### 2.7 Schema generation hook (`scripts/schema.ts`)

The config area owns the zod schema and a pure function
`renderProjectSchema():string` in `src/config/json-schema.ts` that returns
the full `roast.schema.json` text (`JSON.stringify(value, null, 2)` plus a
trailing newline). This area owns the hook:

1. `scripts/schema.ts` bundles `src/config/json-schema.ts` with the same
   base options as 2.5 (minus banner, defines, and metafile) into
   `node_modules/.cache/roast/schema.mjs`, dynamically imports it, and
   calls `renderProjectSchema()`.
2. It writes `roast.schema.json` at the repo root only when the content
   differs, and prints whether it changed.
3. `npm run build` runs it first, so a developer who edits the zod schema
   gets the committed file regenerated and sees it in `git status`.
4. CI runs `git diff --exit-code -- roast.schema.json` after the build, so
   a pull request that changed the schema without committing the
   regenerated file fails.
5. The config area's drift test (generated text equals the committed file)
   runs in the test bundle and catches drift when `test:run` is used
   without a build.

The hook lands in M1, when the config area's zod schema exists. In M0
`build` does not call it. During M1 to M5 the generated file must still
satisfy the Go `TestSchemaMatchesConfigStruct`, which compares structure
and JSON types only, not formatting.

### 2.8 Build info (`src/buildinfo.ts`)

Replaces Go `internal/buildinfo`. Values come from the esbuild `define`s
(2.5). When a define is absent (the test bundle, the schema bundle), the
value is the sentinel: version `dev`, commit `unknown`, date `unknown`.
The Go fallback to toolchain-embedded VCS data has no TS equivalent and is
dropped.

Format of the one-line string (Go `buildinfo.String`):

- version is `dev` or date is `unknown`: `<version> (commit <commit>)`,
  for example `dev (commit unknown)`;
- otherwise `<version> (<commit>, <date>)`, for example
  `2.0.0 (abc1234, 2026-12-01T10:00:00Z)`.

The bundle's version, commit, and date are injected by esbuild `define`
(2.5); running from source (no define) reports `dev`.

Consumers (owned by other areas): `--version` output, the `User-Agent`
`roast/<version>`, `roast doctor`'s `build` check (warn when version is
`dev`), and the run record's `roast.version` / `roast.commit`.

### 2.9 Test runner pipeline

1. `test/index.ts` imports every test module (`test/<area>/*.ts`); it is
   the only test entry. Tests use `@substrate-system/tapzero` (`test`,
   `t.ok`, `t.equal`, `t.deepEqual`, async tests).
2. `npm run build:test` runs `scripts/bundle.ts --test`: the 2.5 options
   with `entryPoints: ['test/index.ts']`, `outfile: 'test/test-bundle.js'`,
   `tsconfig: 'tsconfig.json'`, no shebang line in the banner (the
   `require` shim stays), no defines, no metafile.
3. `npm run test:tap` runs `node test/test-bundle.js` piped to `tap-spec`
   under `bash -o pipefail`, so the script fails when the bundle exits
   non-zero (a failed assertion, an uncaught error, a crash before the
   plan) even if the formatter exits 0. Bash is available on both
   supported platforms.
4. `npm test` builds the real bundle first, because the bundle smoke tests
   (5.1) spawn `dist/cli.js`.
5. Tests find the repo root from the bundle location:
   `new URL('..', import.meta.url)` (the bundle lives in `test/`).
6. Opt-in live provider tests (`ROAST_LIVE_*`) live under `test/live/`
   with their own entry `test/live/index.ts`, bundled to
   `test/live-bundle.js` by `scripts/bundle.ts --live` and run by
   `npm run test:live`. `test/index.ts` never imports them, so `npm test`
   cannot reach the network even with the variables set. CI never runs
   `test:live`.
7. Test hygiene that the tooling assumes: tests create temporary Git
   repositories with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set in the child
   environment (CI runners have no Git identity), isolate `HOME` and
   `XDG_CONFIG_HOME`, and compare directories after `realpath` (macOS
   temp dirs are `/var/...` while Git prints `/private/var/...`).

The Go-specific notes go away: there is no race detector, so CI sets no
`GOFLAGS`; the rule that a `go` subprocess under `-race` must not set
`CGO_ENABLED=0` has no TS successor; `go mod tidy`, `gofmt`, `go vet`, and
staticcheck U1000 are replaced by `tsc` (unused locals surface through the
`@typescript-eslint/no-unused-vars` lint rule). The only Go build left
after M0 is the differential harness's baseline binary (2.13), which it
builds with `GOFLAGS` removed from the environment.

### 2.10 Package check (`scripts/check-pack.ts`, slimmed)

Run as `npm run check:pack` after `npm run build`, in CI and in
`prepublishOnly`. Operates on `process.cwd()` so tests can run it in a
fixture. Steps:

1. `npm pack --dry-run --json` in the package root (no `--workspaces`).
   Non-zero exit: print npm's stderr, fail.
2. Parse stdout: npm 12 prints an object keyed by package name, older npm
   an array; accept both and take the single result's `files[].path`.
3. Fail unless the tarball lists each of `dist/cli.js`,
   `dist/THIRD_PARTY_LICENSES.txt`, `roast.schema.json`, `LICENSE.txt`,
   `LICENSE-MIT.txt`, `LICENSE-APACHE.txt`.
4. Fail when `package.json` declares no `license`, or declares a non-empty
   `dependencies` or any `optionalDependencies`.
5. Fail when `dist/cli.js` on disk does not start with
   `#!/usr/bin/env node\n` or is not executable by its owner.
6. On failure print every problem (one per line, prefixed by
   `packaging check failed:`), then the hint to run `npm run build` and
   check `files`, and exit 1. On success print one summary line, exit 0.

### 2.11 Release lifecycle

Publishing is local only (no CI publish job), as at the baseline. The
template's npm lifecycle replaces `scripts/release.ts`, `version.ts`,
`check-release.ts`, `platforms.ts`, and `licenses.sh`:

```
npm version <major|minor|patch|x.y.z>
  preversion      npm run lint
  (npm writes the version into package.json)
  version         README toc, CHANGELOG.md via auto-changelog, git add
  (npm commits and tags v<x.y.z>)
  postversion     git push --follow-tags && npm publish
    prepublishOnly  npm run build && npm run check:pack
```

The first TS release is `npm version 2.0.0` (explicit, because the
committed version is `0.0.0`). `publishConfig.access: public` replaces the
`--access public` flag that `scripts/release.ts` passed. A failing
`prepublishOnly` stops `npm publish` after the tag was pushed; the fix is
a follow-up patch release, not re-tagging.

The baseline invariants that existed only for platform packages (every
platform version equals the root version, root `optionalDependencies` pin
each platform package, each platform `dist/` holds a binary and notices,
platform packages publish before the root) disappear with the packages.

### 2.12 CI workflows

`claude-mention.yml`, `claude-review.yml`, and `pr-title.yml` are
unchanged. `ci.yml` (final form, after M6):

- Triggers, top-level `permissions: {}`, and `concurrency` stay as at the
  baseline. Action references stay pinned by SHA as at the baseline
  (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0).
- Job `test`, `strategy.fail-fast: false`, matrix `os: [ubuntu-26.04,
  macos-latest]` (`macos-latest` is deliberately unpinned) by
  `node: [22, 24]`, `permissions: contents: read`,
  `timeout-minutes: 30`. Steps:
  1. Checkout (`persist-credentials: false`).
  2. Set up Node `${{ matrix.node }}`.
  3. Install: `npm install --package-lock-only --package-lock=true
     --no-audit --no-fund`, then `npm ci --no-audit --no-fund` (unchanged
     from the baseline; `npm ci` needs a lockfile and none is committed).
  4. `npm run lint`.
  5. `npm run typecheck`.
  6. `npm test` (builds, then runs the test bundle).
  7. `git diff --exit-code -- roast.schema.json`.
  8. `npm run check:pack`.
- Job `security` (ubuntu only): keeps the Git-history secret scan
  (gitleaks through `.github/tools/gitleaks/go.mod`) and workflow lint
  (actionlint through `.github/tools/actionlint/go.mod`). It adds two
  steps: `npm audit --audit-level=high`, run after the install step
  (without `--omit=dev`, so the bundled runtime libraries, which are
  `devDependencies`, are covered), and `shellcheck
  src/gate/pre-commit.sh` (the hook script is the only shell file left).
  `setup-go` stays
  only for these tool modules, with `go-version-file` pointing at the
  tool's own `go.mod` and `cache-dependency-path: .github/tools/*/go.sum`.
  The tool modules' `go mod tidy` check stays, limited to `.github/tools`.

Baseline steps removed at M6: Set up Go in the test job, `go mod
download`, gofmt check, root `go mod tidy` check, `shellcheck
scripts/*.sh` (replaced by the hook-script step above), `GOFLAGS: -race`
on Test, `go vet`,
staticcheck, "Build all platform packages", govulncheck, `go-licenses
check` (replaced by the allowlist in 2.6), and `bash scripts/licenses.sh`.
Tool modules deleted with them: `.github/tools/staticcheck`,
`.github/tools/govulncheck`, `.github/tools/licenses`.

During M0 to M5, `ci.yml` keeps every baseline job and adds the job
`typescript` (2.14) and the differential harness job (2.13).

### 2.13 Go-vs-TS differential harness (temporary)

Purpose: prove parity on observable output by running the baseline Go CLI
and the TS CLI on identical inputs against the same fake inference server.
It lives in `test/diff/` with entry `test/diff/index.ts`, bundled to
`test/diff-bundle.js` by `scripts/bundle.ts --diff`, run by
`npm run test:diff`. It is not imported by `test/index.ts` and is deleted
at M6.

CI runs it from M1 to M5 on Ubuntu only (a job in `ci.yml` with Go set
up, then `npm run build` and `npm run test:diff`), with an allowlist of
the deliberate changes listed in spec.md, "Deliberate changes from the Go
baseline". Differences outside the allowlist fail the job.

Building the Go baseline:

1. Binary cache path: `node_modules/.cache/roast-diff/roast-go-cd08f10`.
   Reuse it if present.
2. Otherwise: `git worktree add --detach <tmp>/roast-go cd08f10`, then in
   it `go build -trimpath -ldflags "-X
   github.com/bluesky-social/roast/internal/buildinfo.Version=baseline" -o
   <cache path> ./cmd/roast` with `CGO_ENABLED=0` and `GOFLAGS` removed
   from the environment, then `git worktree remove --force <tmp>/roast-go`
   (also on failure).
3. If `go` is not on `PATH`, the harness prints a TAP skip for every
   scenario and exits 0 (CI installs Go, so it never skips there).

The TS side is `dist/cli.js` (the harness requires `npm run build` first),
spawned as `node dist/cli.js`, not the in-process `run`, so both CLIs are
exercised as processes.

Per scenario:

1. Start one `node:http` fake server (the same fake the CLI tests use,
   speaking the `chat`, `responses`, and `anthropic` protocols). Responses
   are scripted per scenario and selected by request content (model name
   plus number of conversation turns), never by arrival order, because
   finder and verifier calls may interleave differently.
2. Build two identical fixture repositories, one per CLI, from the same
   function: fixed file contents, fixed `GIT_AUTHOR_DATE` /
   `GIT_COMMITTER_DATE` and identity, so commit IDs match.
3. Write the same `.roast.json` (profiles on the fake's URL, credentials
   via `api_key_env`) into both. Each CLI approves its own copy with
   `trust --yes` first: trust hashes differ by design (v1 vs v2).
4. Run each CLI with a scrubbed environment: no `ROAST_*`, `OPENAI_*`,
   `OPENROUTER_*`, `ANTHROPIC_*`, `DEBUG`; private `HOME` and
   `XDG_CONFIG_HOME`; the profile's key variable set.
5. Compare, after normalization:
   - exit code (exact);
   - stdout when the scenario requests JSON output (parsed, deep equal);
   - requests the fake received, grouped by (model, turn count): method,
     path, parsed JSON body deep equal, and header names (values compared
     only for `Content-Type` and the auth scheme). This covers the
     rendered `finder_user` / `verifier_user` prompts, which reach the
     fake verbatim;
   - run records: the set of relative file paths in the run directory;
     every JSON and JSONL file parsed and deep equal; raw response
     captures byte equal; run bundles compared as decompressed tar entries
     (name, mode, size, content), not compressed bytes, because the zstd
     encoders differ.
   Normalization replaces run IDs, timestamps, durations, the fixture
   repository path, `roast.version` / `roast.commit`, the `User-Agent`
   value, and session header values with placeholders.
6. Not compared: stderr, rendered Markdown, help text, and anything
   touched by a deliberate change (trust messages and `trust.json`, the
   `completion` command, debug output).

Scenarios are added per milestone (M1: config errors and `gate settings`;
M3: clean review, review with findings, `--json`, `--staged`,
`--max-severity`, a failing provider; M4: the same review scenarios on
`responses` and `anthropic`; M5: `runs` listing and snapshot commands,
`init` with a fake provider). A scenario that fails because Go behavior
was judged wrong is recorded in the owning area's Open questions, not
patched in the harness.

### 2.14 M0 scaffold

M0 lets the other areas land TS code and tests while the Go build, the
launcher, and the platform release flow keep working unchanged. Contents:

1. `package.json`: add the `devDependencies` from 2.1 (keeping the
   baseline ones, and moving `jsonc-parser`, `yargs`, `zod` out of
   `dependencies`); add scripts `lint`, `typecheck`, `bundle`
   (`node scripts/bundle.ts`), `build:test`, `test:tap`, `test:ts`
   (`npm run bundle && npm run build:test && npm run test:tap`),
   `test:diff` (`npm run bundle && node scripts/bundle.ts --diff &&
   node test/diff-bundle.js`). `build`, `build:launcher`, `test`, `version`,
   `prepublishOnly`, `check:pack`, `release` keep their baseline meaning.
   `bin`, `files`, `workspaces`, `engines`, `optionalDependencies` are
   untouched.
2. The transitional `lint` script:
   `eslint src test scripts eslint.config.js` plus one `--ignore-pattern`
   per legacy file: `src/launcher.ts`, `test/*.test.ts`,
   `test/release-fixture.ts`, `scripts/build.ts`, `scripts/check-pack.ts`,
   `scripts/check-release.ts`, `scripts/platforms.ts`,
   `scripts/release.ts`, `scripts/version.ts`.
3. TypeScript: `tsconfig.json` becomes 2.3's file plus `exclude` of the
   same legacy files; `tsconfig.build.json` as in 2.3. The launcher's
   current config moves to `tsconfig.launcher.json` and `build:launcher`
   becomes `tsc -p tsconfig.launcher.json`.
4. `eslint.config.js` copied from the template (2.4).
5. New tooling: `scripts/bundle.ts` (with `--test`, `--live`, `--diff`),
   `scripts/licenses.ts`. `scripts/schema.ts` lands in M1. The slimmed
   package check is written as `scripts/check-package.ts` (it would fail
   against the transitional manifest, so CI does not run it yet; its
   fixture tests do run); M6 renames it to `scripts/check-pack.ts` over
   the old one.
6. Source: `src/cli.ts` (the bundle entry; it only hands
   `process.argv.slice(2)` and the real process IO to the CLI area's
   `run` and sets `process.exitCode` from its result; in M0 `run` handles
   `--version` only), `src/buildinfo.ts`, `src/assets.d.ts`.
7. Tests: `test/index.ts` importing `test/tooling/*.ts` (5.1 to 5.4).
8. `.gitignore`: add `test/*.js`.
9. CI: new job `typescript` in `ci.yml` with the 2.12 matrix and steps
   checkout, setup-node, install, `npm run lint`, `npm run typecheck`,
   `npm run test:ts`. The baseline `quality` and `security` jobs are
   unchanged until M6.
10. `.npmrc` keeps `force=true` until M6 (the workspaces still exist).
11. License check: `@substrate-system/debug` and every dependency it
    pulls into the bundle must pass the 2.6 allowlist. M0 runs the
    bundle with the license step against them and resolves any failure
    (replace the library or extend the allowlist with maintainer
    approval) before other areas depend on it.

### 2.15 M6 cutover checklist

Preconditions: every area's test plan is ported and green; the
differential harness passes every scenario (or each difference is an
accepted Open question); `npm run build && npm run check:pack` passes
against the final manifest in a scratch commit.

1. Move assets with `git mv` (list in 2.5) and update their imports.
2. Delete Go: `cmd/`, `internal/`, `go.mod`, `go.sum`.
3. Delete npm-packaging code: `packages/`, `src/launcher.ts`,
   `tsconfig.launcher.json`, `scripts/build.ts`, the old
   `scripts/check-pack.ts`, `scripts/check-release.ts`,
   `scripts/platforms.ts`, `scripts/release.ts`, `scripts/version.ts`,
   `scripts/licenses.sh`, `scripts/licenses_test.go`, and their tests
   `test/launcher.test.ts`, `test/manifest.test.ts`,
   `test/check-pack.test.ts`, `test/prepublish.test.ts`,
   `test/release.test.ts`, `test/version.test.ts`,
   `test/release-fixture.ts`.
4. Rename `scripts/check-package.ts` to `scripts/check-pack.ts`.
5. Delete the differential harness: `test/diff/`, the `--diff` mode of
   `scripts/bundle.ts`, the `test:diff` script, and the
   `node_modules/.cache/roast-diff` convention, and its CI job.
6. `package.json` to its 2.1 form (drops `workspaces`,
   `optionalDependencies`, `devEngines`, `build:launcher`, `release`,
   `test:ts`, `bundle`; `lint` loses its `--ignore-pattern` flags).
   `tsconfig.json` loses its legacy `exclude`. `.npmrc` to 2.2.
7. `.gitignore` per 2.2. Delete the generated root `THIRD_PARTY_LICENSES/`
   directory if present.
8. `ci.yml` to its 2.12 form; delete `.github/tools/staticcheck`,
   `.github/tools/govulncheck`, `.github/tools/licenses`.
   `renovate.json` keeps its `gomod` rules, which still match the
   remaining `.github/tools/*` modules.
9. `AGENTS.md`:
   - replace "Go conventions" with "TypeScript conventions": `npm run
     lint`, `npm run typecheck`, `npm test`; erasable syntax only in
     `scripts/`; `.js` relative imports in `src/` and `test/`; no
     `dependencies`; the test-env clearing helper and its provider list
     (successor of `ClearAmbientEnvironment` / `clearProviderEnv`);
   - rewrite "npm packaging" to describe 2.1 to 2.11 in short: bundle,
     notices, schema hook, test bundle, check:pack, release lifecycle,
     "build before `npx roast`";
   - in every other section, replace `internal/...` paths, `.go` files,
     and Go test helper names with the TS module paths and helper names
     each area file defines; drop the `GOFLAGS=-race`, `go mod tidy`,
     staticcheck, and `go list -deps` notes.
10. `README.md`: Quick start says Node 22.18 or later, macOS and Linux
    only, pure JavaScript (no prebuilt binaries, no Go toolchain);
    install text no longer mentions platform packages; a Network note
    documents `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS`.
    `--version` still
    prints version, commit, and build date.
11. `CONTRIBUTING.md`: prerequisites (Node 22.18+, Git; Go only to run
    the CI tool modules locally), commands (`npm run lint`,
    `npm run typecheck`, `npm test`, `npm run build`), live tests via
    `npm run test:live` with the same `ROAST_LIVE_*` table, the release
    flow of 2.11, and third-party notices from 2.6. Remove the gofmt,
    `go mod tidy`, staticcheck, govulncheck, and `licenses.sh` text.
12. Update `.github/claude-review-prompt.md`: it frames the reviewer as
    a Go engineer; reword it for TypeScript. The workflow itself is
    unchanged.
13. Release: `npm version 2.0.0` on `main`.
14. After the release, deprecate the six `0.0.0`
    `@substrate-system/roast-<platform>-<arch>` packages on npm
    (`npm deprecate`), with a message pointing to
    `@substrate-system/roast` `2.0.0`.

### 2.16 Runtime startup (`src/cli.ts`)

Before anything else runs, `src/cli.ts`:

1. Checks `process.versions.node` against the floor `22.18.0`. Below it,
   the CLI writes a one-line error naming the required and the running
   version to stderr and exits non-zero without loading the rest of the
   bundle (`engines` only warns at install time, and an older Node would
   fail later with an obscure error). The check uses only syntax and
   APIs that every Node version able to parse the bundle supports.
2. Installs a `process.on('warning')` filter that drops only the
   `node:zlib` zstd `ExperimentalWarning`; every other warning is
   printed as Node would.

The README documents `NODE_USE_ENV_PROXY=1` (Node's `fetch` ignores proxy
variables without it) and `NODE_EXTRA_CA_CERTS` for corporate proxies and
private CAs. No proxy library is bundled (spec.md, "Network").

## 3. TypeScript module design

Runtime code (bundled into `dist/cli.js`):

- `src/cli.ts` -- bundle entry. No logic: calls the CLI area's
  `run(argv, io)` with `process.argv.slice(2)` and the real process IO,
  then sets `process.exitCode`. Importing `run` from elsewhere (tests)
  must not execute anything, so `run` lives in the CLI area's module, not
  here.
- `src/buildinfo.ts`:

  ```ts
  export interface BuildInfo {
      version:string;
      commit:string;
      date:string;
  }
  export const buildInfo:BuildInfo
  export function formatBuildInfo (info:BuildInfo):string
  ```

  Reads the three `__ROAST_*__` defines with a `typeof` guard so an
  unbundled or define-less build gets the sentinels (2.8).
- `src/assets.d.ts` -- ambient declarations (2.3).

Tooling (Node-run with type stripping, erasable syntax only):

- `scripts/bundle.ts` -- entry. Modes: default (the bundle, 2.5),
  `--test`, `--live`, `--diff` (until M6). Imports `esbuild` and
  `scripts/licenses.ts`. Has no exports.
- `scripts/licenses.ts` -- pure library, no top-level side effects, so the
  test bundle can import it:

  ```ts
  import type { Metafile } from 'esbuild'

  export const ALLOWED_LICENSES:readonly string[]
  export interface BundledPackage {
      name:string;
      version:string;
      license:string;
      repository:string|null;
      dir:string;
      licenseFiles:string[];
  }
  export function bundledPackageDirs (
      metafile:Metafile,
      outfile:string
  ):string[]
  export function readBundledPackages (dirs:string[]):BundledPackage[]
  export function renderNotices (
      packages:BundledPackage[],
      readFile:(path:string) => string
  ):string
  ```

  `readBundledPackages` throws an `Error` naming the package on any 2.6
  validation failure.
- `scripts/schema.ts` -- entry (2.7). Depends on the config area's
  `src/config/json-schema.ts` (`renderProjectSchema():string`).
- `scripts/check-pack.ts` -- entry (2.10). Named `check-package.ts` until
  M6.

Tests:

- `test/index.ts` -- the single test entry; imports `test/tooling/*.ts`
  and each area's `test/<area>/*.ts`.
- `test/tooling/` -- this area's tests (section 5).
- `test/live/index.ts` -- live-test entry (owned by the LLM area).
- `test/diff/` -- the differential harness (until M6). It reuses the fake
  inference server from the CLI test helpers rather than defining its own.

Dependencies on other areas: the CLI area (`run`, `.locale('en')` /
`.detectLocale(false)`), the config area (`renderProjectSchema`), the
prompts, skill, and gate areas (text asset imports), and the LLM, doctor,
and record areas (consumers of `buildInfo`).

## 4. Deliberate changes

From `00-decisions.md`, the ones that touch this area:

1. Windows is not supported: no `win32` packages, `"os": ["darwin",
   "linux"]`, and the test pipeline may use `bash`.
2. `engines.node` is `>=22.18` (the baseline said `>=20`, with a
   `devEngines` of `>=22.18`).
3. First TS release is `2.0.0`.
4. `@substrate-system/debug` is bundled as a runtime library.
5. Packaging: one pure-JS package with a bundled `dist/cli.js` replaces
   the root launcher plus six platform packages; the template npm
   lifecycle replaces the release scripts; `check:pack` is slimmed; CI
   becomes lint, typecheck, test, check:pack on Ubuntu and macOS with
   Node 22 and 24.

Consequences for build info: the Go fallback to toolchain VCS stamps is
dropped (2.8). Consequences for CI: `govulncheck`, `go-licenses`, vet,
staticcheck, gofmt, and the race detector have no successors other than
the 2.6 license allowlist and `tsc` plus eslint.

## 5. Test plan

All tests here are tapzero tests in `test/tooling/`, run from the test
bundle. Assertions are on exit codes, files, and parsed data, never on
human-readable wording.

### 5.1 Bundle smoke tests (spawn `node dist/cli.js`)

- `--version` exits 0 and its stdout contains the `package.json`
  version.
- `--help` exits 0; its stdout under `LC_ALL=de_DE.UTF-8
  LANG=de_DE.UTF-8` equals its stdout under `LC_ALL=C` (locale pinned,
  2.5 caveat).
- In a temporary Git repository with a toplevel `.roast.json` containing
  comments and a `gate` section, `gate settings` exits 0 and prints
  `timeout_seconds=` and `severity=` lines with the configured values
  (bundled `jsonc-parser` and `zod` work).
- `dist/cli.js` starts with `#!/usr/bin/env node` and has the owner
  execute bit.

- With a Node version below 22.18 reported (the startup check takes the
  version as an argument), the check returns an error naming `22.18` and
  the CLI exits non-zero; at or above the floor it passes.
- The zstd `ExperimentalWarning` filter drops that warning and passes
  other warnings through.

### 5.2 Assets and build info

- Each text asset imported through the loader equals the file read from
  disk (12 prompt templates, `SKILL.md`, `pre-commit.sh`).
- `formatBuildInfo` uses the `(commit <c>)` form when the version is
  `dev` or the date is `unknown`, and the `(<c>, <d>)` form otherwise
  (Go `TestResolve` covers only the toolchain fallback, which is dropped).
- In the test bundle `buildInfo.version` is `dev`.

### 5.3 Third-party notices

Using a fixture `node_modules` in a temp directory and a hand-built
metafile:

- collects unscoped, scoped, and nested-`node_modules` packages, and
  deduplicates by `name@version`;
- ignores inputs with `bytesInOutput: 0` and inputs outside
  `node_modules`;
- rejects a package with no license file, no `license` field, or a
  license outside the allowlist, naming the package;
- renders packages sorted by name then version, deterministically (two
  renders are equal).

Against the real build: every package derived from `dist/meta.json`
appears as a `<name>@<version>` header line in
`dist/THIRD_PARTY_LICENSES.txt`.

(Provenance: `TestLicenseGenerationGuards`,
`TestLicenseBundleGeneration`; the ownership-marker test
`TestLicenseBundleOwnershipSurvivesToolUpdates` has no successor because
notices are a single generated file under `dist/`.)

### 5.4 Package check

Runs the real `scripts/check-pack.ts` (`check-package.ts` until M6) with
`cwd` set to a fixture package that copies the real `files` and
`license` from the repo `package.json` and holds stub files:

- passes when every required file is present;
- fails when the tarball lacks `dist/cli.js`
  ("fails when the root tarball lacks the launcher");
- fails when it lacks `roast.schema.json`
  ("fails when the root tarball lacks the schema");
- fails when it lacks one of Roast's own license files
  ("fails when the root tarball lacks Roast's own license");
- fails when it lacks `dist/THIRD_PARTY_LICENSES.txt`
  ("fails when a platform tarball lacks license notices");
- fails when the manifest declares no license
  ("fails when a packed manifest declares no license");
- fails when the manifest declares `dependencies` or
  `optionalDependencies` ("installing the root package pulls in only the
  platform packages", `test/manifest.test.ts`);
- fails when `dist/cli.js` has no shebang or is not executable.

Tests that existed only for platform packages have no successor: launcher
argument and exit-code passthrough and missing-package message
(`test/launcher.test.ts`), platform binary checks in check:pack, release
ordering and abort (`test/release.test.ts`), version sync
(`test/version.test.ts`), prepublish version and binary checks
(`test/prepublish.test.ts`). The npm lifecycle itself is npm's behavior
and is not tested.

### 5.5 Schema

Owned by the config area: generated schema text equals the committed
`roast.schema.json` (successor of `TestSchemaMatchesConfigStruct`). The
init area keeps "the `$schema` written by init points inside
`node_modules/@substrate-system/roast/` at a `.json` file"
(`TestInitSchemaPointsIntoTheInstalledPackage`).

### 5.6 Differential harness

Scenario list and comparisons in 2.13. The harness is itself a test
suite; it is not tested.

## 6. Go baseline references

At commit `cd08f10`:

- `package.json`, `.npmrc`, `tsconfig.json`, `.gitignore`,
  `renovate.json`
- `scripts/build.ts`, `scripts/check-pack.ts`, `scripts/check-release.ts`,
  `scripts/platforms.ts`, `scripts/release.ts`, `scripts/version.ts`,
  `scripts/licenses.sh`, `scripts/licenses_test.go`
- `src/launcher.ts`
- `test/check-pack.test.ts`, `test/launcher.test.ts`,
  `test/manifest.test.ts`, `test/prepublish.test.ts`,
  `test/release.test.ts`, `test/version.test.ts`,
  `test/release-fixture.ts`
- `.github/workflows/ci.yml`, `.github/tools/*`
- `internal/buildinfo/buildinfo.go`, `internal/buildinfo/buildinfo_test.go`
- `internal/config/schema_test.go` (`TestSchemaMatchesConfigStruct`)
- `internal/cli/init_test.go`
  (`TestInitSchemaPointsIntoTheInstalledPackage`)
- `internal/prompts/prompts.go`, `internal/skill/skill.go`,
  `internal/gate/gate.go` (`//go:embed` assets)
- `AGENTS.md` ("Go conventions", "npm packaging"), `CONTRIBUTING.md`,
  `README.md` (Quick start)
- Template: `../template-ts-browser/` `package.json`, `tsconfig.json`,
  `tsconfig.build.json`, `eslint.config.js`, `.npmrc`, `.npmignore`,
  `test/index.ts`

## 7. Resolved

1. Keep the existing CHANGELOG history; auto-changelog regenerates new
   entries from git tags (spec.md, "Milestones").
2. CI macOS runner is `macos-latest` (2.12).
3. CI adds an `npm audit` step covering the bundled devDependencies
   (2.12).
4. CI adds a `shellcheck` step for `pre-commit.sh` (2.12).
5. `claude-review-prompt.md` is updated at M6 (2.15, item 12).
6. The six `0.0.0` platform packages are deprecated on npm at M6 (2.15,
   item 14).
7. `@substrate-system/debug` and its dependencies are checked against the
   license allowlist in M0 (2.14, item 11; spec.md, "Further Notes").
8. `@types/yargs` is added to `devDependencies` (2.1).
9. The differential harness runs in CI on Ubuntu only, M1 to M5, with an
   allowlist of spec.md's deliberate changes; deleted at M6 (2.13;
   spec.md, "Testing Decisions").
10. The CLI checks the Node version at startup and errors clearly below
    22.18 (2.16; spec.md, decision 3).
