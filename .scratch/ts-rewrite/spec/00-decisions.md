# TypeScript rewrite: settled decisions

Shared brief for every area file in this directory. Decided with the
maintainer in a grilling session on 2026-11-18. Area files must not
contradict anything here; if the Go code makes a decision here look wrong,
record it under "Open questions" in the area file instead of deviating.

## Baseline

- Hard fork of the Go implementation. The parity baseline is Go commit
  `cd08f10` in this repository. Upstream (`bluesky-social/roast`) is not
  tracked.
- Parity by default: same commands, flags, defaults, exit codes, JSON
  output, run records, and security behavior. Deliberate changes are only
  the ones listed under "Deliberate changes".

## Deliberate changes from Go

The complete list, including the tightenings and Go bug fixes decided
after the area files were drafted, is in `../spec.md` under "Deliberate
changes from the Go baseline". The six below are the product changes.

1. The cobra `completion` command is dropped.
2. Windows is not supported. `package.json` declares
   `"os": ["darwin", "linux"]`. Browser opening uses `open` (macOS) or
   `xdg-open` (Linux) only.
3. Node `>=22.18` (`engines`).
4. Trust hash v2: SHA-256 over RFC 8785 (JCS) canonical JSON of the same
   trust projection fields (endpoint, protocol, credential variable name,
   raw prompt-override paths). `trust.json` gets `version: 2`. Approvals
   written by the Go version are ignored: the config is untrusted, the
   message says it was approved by an older Roast and names
   `npx roast trust`, exit code 2 like any untrusted config.
5. Debug tracing via `@substrate-system/debug`, namespaces `roast:<area>`,
   enabled with `DEBUG=roast:*`. Debug output never includes request or
   response bodies, headers, prompts, or credentials.
6. First TypeScript release is `2.0.0`.

## Compatibility

- `.roast.json` (JSONC, `version: 1`) stays compatible: every field, default,
  validation range, and error condition.
- `credentials.json` (both scopes) stays compatible: shape, location,
  permissions rules.
- The pre-commit hook contract stays compatible (runs
  `node_modules/.bin/roast` at the Git toplevel, `gate settings`, then
  `review --staged`).
- Run records and run bundles keep their current formats.

## Packaging and tooling

- One pure-JS npm package. `bin.roast` is `dist/cli.js`, a single esbuild
  ESM bundle (`--platform=node`) with a shebang. The six platform packages
  under `packages/`, the Go launcher (`src/launcher.ts`), and the platform
  release scripts are deleted at cutover.
- Runtime libraries are `devDependencies` and bundled into `dist/cli.js`,
  so installing Roast adds no transitive packages to a user's project:
  `yargs`, `zod`, `jsonc-parser`, `@substrate-system/debug`.
  `dist/THIRD_PARTY_LICENSES.txt` is generated from the esbuild metafile
  (license text of every bundled package).
- CLI only. No library entry point or exported API.
- TypeScript and npm config follow `../template-ts-browser/`, adapted for
  Node: TypeScript `^7`, `strict`, `isolatedModules`, ES2022, `types:
  ["node"]`, no DOM lib, `moduleResolution: Bundler` (esbuild bundles).
  eslint with `newneostandard` + `typescript-eslint`. Tests use
  `@substrate-system/tapzero`, bundled with esbuild and run in Node, piped
  to a TAP formatter. `auto-changelog`, `markdown-toc`, and the template's
  `preversion` / `version` / `postversion` / `prepublishOnly` lifecycle.
- Release: the template's npm lifecycle replaces `scripts/release.ts`,
  `version.ts`, `check-release.ts`, `platforms.ts`, `licenses.sh`. A slimmed
  `check:pack` stays in CI and asserts the tarball contains `dist/cli.js`,
  `roast.schema.json`, Roast's license files, and the third-party notice.
- CI: lint, typecheck, test, `check:pack` on Ubuntu and macOS, Node 22 and
  24. The `claude-mention`, `claude-review`, and `pr-title` workflows are
  unchanged.

## Architecture

- Source layout: one directory per Go package under `src/<area>/`
  (`src/config/`, `src/llm/`, `src/scope/`, ...), single bundled entry
  `src/cli.ts`. Tests in `test/<area>/`, imported from `test/index.ts`.
- CLI parsing: `yargs` (bundled, pinned to English locale, locale detection
  off). Bare `roast` is the default command and aliases `review`. Go-style
  durations (`90s`, `10m`, `1h30m`) are parsed by a helper so existing
  flags and configs keep working. `--flag=false` boolean syntax keeps
  working. Help text does not need to match cobra byte-for-byte.
- Config: `jsonc-parser` for JSONC; a `zod` schema is the single source of
  truth for `.roast.json` validation; `roast.schema.json` is generated from
  it, with a test that the committed file matches the generated one.
  Validation error wording must be equivalent, not identical.
- LLM: raw `fetch`, no provider SDKs and no LLM framework. Three protocol
  adapters (`chat`, `responses`, `anthropic`) behind one internal interface,
  one shared SSE parser, and Roast's own agent loop that preserves every Go
  invariant: raw response capture into run records (size caps, streaming
  capture), ambient environment never adding headers or credentials,
  session headers, the reserved wrap-up turn, the token ledger, retry
  policy, schema validation of the final tool call.
- Git is driven through the `git` CLI via `execFile` (no isomorphic-git).
- Go `context.Context` becomes an `AbortSignal` threaded through every
  I/O function; deadlines use `AbortSignal.timeout` / `AbortSignal.any`.
  Go worker pools become a small promise pool.
- zstd and gzip come from `node:zlib` (zstd is available from Node 22.15).
  Tar archives use a small in-house deterministic ustar writer.
- Prompt template files move over unchanged as text assets (esbuild text
  loader). The two rendered user prompts (`finder_user`, `verifier_user`)
  become typed TS render functions producing identical output; a temporary
  differential test against Go output proves it. Prompt override files are
  used verbatim, as in Go.
- Terminal: secret input without echo via raw mode on a TTY, plain line
  reads otherwise (one shared reader across prompts, as in Go). Terminal
  detection and browser opening are swappable module-level functions, as in
  Go, so tests never touch a real terminal or browser.
- Opt-in live provider tests (`ROAST_LIVE_*`) are kept, never run in CI.

## Testing

- Go tests are ported module by module to tapzero. HTTP fakes use
  `node:http` servers in place of `httptest`.
- Highest seam (preferred): the CLI run in-process -- a `run(argv, io)`
  entry with injectable stdin/stdout/stderr, env, and cwd -- against a
  `node:http` fake inference server, with a swappable `fetch` so profiles on
  a built-in provider's default endpoint can be served by the fake (the
  equivalent of Go's `redirectDefaultTransport`). Lower seams only where the
  behavior is not observable through the CLI at reasonable cost: the token
  ledger, trust hashing, text sanitization, the SSE parser, and the agent
  loop driven by a scripted fake protocol adapter.
- A temporary Go-vs-TS differential harness runs both CLIs against the same
  fake server and compares exit codes, JSON output, and run records (not
  rendered Markdown). Deleted at cutover.
- Do not write brittle tests: no assertions on exact human-readable text,
  no tests of docs or CSS. Assert on exit codes, JSON, files written, and
  requests received.

## Milestones

M0. Scaffold: template config, lint, test runner, CI.
M1. Config, trust, credentials (no network).
M2. Git scope and context (diff, untracked, renames, grounding).
M3. `chat` protocol, agent loop, finder, verifier, render, records: first
    working `npx roast review` end to end.
M4. `responses` and `anthropic` adapters.
M5. `init`, `login`/`logout` (incl. OpenRouter PKCE), `doctor`, `trust`,
    `gate`, `skill`, `ignore`, `runs` (incl. snapshot checkout/prune).
M6. Packaging cutover: delete Go, `packages/`, launcher; update AGENTS.md;
    release 2.0.0.

## Area file conventions

Each area file in this directory is self-contained: a reader must be able
to implement the area from the file alone, without the Go source. It
follows this outline:

1. **Purpose** -- what the area does, in `CONTEXT.md` vocabulary.
2. **Behavior contract** -- every command, flag, default, validation rule,
   error condition, exit code, file format, algorithm, constant, limit, and
   ordering rule the Go baseline implements. Restate behavior; do not just
   point at Go code. Exact formats (JSON shapes, file layouts, hook script
   interface) are written out in full.
3. **TypeScript module design** -- modules under `src/<area>/`, their
   exported types and functions (type signatures are fine), and which other
   areas they depend on.
4. **Deliberate changes** -- only those from this file that apply here.
5. **Test plan** -- the behaviors the Go tests pin down (grouped, named by
   behavior, with the Go test name in parentheses for provenance), and the
   seam each is tested at.
6. **Go baseline references** -- the Go files and tests the area was
   derived from (provenance only, at commit `cd08f10`).
7. **Open questions** -- anything ambiguous or that the Go code leaves
   unclear. Never invent behavior to fill a gap.

Writing style: no em dashes (use `--`), no arrow characters (use `->`),
lines at most 80 columns, TypeScript type annotations with no space after
the colon (`name:string`).
