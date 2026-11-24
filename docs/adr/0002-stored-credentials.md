---
status: accepted
---

# Stored credentials, scoped to the project or the user

Credentials used to come only from environment variables. Every shell,
editor, and pre-commit gate that ran a review had to export a key by hand,
which is the main thing standing between `npx roast init` and a first
review. Roast now also reads a **stored credential**: a key for a built-in
provider kept in a credentials file that `npx roast login` writes.

There are two scopes. The project scope is
`<git-common-dir>/roast/credentials.json`, next to the trust record
(ADR-0001): it lives inside `.git`, so it cannot be committed, `git clone`
never copies it, and linked worktrees share it. The user scope (`login
--global`) is `$XDG_CONFIG_HOME/roast/credentials.json`, falling back to
`~/.config/roast/credentials.json`. Both are JSON with `version: 1` and a map
from built-in provider name to a key and when it was stored; unknown
providers and fields are rejected. Files are written atomically with mode
0600 in a 0700 directory, and on Unix a file that group or others can read is
an error telling the user to `chmod 600` it, never silently skipped.

Stored credentials rank below every environment variable, so CI and existing
setups keep working unchanged. A role's credential is the first of
`ROAST_<ROLE>_API_KEY`, the profile's `api_key_env`, the provider's standard
variable, the project-scope stored key, then the user-scope stored key. The
last three apply only when the role is on that built-in provider's endpoint
with a protocol it accepts there. A stored key is matched to a profile only
through the built-in provider registry (endpoint plus protocol), never
through anything the project config names, so a profile on a custom
endpoint, or a role an override moved off its provider's endpoint, never
receives one. The project config still never holds a credential.

## Considered options

- OS keychain (macOS Keychain, Secret Service, Windows Credential Manager):
  better at-rest protection, but needs a new dependency per platform, fails
  on headless Linux and in containers without a keyring daemon, and has no
  natural per-project scope.
- A user-only credentials file: simpler, but a project scope was asked for,
  so different projects can use different keys (for example separate
  billing) without environment juggling.
- Not storing credentials: keeps the old model, but leaves the setup problem
  this decision exists to solve.

A plain file with strict permissions needs no new dependency, works headless
and on every OS, and supports both scopes. It does not encrypt the key at
rest; anyone who can read the user's files can read it, as with the shell
profiles that held these keys before.
