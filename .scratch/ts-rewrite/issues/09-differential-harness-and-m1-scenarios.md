# 09: Go-vs-TS differential harness skeleton and M1 scenarios

**Blocked by:** 07
**Touches:** `test/diff/index.ts` (entry), `test/diff/*.ts` (Go baseline
build, fixture repositories, environment scrubbing, normalization,
comparison, allowlist, scenarios), `scripts/bundle.ts` (`--diff` mode),
`package.json` (`test:diff` script), `.github/workflows/ci.yml` (new
differential job), `.gitignore` if needed
**Spec:** `spec/15-packaging.md` 2.13, 2.14 item 1 (`test:diff`), 5.6;
spec.md "Testing Decisions" (differential harness), "Deliberate changes
from the Go baseline" (the allowlist); `spec/02-config.md` 2.3, 2.4
(config error conditions); `spec/12-gate.md` 2.10 (`gate settings`)
**Status:** done

## What to build

A temporary harness that proves parity on observable output by running
the baseline Go CLI (commit `cd08f10`) and the TS CLI (`node
dist/cli.js`, spawned as a process) on identical inputs and comparing
results. It is deleted at M6 (ticket 37), so keep it self-contained under
`test/diff/`; `test/index.ts` never imports it.

`npm run test:diff` runs `npm run bundle && node scripts/bundle.ts --diff
&& node test/diff-bundle.js`. Building the Go baseline follows 2.13:
reuse `node_modules/.cache/roast-diff/roast-go-cd08f10` if present, else
`git worktree add --detach` at `cd08f10`, `go build -trimpath` with the
`buildinfo.Version=baseline` ldflag, `CGO_ENABLED=0` and `GOFLAGS`
removed, and `git worktree remove --force` also on failure. Without `go`
on `PATH` every scenario is a TAP skip and the run exits 0.

Per scenario: two fixture repositories built by the same function with
fixed contents, fixed author/committer dates and identity (commit IDs
match); the same `.roast.json` in both; each CLI approves its own copy
with `trust --yes` where the scenario needs a trusted config (trust hashes
differ by design); each CLI runs with a scrubbed environment (no
`ROAST_*`, `OPENAI_*`, `OPENROUTER_*`, `ANTHROPIC_*`, `DEBUG`; private
`HOME` and `XDG_CONFIG_HOME`). Compare the exit code exactly and stdout
when the scenario declares a structured stdout (JSON parsed and deep
equal; `gate settings` `key=value` lines parsed into a map). Stderr,
help text, rendered Markdown, trust messages, `trust.json`, and debug
output are never compared.

Build the comparison layer for the later milestones now so tickets 26,
27, 28, and 36 only add scenarios: the normalizer (run IDs, timestamps,
durations, fixture repository path, `roast.version` / `roast.commit`,
`User-Agent`, session header values replaced by placeholders), run-record
comparison (relative path set, JSON and JSONL parsed and deep equal, raw
response captures byte equal, bundles compared as decompressed tar
entries), request comparison grouped by (model, turn count), and the
allowlist of spec.md's deliberate changes. A scenario hook for starting a
fake inference server is enough here; the fake itself comes from ticket
13's test helpers, and the review scenarios from ticket 26. A scenario
that fails because Go behavior was judged wrong is recorded in the owning
area file's Open questions, never patched in the harness.

M1 scenarios, all through `gate settings` and `trust --yes` (the only
config-reading commands at this point):

- valid configs: defaults only, a `gate` section with custom
  `timeout_seconds` and lower-case `severity`, JSONC with comments and a
  trailing comma, config in a subdirectory vs at the toplevel;
- invalid configs: missing `version`, `version: 2`, unknown top-level and
  nested field, wrong JSON type, a literal `api_key`, malformed JSONC and
  trailing content, an invalid duration string, out-of-range gate values,
  a non-integer lexeme (`1.0`) in an integer field, an unknown role name;
- missing config, and `--config` pointing at a file that does not exist.

CI: add a job to `ci.yml`, Ubuntu only, that sets up Node 22 and Go,
installs, then runs `npm run bundle` and `npm run test:diff`. Any
difference outside the allowlist fails the job.

## Acceptance criteria

- [x] `npm run test:diff` builds the Go baseline once and reuses the
      cached binary on the next run (the second run performs no
      `go build`).
- [x] The temporary worktree is removed after a successful and after a
      failing Go build.
- [x] With `go` absent from `PATH`, every scenario is reported as a TAP
      skip and the command exits 0.
- [x] Every M1 scenario listed above passes: same exit code from both
      CLIs, and the same parsed `gate settings` values where it succeeds.
- [x] A deliberately injected difference (for example a scenario run
      against a TS stub that exits with another code) fails the harness,
      proving it detects divergence.
- [x] Normalization makes two runs of the same CLI on the same scenario
      compare equal (run IDs, timestamps, and paths replaced).
- [x] The CI differential job runs on Ubuntu and fails on a
      non-allowlisted difference.
- [x] `npm run lint`, `npm run typecheck`, `npm run test:ts` pass;
      `go test ./...` still passes.
