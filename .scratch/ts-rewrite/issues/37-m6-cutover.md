# 37: M6 cutover

**Blocked by:** 25, 27, 28, 30, 32, 35, 36, 41, 42, 43, 44, 45
**Touches:** `internal/prompts/templates/` -> `src/prompts/templates/`,
`internal/skill/assets/roast/` -> `src/skill/assets/roast/`,
`internal/gate/pre-commit.sh` -> `src/gate/pre-commit.sh` (with `git mv`,
plus their imports); deletes `cmd/`, `internal/`, `go.mod`, `go.sum`,
`packages/`, `src/launcher.ts`, `tsconfig.launcher.json`,
`scripts/build.ts`, old `scripts/check-pack.ts`,
`scripts/check-release.ts`, `scripts/platforms.ts`, `scripts/release.ts`,
`scripts/version.ts`, `scripts/licenses.sh`, `scripts/licenses_test.go`,
the legacy `test/*.test.ts` and `test/release-fixture.ts`, `test/diff/`,
`.github/tools/{staticcheck,govulncheck,licenses}`; renames
`scripts/check-package.ts` -> `scripts/check-pack.ts`; edits
`package.json`, `tsconfig.json`, `.npmrc`, `.gitignore`,
`scripts/bundle.ts` (drop `--diff`), `.github/workflows/ci.yml`,
`AGENTS.md`, `README.md`, `CONTRIBUTING.md`,
`.github/claude-review-prompt.md`
**Spec:** `spec/15-packaging.md` 2.1, 2.2, 2.3, 2.5 (asset locations),
2.9, 2.10, 2.12, 2.15 items 1 to 12, 2.16 (README network note);
`spec/00-decisions.md` "Packaging and tooling"
**Status:** done

## What to build

Switch the repository to the pure TypeScript package. After this ticket
there is no Go implementation, no platform packages, and no launcher.
`npm i -D @substrate-system/roast` installs one package whose
`bin.roast` is the bundled `dist/cli.js`. The release itself (`npm
version 2.0.0`, npm deprecation) is ticket 38, not this one. `version`
stays `0.0.0` here.

Preconditions to confirm before deleting anything:

- every area's test plan is ported and green;
- the differential harness passes every scenario, or each difference is
  an accepted Open question;
- `npm run build && npm run check:pack` passes against the final
  manifest.

Record in the pull request that each was confirmed.

Work through `spec/15-packaging.md` 2.15 items 1 to 12 in order:

1. Move the text assets with `git mv` and update the import paths.
2. Delete Go.
3. Delete the npm-packaging code and its tests.
4. Rename the package check.
5. Delete the harness, its `--diff` mode, its script, and its CI job.
6. Bring `package.json` to its 2.1 form. That drops `workspaces`,
   `optionalDependencies`, `devEngines`, `build:launcher`, `release`,
   `test:ts`, `bundle`, and the lint `--ignore-pattern` flags.
   `tsconfig.json` loses its legacy `exclude`, and `.npmrc` becomes
   `package-lock=false`.
7. Update `.gitignore` per 2.2, and delete the root
   `THIRD_PARTY_LICENSES/` directory.
8. Bring `ci.yml` to its 2.12 form, including the security job's
   `npm audit` and `shellcheck src/gate/pre-commit.sh` steps, and delete
   the three tool modules.
9. Rewrite the agent notes (`AGENTS.md` is an index; area notes live in
   `docs/agents/<area>.md`): delete `docs/agents/go.md` (moving its
   test-env clearing notes to the TS successor in
   `docs/agents/typescript.md`), rewrite `docs/agents/packaging.md`
   with the new build and release notes, drop the differential-harness
   section, the Go halves of the area files, and the `.npmrc`
   `force=true` trap in `AGENTS.md`. Every remaining `internal/...`
   path, `.go` file, and Go helper name becomes the TS module and
   helper name.
10. Update the README: Node 22.18+, macOS and Linux only, pure
    JavaScript, and a Network note on `NODE_USE_ENV_PROXY=1` and
    `NODE_EXTRA_CA_CERTS`.
11. Update CONTRIBUTING.
12. Update `.github/claude-review-prompt.md` for a TypeScript reviewer.

Docs follow the repo rules: `npx roast ...` invocations, no em dashes,
no arrow characters. AGENTS.md is edited with the `writing-for-agents`
guidance.

## Acceptance criteria

- [x] `git ls-files` lists no `*.go`, `go.mod`, `go.sum`, `packages/`,
      `src/launcher.ts`, or `test/diff/` path. The 12 templates,
      `SKILL.md`, and `pre-commit.sh` exist only under `src/`, and git
      shows them as renames.
- [x] The text-asset tests pass against the new locations. Each asset
      imported through the loader equals its file on disk.
- [x] `package.json` deep-equals the 2.1 manifest apart from `version`,
      which stays at its pre-release value, and dependency version
      ranges current at the time. It has no `dependencies`,
      `optionalDependencies`, `workspaces`, `main`, or `exports`.
- [x] `.npmrc` is exactly `package-lock=false`, and `.gitignore` has no
      Go-era entries.
- [x] `npm install` in a clean clone prints no "using --force" warning.
- [x] `npm pack --dry-run --json` lists exactly the `files` from 2.1.
      `npm run check:pack` (the renamed slim check) passes.
- [x] Installing the packed tarball into an empty temp project adds no
      transitive packages. `npx roast --version` there exits 0.
- [x] `ci.yml` has no Go setup in the test job, no gofmt, vet,
      staticcheck, govulncheck, or go-licenses step, and no harness job.
      The security job runs gitleaks, actionlint, `npm audit
      --audit-level=high`, and `shellcheck src/gate/pre-commit.sh`.
      `actionlint` passes on it.
- [x] AGENTS.md, `docs/agents/`, README.md, CONTRIBUTING.md, and the
      review prompt contain no reference to `internal/`, `go test`, `go mod tidy`,
      staticcheck, `GOFLAGS`, platform packages, or the launcher.
- [x] The final-state CI steps pass locally on this machine:
      `npm run lint`, `npm run typecheck`, `npm test`,
      `git diff --exit-code -- roast.schema.json`, and
      `npm run check:pack`.
