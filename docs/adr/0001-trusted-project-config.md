---
status: accepted (hashing partly superseded by ADR-0003)
---

# Project config is trusted per clone, not refused

Upstream Roast refused all repository-local configuration so a checkout could
never choose where reviewed code or credentials are sent. Roast is now
installed as a project dependency, so the repository's lockfile already
decides which Roast binary runs and its npm scripts can already run arbitrary
code with the user's environment; refusing a config file no longer buys that
protection. We therefore load every non-secret setting from `.roast.json`, but
before using one that names a non-default endpoint, a credential variable, or a
prompt-override file, Roast shows those values and requires explicit approval.

The approval is a hash of only those security-relevant values, stored in
`.git/roast/trust.json` (the common Git dir, so worktrees share it). `git
clone` never transfers `.git/`, so a repository cannot ship its own approval,
and editing a review threshold does not re-prompt. A config that uses only the
default OpenAI or Anthropic endpoints with their standard key variables and no
prompt overrides needs no approval. Untrusted configs fail closed for
`npx roast review` and fail open (warn and allow) for the gate. There is no
environment-variable bypass; CI approves explicitly with `npx roast trust --yes`.

## Considered options

- Keep endpoints and credential mapping in user-level config only: safest,
  but splits configuration across two homes and defeats the local-install
  goal.
- Trust everything in `.roast.json` unconditionally: simplest, but lets a
  cloned repository silently redirect a developer's provider key.
