# 02: Third-party notices and slimmed package check

**Blocked by:** 01
**Touches:** `scripts/licenses.ts` (`ALLOWED_LICENSES`, `BundledPackage`,
`bundledPackageDirs`, `readBundledPackages`, `renderNotices`),
`scripts/bundle.ts` (notices step), `scripts/check-package.ts` (new; the
final `check-pack.ts`, renamed at M6), `dist/THIRD_PARTY_LICENSES.txt`
(generated), `test/tooling/licenses.ts`, `test/tooling/check-package.ts`
**Spec:** `spec/15-packaging.md` 2.5 (step 4 and 6), 2.6, 2.10, 2.14
(items 5 and 11), 3 (`scripts/licenses.ts`, `scripts/check-pack.ts`),
5.3, 5.4; spec.md "Further Notes" (debug license check)
**Status:** done

## What to build

Every `npm run bundle` writes `dist/THIRD_PARTY_LICENSES.txt` next to
`dist/cli.js`: the license text of every package whose code is actually
in the bundle, derived from the in-memory esbuild metafile by the 2.6
algorithm (inputs with `bytesInOutput > 0` under `node_modules/`, package
root by last `node_modules/` segment with scoped names, `package.json`
`license` string, license files matching
`/^(licen[cs]e|copying|notice)(\..*)?$/i`, dedupe by `name@version`,
sorted render in the 2.6 layout, one trailing newline). The build fails,
naming the package, when a bundled package has no `license` field, an
SPDX identifier outside the allowlist (`Apache-2.0`, `BSD-2-Clause`,
`BSD-3-Clause`, `ISC`, `MIT`, `MPL-2.0`, `Unlicense`), or no license file.
`scripts/licenses.ts` is a pure library with no top-level side effects so
the test bundle can import it; `scripts/bundle.ts` calls it.

M0 license gate (2.14 item 11): the bundle must pull in
`@substrate-system/debug` (import it from a runtime module, for example a
small `src/debug.ts` that exposes the `roast:<area>` namespace factory
later areas use) so its whole dependency tree goes through the allowlist
now, before other areas depend on it. If any of its dependencies fail the
allowlist, stop and record the failure on this ticket for the maintainer
(replacing the library or extending the allowlist needs maintainer
approval); do not extend the allowlist yourself.

`scripts/check-package.ts` is the slimmed package check of 2.10. It
operates on `process.cwd()`, runs `npm pack --dry-run --json` (accept npm
12's object keyed by name and older npm's array), and fails unless the
tarball lists `dist/cli.js`, `dist/THIRD_PARTY_LICENSES.txt`,
`roast.schema.json`, `LICENSE.txt`, `LICENSE-MIT.txt`,
`LICENSE-APACHE.txt`; fails when `package.json` has no `license`, a
non-empty `dependencies`, or any `optionalDependencies`; fails when
`dist/cli.js` lacks the shebang or the owner execute bit. It prints every
problem then a hint and exits 1, or one summary line and exits 0. It would
fail against the transitional manifest, so it is not added to CI or any
npm lifecycle script yet; only its fixture tests run. The baseline
`scripts/check-pack.ts` stays untouched until M6.

## Acceptance criteria

- [x] With a fixture `node_modules` in a temp directory and a hand-built
      metafile, notices collect unscoped, scoped, and nested
      `node_modules` packages and deduplicate by `name@version`.
- [x] Inputs with `bytesInOutput: 0` and inputs outside `node_modules`
      are ignored.
- [x] A package with no license file, no `license` field, or a license
      outside the allowlist makes `readBundledPackages` throw an error
      naming that package.
- [x] Two renders of the same packages are equal, and packages appear
      sorted by name then version.
- [x] After a real `npm run bundle`, every package derived from
      `dist/meta.json` appears as a `<name>@<version>` header line in
      `dist/THIRD_PARTY_LICENSES.txt`, and `@substrate-system/debug` is
      among them.
- [x] `scripts/check-package.ts` run in a fixture package (copying the
      real `files` and `license`, with stub files) exits 0 when every
      required file is present.
- [x] It exits 1 when the tarball lacks `dist/cli.js`,
      `roast.schema.json`, one of Roast's license files, or
      `dist/THIRD_PARTY_LICENSES.txt` (one case each).
- [x] It exits 1 when the manifest declares no `license`, a non-empty
      `dependencies`, or `optionalDependencies`.
- [x] It exits 1 when `dist/cli.js` has no shebang or is not executable.
- [x] `npm run lint`, `npm run typecheck`, `npm run test:ts` pass;
      `go test ./...` still passes.

## Blocker: `@substrate-system/debug` fails the license allowlist

Needs a maintainer decision (2.14 item 11).

`@substrate-system/debug@0.9.68` declares `"license": "SEE LICENSE IN
LICENSE"`, and its `LICENSE` is the Big Time Public License 2.0.2
(free only for noncommercial use and small businesses). Neither is in
the 2.6 allowlist. With a `src/debug.ts` that imports it from a runtime
module, `npm run bundle` exits 1 with:

```
@substrate-system/debug@0.9.68 (.../node_modules/@substrate-system/debug)
declares license "SEE LICENSE IN LICENSE", which is not in the allowlist
(Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, MPL-2.0, Unlicense)
```

Its only dependency, `supports-color@10.2.2`, is MIT and passes.

The license step is in place and enforces the allowlist. The bundle does
not import `@substrate-system/debug` yet, so the bundle and the tests
still pass. The acceptance clause "`@substrate-system/debug` is among
them" stays open until the maintainer chooses one of these: relicense
the library under an allowed license, extend the allowlist, or replace
the library (for example with a small `DEBUG=roast:*` logger in `src/`).

## Note: license-file pattern widened

`emoji-regex@10.6.0` (via yargs -> cliui/string-width) ships its license
only as `LICENSE-MIT.txt`, which the 2.6 pattern
`/^(licen[cs]e|copying|notice)(\..*)?$/i` misses. The bundle would then
fail on yargs's own dependency tree. `scripts/licenses.ts` accepts `-`
as well as `.` after the base name: `([.-].*)?`. License-field
validation is unchanged.
