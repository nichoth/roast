# Contributing

Thanks for helping improve Roast. Bug reports and focused pull requests are
welcome. For large features, new dependencies, inference protocols, or changes
to artifact formats, open an issue before writing the implementation so the
contract can be agreed on first.

## Development

Contributors need Node 22.18 or newer and Git, on macOS or Linux. Go is
needed only to run the CI tool modules under `.github/tools/` locally.
Clone the repository, then:

```sh
npm install
npm run lint
npm run typecheck
npm test
```

`npm test` builds `dist/cli.js` (`npm run build`), then bundles the test
suite and runs it in Node; it does not type-check, so run
`npm run typecheck` too. `npm run test:one -- test/<area>/<file>.ts`
runs one test module. Scripts under `scripts/` are TypeScript that Node
runs directly, so they use only erasable syntax (no enums, namespaces, or
parameter properties).

`npm run build` regenerates `roast.schema.json` from the config schema,
bundles the CLI into `dist/cli.js`, and writes
`dist/THIRD_PARTY_LICENSES.txt`. Commit a regenerated schema with the
change that caused it; CI fails when the committed file differs. After a
build, `npx roast` in this repository runs `dist/cli.js`, the same way it
resolves in a user's project. Build before using it: with no build, a
`roast` elsewhere on your `PATH` can answer instead.

Also run these before opening a pull request:

```sh
npm run check:pack
go -C .github/tools/actionlint tool actionlint
shellcheck src/gate/pre-commit.sh
```

`npm run check:pack` dry-run packs the package and checks that the
tarball holds the bundle, its notices, the schema, and Roast's license
files, and that the manifest declares no dependencies. CI-only Go tools
have separate modules under `.github/tools/`, maintained by Renovate.

Tests use local HTTP servers and temporary Git repositories; they must
not require real model credentials or send repository content to an
inference provider.

Opt-in live tests in `test/live/` run a minimal two-turn tool loop (one
exploration call, its result, then the submission on the wrap-up turn)
against a real endpoint with a small output ceiling. They send a fixed
probe prompt, never repository content, and skip unless their API key
variable is set. `npm test` never runs them, and neither does CI:

| Variable | Default |
| --- | --- |
| `ROAST_LIVE_ANTHROPIC_API_KEY` | unset (skip) |
| `ROAST_LIVE_ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` |
| `ROAST_LIVE_ANTHROPIC_MODELS` | `claude-sonnet-5-5` (comma-separated) |
| `ROAST_LIVE_DEEPSEEK_API_KEY` | unset (skip) |
| `ROAST_LIVE_DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| `ROAST_LIVE_DEEPSEEK_MODEL` | `deepseek-v4-pro` |
| `ROAST_LIVE_DEEPSEEK_PROTOCOL` | `chat` (or `anthropic` with an `/anthropic/v1` base URL) |

```sh
ROAST_LIVE_ANTHROPIC_API_KEY=... npm run test:live
```

With a DeepSeek key, a second test makes one structured call with a
256-token output ceiling, which a thinking model spends on reasoning
before it calls a tool. It checks that the error names the `length`
finish and suggests raising `max_output_tokens`, and skips if the model
answers within the ceiling. Never commit keys or paste them into logs.

CI runs a Git-history secret scan and `npm audit --audit-level=high`.
Roast has no runtime `dependencies`: libraries it runs are
`devDependencies` bundled into `dist/cli.js`. A new bundled library
must use a license on the allowlist (see "Third-party notices" below)
and should be justified in the pull request.

Pull-request CI runs on GitHub-hosted runners with read-only repository
permissions and no inference or publishing credentials. The `claude-review`
and `claude-mention` workflows are the exception: they hold an Agent Gateway
inference credential and can comment on pull requests, but review only
non-draft PRs from branches in this repository and answer only commenters with
write access. Keep that boundary: do not run contributor-controlled code in
`pull_request_target` or a privileged `workflow_run` job. Pin external actions
to full commit SHAs. Do not bootstrap privileged jobs from pull-request
artifacts.

Keep changes narrow and include regression tests for behavior changes. Update
the README whenever a public flag, configuration field, credential variable,
artifact, data destination, or exit-code behavior changes. Adding, removing,
or retyping a project config field also means updating `roast.schema.json`.

Pull request titles need a conventional `type:` prefix (such as `feat:`,
`fix:`, or `docs:`), checked in CI.

## Releases

Roast is published to npm only, from a maintainer's machine; CI never
publishes. `@substrate-system/roast` is one package holding
`dist/cli.js`, its third-party notices, the config schema, and Roast's
license files.

```sh
npm version <major|minor|patch|x.y.z>
```

The npm lifecycle does the rest. `preversion` runs `npm run lint`; npm
writes the version into `package.json`; `version` updates the README
table of contents and `CHANGELOG.md` (through `auto-changelog`) and
stages them; npm commits and tags `v<x.y.z>`; `postversion` pushes the
commit and tag and runs `npm publish`, whose `prepublishOnly` runs
`npm run build` and `npm run check:pack`. If `prepublishOnly` fails
after the tag was pushed, fix it with a follow-up patch release rather
than re-tagging.

## Third-party notices

`npm run build` writes `dist/THIRD_PARTY_LICENSES.txt` from the esbuild
metafile (`scripts/licenses.ts`): one entry per package that has code in
the bundle, with its declared license and the license files it ships.
The build fails, naming the package, when a bundled package has no
`license` field, no license file, or a license outside the allowlist
`Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MIT`, `MPL-2.0`,
`Unlicense`. Extending the allowlist needs maintainer approval. When
changing dependencies, read the generated notices; automated
classification is not a substitute for legal review.

Prefer tagged stable dependency releases. Explain any necessary
development pin or prerelease in its pull request and revisit it when a
stable release permits.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md)
instead.
