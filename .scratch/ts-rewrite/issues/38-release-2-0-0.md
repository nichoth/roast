# 38: Release 2.0.0

**Blocked by:** 37
**Touches:** npm registry (`@substrate-system/roast` and the six
`@substrate-system/roast-<platform>-<arch>` packages), git tag `v2.0.0`
on `main`, `CHANGELOG.md`, `README.md` (via the `version` lifecycle)
**Spec:** `spec/15-packaging.md` 2.11, 2.15 items 13 to 14;
`spec/13-login.md` 4 (headless check); spec.md Further Notes (headless
OpenRouter login needs a manual check before release)
**Status:** ready-for-human

## What to build

Publish the first TypeScript release and retire the Go-era platform
packages. This ticket needs a human: it publishes to npm, pushes a tag,
and needs a live OpenRouter account. None of it can run in CI or by an
autonomous agent.

Steps, in order:

1. **Live headless OpenRouter check.** From a build of `main`, in a
   scratch Git repository with a toplevel `.roast.json` that uses
   OpenRouter, run `npx roast login openrouter --no-browser` against the
   real service. Open the printed URL (it has no `callback_url`),
   approve, and paste the code. Confirm the minted key is stored in the
   project `credentials.json` and that a small `npx roast review` on an
   OpenRouter profile succeeds. If the flow fails, file a bug ticket and
   stop. Do not release.
2. **Release.** On an up-to-date `main` with a clean tree, run
   `npm version 2.0.0`. The lifecycle runs lint, updates the README TOC
   and `CHANGELOG.md`, commits, tags `v2.0.0`, pushes with tags, and
   publishes. `prepublishOnly` builds and runs `check:pack`. If
   `prepublishOnly` fails after the tag was pushed, fix it in a
   follow-up patch release rather than re-tagging.
3. **Deprecate.** After `2.0.0` is visible on npm, run `npm deprecate`
   on each of the six `0.0.0` platform packages
   (`@substrate-system/roast-{darwin,linux,win32}-{arm64,x64}`). The
   message points to `@substrate-system/roast` `2.0.0`.

## Acceptance criteria

- [ ] The live headless OpenRouter login stored a minted key, and a
      review on an OpenRouter profile succeeded with it. The result is
      noted in this ticket's Comments.
- [ ] `npm view @substrate-system/roast version` prints `2.0.0`, and
      `npm view @substrate-system/roast dependencies` is empty.
- [ ] Tag `v2.0.0` exists on `origin`, and `CHANGELOG.md` has a `2.0.0`
      entry above the kept 1.4.x history.
- [ ] In a fresh temp project on macOS and on Linux,
      `npm i -D @substrate-system/roast@2.0.0` installs with no platform
      package and no transitive dependency. `npx roast --version` prints
      `2.0.0` with a commit and date.
- [ ] `npm view @substrate-system/roast-<platform>-<arch> deprecated`
      is non-empty for all six platform packages.
