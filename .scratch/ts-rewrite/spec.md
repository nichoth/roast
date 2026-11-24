# TypeScript rewrite of Roast

**Status:** ready-for-agent

This is the index of a self-contained spec. The settled decisions are in
`spec/00-decisions.md`; each area is specified in its own file under
`spec/` (listed under "Area files"). Where this index and an area file
disagree, the "Resolved open questions" section below wins, then the area
file, then `spec/00-decisions.md`.

Architectural decisions: ADR-0003 (trust hash v2, partly supersedes
ADR-0001) and ADR-0004 (TypeScript package, raw fetch).

## Problem Statement

Roast is installed into a project with npm, but it is a Go binary. Every
release builds six platform packages plus a launcher, runs a license
collection script per target, and needs a Go toolchain next to Node. The
maintainer works in TypeScript and wants one language, one toolchain, and
the TypeScript and npm conventions shared by their other packages. Users
see none of this directly, but they pay for it in release friction,
platform-package install quirks (`EBADPLATFORM`, forced workspaces), and a
launcher that can resolve the wrong `roast` binary.

## Solution

Rewrite Roast in TypeScript as one pure-JS npm package, `2.0.0`, that
behaves like the Go version at commit `cd08f10`: same commands, flags,
defaults, exit codes, JSON reports, run records, and security model. The
only differences are the deliberate changes listed below. Runtime
libraries are bundled into a single ESM file, so installing Roast still
adds no transitive packages to a user's project. Users upgrade by bumping
the dependency; the one visible step is approving the project config once
more (ADR-0003).

## User Stories

1. As a developer with Roast as a dev dependency, I want `npx roast
   review` to behave exactly as before, so that my workflow and scripts
   keep working after the upgrade.
2. As a developer, I want installing Roast to add no transitive packages
   to my project, so that my lockfile and audit surface stay small.
3. As a developer on macOS or Linux, I want Roast to install without
   platform-specific optional packages, so that installs never fail on
   platform checks.
4. As a developer upgrading from the Go version, I want my `.roast.json`
   and stored credentials to keep working, so that I only have to
   re-approve the config once.
5. As a developer upgrading, I want a clear message naming `npx roast
   trust` when my old approval no longer applies, so that I know the one
   step to take.
6. As a developer using the pre-commit gate, I want the installed hook to
   keep working unchanged and to fail open as before, so that commits are
   never blocked by a Roast failure.
7. As a CI maintainer, I want the same exit codes (0 clean, 1 findings, 2
   usage, 3 auth, 4 partial, 5 cancelled) and JSON output, so that my
   pipeline logic needs no change.
8. As a security-conscious user, I want ambient environment variables
   never to add credentials or headers to provider requests and redirects
   never to carry a credential to another origin, so that a key goes only
   where the trusted config says.
9. As a security-conscious user, I want the secret-file denylist to hold
   even when my environment sets `GIT_LITERAL_PATHSPECS`, so that models
   never read excluded files.
10. As a user reviewing past runs, I want run records, `runs show`, and
    `runs checkout` to keep working on records written by the new version
    in the same formats, so that review evidence stays inspectable.
11. As a user behind a corporate proxy, I want `npx roast doctor` to tell
    me when Node will ignore my `HTTPS_PROXY`, so that I can set
    `NODE_USE_ENV_PROXY=1`.
12. As a user debugging Roast, I want `DEBUG=roast:*` tracing that never
    prints prompts, bodies, headers, or keys, so that I can share the
    output safely.
13. As the maintainer, I want releases to be `npm version` plus `npm
    publish` with the same lifecycle as my other packages, so that
    releasing takes minutes.
14. As the maintainer, I want the TS code proven against the Go baseline
    by a differential harness before Go is deleted, so that parity is
    measured, not assumed.

## Implementation Decisions

### Area files

| File | Area |
| ---- | ---- |
| `spec/00-decisions.md` | Settled decisions and area-file conventions |
| `spec/01-cli.md` | CLI surface, `review` orchestration, exit codes |
| `spec/02-config.md` | Project config, built-in providers, roles |
| `spec/03-trust-credentials.md` | Trust (hash v2), stored credentials |
| `spec/04-scope.md` | Review scope: diffs, untracked, renames, caps |
| `spec/05-context.md` | Finder context, navigation tools, grounding |
| `spec/06-llm-protocols.md` | `chat`, `responses`, `anthropic` adapters |
| `spec/07-agent-loop.md` | Agent loop, token ledger, wrap-up |
| `spec/08-finder-prompts.md` | Finder stage, findings, fingerprints, prompts |
| `spec/09-verify-render.md` | Verifier, report rendering, textsafe |
| `spec/10-records.md` | Run records, bundles, `runs` / `runs show` |
| `spec/11-snapshot.md` | Snapshots, `runs checkout` / `runs prune` |
| `spec/12-gate.md` | Gate (pre-commit hook), `ignore` |
| `spec/13-login.md` | `login`, `logout`, OpenRouter PKCE |
| `spec/14-doctor-init-skill.md` | `doctor`, `init` starter, `skill` |
| `spec/15-packaging.md` | Build, tests, lint, CI, release, M0, M6 |

### Modules

One module directory per area under the source root, mirroring the Go
packages: cli, config, trust, credentials, scope, context, llm (protocol
adapters, SSE parser, agent loop, ledger), review (finder), prompts,
verify, render, textsafe, record, runbundle, snapshot, gate, skill. Two
shared modules sit below them:

- **gocompat**: Go-compatibility helpers that parity depends on --
  `isGoSpace` / `goTrimSpace` (Go `unicode.IsSpace`, which differs from JS
  `\s` and `trim`), `goExt` (Go `filepath.Ext`, which differs from Node
  `path.extname` for names like `docs/.md`), `truncateUtf8`, and
  `formatFixed2` (Go `%.2f`, which rounds exact ties to even unlike
  `toFixed`), plus the Go-style duration parser.
- **fsutil**: atomic file writes with explicit modes (trust record,
  credentials, hook files, run records).

The CLI has one entry, bundled to one file. There is no library API.

### Deliberate changes from the Go baseline

Product changes (from `spec/00-decisions.md`):

1. No `completion` command.
2. No Windows support (`os: darwin, linux`).
3. Node `>=22.18`, checked at startup with a clear error.
4. Trust hash v2 (ADR-0003); Go-era approvals are not honored.
5. `DEBUG=roast:*` tracing, never including bodies, headers, prompts, or
   credentials.
6. Version `2.0.0`.

Tightenings and fixes (resolved open questions):

7. JSON keys match exactly (case-sensitive) everywhere: `.roast.json`,
   `credentials.json`, bundle manifests, model tool arguments. JSON `null`
   still means "absent", as in Go.
8. Every HTTP redirect is refused as an endpoint error: inference requests
   and key validation alike.
9. Provider error bodies are read at most 32 KiB.
10. `grep_repo` forces `GIT_LITERAL_PATHSPECS=0` so the secret-file
    denylist cannot be disabled from the environment.
11. A run ID must be a plain name: `.`, `..`, and path separators are
    rejected.
12. `runs checkout` clears an inherited `GIT_INDEX_FILE`, and resolves a
    relative target directory against the working directory once, used
    consistently by every git call.
13. Cached tokens are subtracted once, not twice, for `chat` and
    `responses` usage.
14. A `chat` stream chunk without usage keeps the last reported usage
    instead of clearing it.
15. Diff name lists and untracked-file lists use `-z`, and diffs run with
    `core.quotePath=false`; non-ASCII paths are no longer skipped or
    misattributed.
16. The staged generated-file exclusion lists renames' deleted side too.
17. The user's `diff.orderFile` is overridden so diff order is
    deterministic.
18. The size-fit breakdown uses a stable sort.
19. A one-line hook file without a trailing newline gets one before
    Roast's block is appended.
20. `confidence_floor` values are validated to 0..1, matching the schema.
21. Anthropic tool definitions carry the full JSON schema, including
    `additionalProperties`.
22. A second Ctrl-C force-exits with status 130. Ctrl-C at a raw-mode
    secret prompt is cancellation (exit 5).
23. Unreachable Go code is not ported: branch-survey scope, the `git_diff`
    tool and the grounder's range corpus, and the test-only helpers
    `DescribeCredential`, `IsLoopbackHost`, `DescribeEndpoint`.
24. File names that are not valid UTF-8 are skipped with a warning.

### Cross-cutting rules

- **JSON encoding**: no HTML escaping of `<>&` or U+2028/U+2029. Parity is
  defined on parsed JSON, not bytes. Tool results sent to models go
  through one encoder in the llm area that sorts object keys, matching
  Go's map ordering so prompts stay stable.
- **Bytes and text**: git output is read as `Buffer`. Diff bytes stay
  `Buffer` wherever they are hashed or recorded, so digests match Go.
  Text is decoded with U+FFFD replacement only where it goes to a model or
  a report. Lone surrogates from model output become U+FFFD when the llm
  area decodes it; `textsafe` escapes any that remain as `\uNNNN`. Config
  validation rejects lone surrogates so the trust hash is always defined.
- **Config numbers**: integer fields reject non-integer lexemes (`1.0`,
  `1e3`) by checking raw token text through the JSONC parser's visitor.
- **Output strings**: em dashes in Go's user- and model-facing strings
  are kept, written as `\u2014` escapes in TS source; docs and comments
  never contain the character.
- **CLI parsing**: yargs semantics are accepted where they differ from
  cobra: decimal integers only, `--flag false` may be read as a value,
  list flags split on plain commas. A parse failure uses the parsed
  `--error-format` when available. EPIPE on stdout exits quietly with the
  computed code.
- **Process lifetime**: every tool that spawns a process kills it on
  abort, and the CLI calls `process.exit` after flushing output.
- **Runtime**: the `node:zlib` zstd ExperimentalWarning is suppressed (that
  warning only). Tar archives support PAX path records when writing and
  reading. Version, commit, and build date are injected at build time;
  running from source reports `dev`.
- **Network**: no proxy library is bundled. The README documents
  `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS`; `doctor` warns when
  `HTTPS_PROXY` is set but `NODE_USE_ENV_PROXY` is not.

### Milestones

M0 scaffold; M1 config, trust, credentials; M2 scope and context; M3
`chat` protocol, agent loop, finder, verifier, render, records -- first
working `npx roast review`; M4 `responses` and `anthropic`; M5 remaining
commands; M6 cutover (delete Go, platform packages, launcher; update
AGENTS.md; release `2.0.0`). Details in `spec/15-packaging.md`.

## Testing Decisions

- A good test drives external behavior and asserts on exit codes, JSON
  output, files written, and requests the fake server received. No
  assertions on exact human-readable text, docs, or CSS.
- **Primary seam**: the CLI run in-process (`run(argv, io)` with
  injectable stdin, stdout, stderr, env, cwd) against a `node:http` fake
  inference server speaking all three protocols, with a swappable `fetch`
  so profiles on built-in endpoints reach the fake. Prior art: Go's
  `executeContext` with `httptest`, `providerServer`,
  `redirectDefaultTransport`, `settingsRepo`, `loginRepo`.
- **Lower seams**, only where the CLI is too coarse: the token ledger,
  trust hashing (frozen test vectors), `textsafe`, the SSE parser,
  `gocompat`, and the agent loop driven by a scripted fake protocol
  adapter.
- **Swappable module functions** for terminal detection, browser opening,
  and the browser-login timeout, as in Go.
- **Gate**: a real `git commit` against a shell-stub `roast` at
  `node_modules/.bin/roast`, as in Go's hook execution tests.
- Tests that touch records, credentials, trust, or skills chdir into a
  temporary Git repository and isolate `HOME`, `XDG_CONFIG_HOME`, and
  `CLAUDE_CONFIG_DIR`, as the Go tests do.
- Go tests are ported area by area; each area file's test plan maps Go
  test names to behaviors and seams.
- A temporary differential harness builds the Go binary at `cd08f10` and
  runs both CLIs against the same fake server, comparing exit codes,
  parsed JSON, and run records, with an allowlist for the deliberate
  changes above. It runs in CI on Ubuntu from M1 to M5 and is deleted at
  M6.
- The two rendered user prompts are checked against Go output by a
  temporary differential test, deleted at M6.
- Opt-in live tests (`ROAST_LIVE_*`) are kept and never run in CI.
- The allocation-bound test for huge files becomes an RSS bound.

## Out of Scope

- Windows support.
- A programmatic library API.
- Behavior redesigns beyond the deliberate changes above; they come after
  `2.0.0`.
- Tracking or porting future upstream (`bluesky-social/roast`) changes.
- Byte-identical compressed output (`.gz`, `.tar.zst`): decompressed bytes
  must match, compressor output may differ.
- Byte-identical help text with cobra.
- Bundling a proxy agent.
- Git submodules inside snapshots (documented as unsupported).

## Further Notes

- Kept as Go does, on purpose: `null` (not `[]`) for empty `notes`,
  `matches`, and `lines`; `verified: true` with no findings; the monthly
  index keeping the oldest sighting (the Go comment is wrong, not the
  behavior); a global `core.hooksPath` affecting `gate disable`; `init`
  writing to the working directory; doctor checking only user-level skill
  installs; CLI hints saying bare `roast`; a malformed trust record
  exiting 4; author routes discarding `--finder-*` overrides; an all-zero
  finding from invalid `report_finding` JSON; index timestamps in local
  time and `meta.json` in UTC; default adaptive thinking for
  `claude-mythos-preview`.
- The headless OpenRouter login (no `callback_url`) needs a manual check
  against the live service before release.
- `jsonc-parser` must run with trailing commas allowed: the `init`
  starter writes one.
- `@substrate-system/debug` and its dependencies must pass the license
  allowlist in M0.
- The uncommitted `package.json` lists `yargs`, `zod`, `jsonc-parser`
  under `dependencies`; M0 moves them to `devDependencies`.
