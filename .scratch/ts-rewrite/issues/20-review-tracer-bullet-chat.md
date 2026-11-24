# 20: Tracer bullet: `npx roast review` end to end on `chat` with `--no-verify`

**Blocked by:** 06, 07, 08, 10, 11, 12, 14, 16, 17, 18, 19
**Touches:** `src/cli/review.ts` (`runReview`), `src/cli/review-flags.ts`
(`ReviewFlags`, `RoleFlags`, `validateReviewFlags`), `src/cli/resolve.ts`
(`configInt`, `flagOrConfig`, `flagOrConfigInt`, `flagOrConfigDuration`,
`resolveLangs`, `applyRoleFlags`), `src/cli/snapshot-meta.ts`
(`captureSnapshot`), `src/cli/log.ts` (`logf`), `src/cli/run.ts` (register
`review` and bare `$0`), `src/cli/config.ts` (`loadProjectConfig` wiring
with `withStoredCredentials`), `test/cli/review*.ts`,
`test/helpers/` (`settingsRepo`, `approveProjectConfig`,
`requestRecorder`, `reviewMeta`)
**Spec:** `spec/01-cli.md` 2.2, 2.3, 2.6, 2.7, 2.8 (steps 1-16 and
19-21), 2.11, 2.12, 2.13 (disabled branch), 2.14, 2.15, section 5;
`spec/03-trust-credentials.md` 2.8, 5.4 (review rows), 5.6 (review rows);
`spec/10-records.md` 2.3 ("Write ordering in `review`");
`spec/09-verify-render.md` 2.5, 2.6; spec.md "Cross-cutting rules"
(Process lifetime, CLI parsing) and deliberate change 22
**Status:** done

## What to build

The first working `npx roast review`. A developer with an approved
`.roast.json` whose finder profile speaks `chat` runs `npx roast review
--no-verify` (or bare `npx roast --no-verify`) in a Git repository. Roast
validates flags, loads and resolves the config, checks trust, builds the
diff scope, sends the finder conversation to the provider, writes the
JSON and Markdown report, writes a complete run record (meta, `.gz`
artifacts, `provider-responses.jsonl`, `findings.jsonl`, `result.json.gz`,
`report.md`, `bundle.tar.zst`, index line), and exits 0, 1, 2, 3, 4, or 5
per the exit contract.

This ticket wires the orchestration in `spec/01-cli.md` 2.8 from flag
validation through finalization, using the modules from the blocking
tickets. It owns all `review` flags (2.6), their raw validation (2.7),
the flag -> config -> default resolution (2.14), the LLM client config
(2.15), stdout/stderr discipline (2.12), and `reviewExitError`.

Scope boundaries:

- Verification (step 17) is ticket 21. Here `doVerify` is computed and
  the verifier role is validated when `doVerify` is true (step 3), but
  step 17 is a pass-through stub. Every test in this ticket uses
  `--no-verify` or `--quick`.
- Snapshots are ticket 22. `captureSnapshot` is implemented in
  `src/cli/snapshot-meta.ts` with the capture function injected. The
  disabled branch (`review.snapshot: false`) is complete here. Until 22
  lands, the enabled branch calls a placeholder that throws, which the
  2.13 contract already turns into `captured:false` with a reason and a
  caveat, and the review continues. There is no worktree pin yet, so
  non-staged reviews read the live tree through the context area's live
  reader (the documented pin-failure fallback, without the log line).
  Tests here set `review.snapshot: false` unless they assert nothing
  about snapshots.
- The gate bootstrap offer (2.9) is ticket 30. Leave a single call site
  at the top of the review handler that does nothing yet.
- Repo survey (`--scope repo`) is ticket 25. Flag validation for
  `--scope` (2.7 items 9-11) lands here; a survey run may fail with a
  usage error until 25.
- `responses` and `anthropic` end-to-end tests are tickets 27 and 28;
  this ticket needs only `chat`.

Seam resolutions that apply: the Go duration parser and formatter come
from `gocompat` (ticket 03); terminal helpers come from
`src/cli/terminal.ts`; `StoredCredentials.lookup` is synchronous; the
LLM client is the area 06 `send` adapter used through the agent loop.

Two deferred checks from the trust and credentials tickets land here,
because they need a real review: an untrusted config fails closed before
any request, and a stored credential reaches the provider through a
review.

## Acceptance criteria

Flags and validation:

- [x] Each 2.7 rule (for example `--staged --uncommitted-only`,
  `--format bogus`, `--max-turns 0`, `--max-attempts=0`,
  `--request-timeout=-1s`, `--max-tokens-total=-1`,
  `--max-verified=-1`, `--scope bogus`, `--scope repo --quick`,
  `--max-severity bogus`) exits 2 with category `usage` and the fake
  server receives zero requests, even when the config sets the matching
  `limits` key.
- [x] `--finder-max-output-tokens=0` with `--quick --uncommitted-only`
  exits 2, category `usage`.
- [x] `--error-format json --format invalid` exits 2 and stderr parses as
  JSON with `error_category: "usage"` and `exit_code: 2`.
- [x] `--paths a,b --paths c` reaches scope as three pathspecs;
  `--max-attempts 0x10` exits 2; `--quick false` is read as false.
- [x] An empty diff exits 0 with `assessment: "NO_DIFF"` in the stdout
  JSON, writes no run directory, sends no request, and still exits 0
  with an invalid `--mode` or `--lang` and with `--max-severity INFO`.
- [x] Invalid `--mode` or an unknown or mixed-with-`none` `--lang` on a
  non-empty diff exits 2 with zero requests.

Config, roles, trust:

- [x] A JSONC config with comments is used; the nearest `.roast.json`
  below the Git toplevel wins; `--config` overrides discovery; an
  invalid config exits 2; a missing config exits 2 (message names
  `npx roast init`); the user config directory is never read.
- [x] Prompt override paths resolve against the config file's
  directory, including when run from a subdirectory.
- [x] `review --config <file>` outside a Git repository exits 2; bare
  `roast` outside Git exits 0 with help on stdout.
- [x] An untrusted config exits 2, sends zero requests, and writes no
  trust record; a legacy (Go-era) trust record exits 2 with zero
  requests; a malformed trust record exits 4 with zero requests.
- [x] A built-in-only config (built-in endpoint, standard key variable)
  reviews without any trust state being written.
- [x] With simulated terminals, answering `y` to the inline trust prompt
  approves, writes the record, and the review proceeds; declining (`""`,
  `n`, `no`, `yy`) exits 2 with zero requests and no record. Without
  terminals the review never reads stdin.
- [x] A project-scope stored key reaches a profile on the OpenAI
  built-in endpoint with `protocol: chat` (served by the fake through
  the swappable `fetch`); env beats project beats user scope; a stored
  key never reaches a custom endpoint or follows `--finder-base-url`.
- [x] A credentials file others can read (either scope) fails the review
  with zero requests.
- [x] No copy of the API key appears in stdout, stderr, or any file in
  the run directory.
- [x] `--author-model` flips the finder per the config's author routes;
  `ROAST_AUTHOR_MODEL` and the other removed variables in 2.6 change
  nothing (budgets keep defaults, no request to env-named endpoints).
- [x] A changed `--finder-base-url` withholds the ambient provider key.

Pipeline and records:

- [x] A `--no-verify --format json` review against the fake `chat` server
  exits 0 with no findings and 1 with `--max-severity HIGH` when the
  finder reports a HIGH finding; stdout is one JSON line with the
  finding.
- [x] The run directory under `<toplevel>/.roast/runs/<run-id>/` holds
  `meta.json`, the four `.gz` init artifacts, `provider-responses.jsonl`
  (one line per finder model call), `result.json.gz`, `report.md`, and a
  `bundle.tar.zst` that verifies; the monthly index gains one line.
- [x] Records land under the Git toplevel when cwd and the config are in
  subdirectories.
- [x] `meta.json` budgets record `deadline_duration`, `request_timeout`
  as Go duration strings, `max_total_tokens`, `verifier_cap`,
  `max_attempts`, `max_turns`, `max_prompt_bytes`, and
  `ledger_committed_tokens` when the ledger limit is above 0; with all
  budget flags at 0 and `--max-attempts=1` they read `"0s"`, `"0s"`, 0,
  0, 1.
- [x] The finder role meta records profile, protocol, session header,
  and model; the session header is sent only by the profile that
  configures it.
- [x] Config `limits` appear in budgets and derived meta; flags override
  them for one invocation only, including `--finder-model`.
- [x] `limits.max_diff_bytes` truncates the diff the fake receives and
  the JSON report carries `diff_truncated`; `limits.max_prompt_bytes`
  too small exits 2 with zero requests and no run directory.
- [x] A small diff downgrades `--interactive` to one structured call;
  zero interactive thresholds keep the interactive tool loop.
- [x] `review.snapshot: false` records `snapshot.captured: false` with
  the disabled reason and caveat, and creates no `refs/roast/` refs.
- [x] `--format markdown` writes nothing to stdout; `--format json`
  writes no Markdown to stderr.
- [x] A finder result that is incomplete exits 4 after the report and
  run record are written.

Errors and cancellation:

- [x] A provider 401 exits 3 (category `auth`); a provider 500 after
  retries exits 4 (category `endpoint`); in both cases the run directory
  stays initialized without `result.json.gz`.
- [x] Aborting `io.signal` during the finder exits 5 with category
  `cancelled`.
- [x] Spawning `dist/cli.js` against a fake that never answers: one
  SIGINT exits 5; two SIGINTs exit 130; no child process remains
  (skip if ticket 04 already covers this against a review).
- [x] A run-record finalize failure exits 4 even when `--max-severity`
  would have exited 1 (unit on `reviewExitError`).

- [x] Unit: `resolveLangs`, the `flagOrConfig` variants, and the
  `captureSnapshot` disabled branch behave per 2.8 step 11, 2.14, 2.13.
- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
