---
status: proposed
---

# Trust approvals hash a canonical JSON projection

Partly supersedes ADR-0001: the trust model is unchanged, but how an approval
is hashed and stored changes.

The TypeScript rewrite (ADR-0004) would otherwise have to reproduce the Go
implementation's exact serialization of the trust projection to keep
existing approvals valid. Nothing beyond `0.0.0` was published to npm, so
the only approvals in the wild belong to users of the Go binary, and asking
them to approve once more is cheap. We take the break and pick a hash that
any implementation can reproduce from a written definition.

The projection keeps the same fields as ADR-0001: per role, the endpoint,
protocol, and credential variable name, plus the raw prompt-override paths.
The approval hash is the SHA-256 of the projection serialized as RFC 8785
(JSON Canonicalization Scheme) canonical JSON, so key order and whitespace
never change the hash. `trust.json` carries `version: 2`. A version-1 file,
written by the Go implementation, is not an approval: the config is
untrusted, the message says it was approved by an older Roast and names
`npx roast trust`, and `review` exits 2 like any other untrusted config.
Approving rewrites the file as version 2.

## Considered options

- Reproduce the Go serialization byte for byte: keeps existing approvals,
  but ties the hash to an implementation detail that must be reverse
  engineered and pinned by fixtures forever.
- Accept both versions during a migration window: more code on the
  security-relevant path for a handful of users who can re-approve in one
  command.
