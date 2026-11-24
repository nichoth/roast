# 08: Stored credentials

**Blocked by:** 07
**Touches:** `src/credentials/credentials.ts` (`CREDENTIALS_FILE`,
`CredentialScope`, `Entry`, `projectCredentialsPath`,
`userCredentialsPath`, `loadCredentials`, `saveCredential`,
`deleteCredential`, `CredentialStore`), `src/config/load.ts`
(`withStoredCredentials`), `src/cli/config.ts` (`loadProjectConfig`
attaches the store), `test/credentials/`
**Spec:** `spec/03-trust-credentials.md` 2.12, 2.13, 2.15, 3
(`credentials.ts`, `fsutil/atomic.ts`), 5.5; `spec/02-config.md` 2.6
(stored step of credential resolution); `docs/adr/0002-stored-credentials.md`;
spec.md "Deliberate changes" 7
**Status:** done

## What to build

Keys saved by `login` (ticket 31) live in `credentials.json` in two
scopes: project, at `<git-common-dir>/roast/credentials.json` (shared
with `trust.json` through `stateDir`), and user, at
`$XDG_CONFIG_HOME/roast/credentials.json` or
`$HOME/.config/roast/credentials.json`, with `HOME` and
`XDG_CONFIG_HOME` read from the injected env. Files are mode `0o600` in
a `0o700` directory, written atomically through `fsutil` (ticket 03),
and a file any group or other user can read is rejected. The decoder is
a strict zod schema with exact-case member names, a supported version,
known provider names (`lookupProvider`), and non-empty keys. `stored_at`
is kept as the original string so rewrites preserve it.

`CredentialStore` implements the config area's `StoredCredentials`
interface. Per the approved seam resolution 5, `lookup` is synchronous
(sync `fs` reads; the files are tiny) and returns `{key, scope}` or
`null`, preferring project scope over user scope, using only user scope
outside a repository, and throwing for a bad file. Files are read
lazily, only when a role reaches the stored step. Because `lookup` is
synchronous, the project path must be resolved before lookup (for
example when the store is constructed in `loadProjectConfig`); a store
built outside a repository uses user scope only. `loadProjectConfig`
attaches the store for the working directory with
`withStoredCredentials`. The save, delete, and path functions may stay
async as in 03 section 3.

Deferred: the CLI cases in 03 section 5.6 that go through `review` (a
project stored key reaches the fake Anthropic endpoint; env beats project
beats user; a stored key never reaches a custom endpoint or follows an
endpoint override; an over-permissive file fails the review with zero
requests; no copy of the key in stdout, stderr, or run records) are
verified in ticket 20. The doctor cases are ticket 35.

## Acceptance criteria

- [x] The project path is `<git-common-dir>/roast/credentials.json`,
      also from a linked worktree.
- [x] The user path follows `XDG_CONFIG_HOME`, else `HOME/.config`; with
      neither set it is an error.
- [x] `saveCredential` writes a `0o600` file in a `0o700` directory,
      replaces it atomically, leaves no temp file behind, and round-trips
      keys and `stored_at`.
- [x] `saveCredential` tightens an existing `0o755` directory to `0o700`.
- [x] `deleteCredential` removes one provider and keeps the others;
      deleting from a missing file is a no-op.
- [x] A missing file loads as empty.
- [x] Loading rejects an unknown provider, unknown entry field, unknown
      top-level field, missing version, wrong version, empty key, and
      non-JSON text.
- [x] Member names match exactly: `"Version"`, `"Providers"`, and
      `"Key"` spellings are rejected as unknown members.
- [x] Loading rejects files with modes `0o640`, `0o604`, `0o644`, and
      `0o620`.
- [x] `CredentialStore.lookup` is synchronous, prefers project scope
      over user scope, uses only user scope outside a repository, and
      throws for a bad file in the scope it reaches.
- [x] A config returned by `loadProjectConfig` in a temp repo with a
      project stored key resolves a built-in-endpoint role to that key
      with a source naming the project scope and provider, never the key;
      an env key for the same provider still wins.
- [x] A role that never reaches the stored step resolves even when a
      credentials file is broken.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
      the Go build and `go test ./...` still pass.
