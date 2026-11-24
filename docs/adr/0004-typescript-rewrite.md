---
status: proposed
---

# Roast is a TypeScript package that talks to providers over raw fetch

Roast was a Go binary shipped through npm as six platform packages and a
launcher. Every Roast install is already a Node project dependency, so a Go
toolchain, per-platform builds, and the launcher add release machinery
without serving users. We rewrite Roast in TypeScript as one pure-JS npm
package, `2.0.0`, with behavior parity against Go commit `cd08f10` except
for named changes: no Windows support, no `completion` command, Node
`>=22.18`, and the trust hash in ADR-0003.

Runtime libraries (`yargs`, `zod`, `jsonc-parser`,
`@substrate-system/debug`) are bundled into one esbuild ESM file, so
installing Roast adds no transitive packages to a user's project, the same
property the Go binary had. Their license texts ship in a generated
third-party notice.

Inference uses raw `fetch` with one adapter per protocol (`chat`,
`responses`, `anthropic`) and Roast's own agent loop, not a provider SDK
or an LLM framework. The Go version used the Fantasy framework but had to
wrap or override much of it: it captured raw response bytes for run
records, removed headers the SDKs read from ambient environment variables,
replaced retry and tool-call-repair behavior, sized requests for the token
ledger before sending, and reserved a wrap-up turn. Official SDKs would need
the same overrides on two codebases; owning the wire layer puts all of it in
one place.

## Considered options

- Keep Go: no rewrite cost, but keeps the multi-package release and a second
  toolchain for a tool whose users all run Node.
- Official `openai` and `@anthropic-ai/sdk` SDKs: typed streaming for free,
  but both read ambient configuration and run their own retries, which Roast
  must defeat to keep its credential and capture guarantees.
- Vercel AI SDK: closest to Fantasy, but it hides the request bytes and the
  retry policy that the ledger and run records depend on.
