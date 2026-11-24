# 26: Differential harness M3 review scenarios

**Blocked by:** 09, 21, 22
**Touches:** `test/diff/` (scenario modules, request grouping, run-record
comparison, bundle comparison, allowlist entries), reuse of the fake
inference server and `writeInferenceStream` from ticket 13's test helpers
(no second fake)
**Spec:** `spec/15-packaging.md` 2.13 (per-scenario steps 1-6, M3
scenario list), 5.6; `spec/10-records.md` section 5 "Differential
harness" paragraph; spec.md "Testing Decisions" (harness) and the full
"Deliberate changes from the Go baseline" list (the allowlist)
**Status:** done

## What to build

The harness from ticket 09 proves `npx roast review` parity with the Go
baseline (`cd08f10`) on the `chat` protocol. Each scenario starts one fake
inference server whose responses are scripted per scenario and selected by
request content (model name plus number of conversation turns), never by
arrival order. It builds two identical fixture repositories (fixed file
contents, identity, and `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, so
commit IDs match), writes the same `.roast.json` into both with profiles
on the fake's URL and credentials via `api_key_env`, approves each with
its own `trust --yes`, and runs `node dist/cli.js` and the Go binary with
the scrubbed environment from 2.13 step 4.

Scenarios (all on `chat`, finder plus verifier unless noted):

1. clean review (no findings);
2. review with findings, confirmed by the verifier;
3. `--format json` output;
4. `--staged` review;
5. `--max-severity` tripping exit 1, and not tripping;
6. a failing provider (HTTP 500 after retries, and a 401).

Comparisons per 2.13 step 5: exact exit code; parsed JSON stdout when the
scenario requests JSON; requests grouped by (model, turn count) with
method, path, parsed JSON body, header names, and values only for
`Content-Type` and the auth scheme (this covers the rendered
`finder_user` and `verifier_user` prompts); and run records: the set of
relative paths in the run directory, every JSON/JSONL file parsed and
deep-equal (index lines and `findings.jsonl` ignoring `ts`), `.gz`
artifacts decompressed and compared, raw response captures byte-equal,
and the bundle compared as decompressed tar entries (name, mode, size,
content) plus the manifest, never compressed bytes.

Normalization replaces run IDs, timestamps, durations, the fixture
repository path, `roast.version` / `roast.commit`, the `User-Agent`
value, session header values, and digests that include run IDs. Decision
taken here: snapshot `commit` and `ref` OIDs differ by design because the
commit message carries the run ID, so they are normalized; `index_tree`,
`worktree_tree`, `base_tree`, `head`, and `base` are compared exactly.
Stderr, rendered Markdown, help text, trust messages, `trust.json`, and
debug output are never compared.

A scenario that differs because the Go behavior was judged wrong is
recorded in the owning area file's "Open questions", not patched in the
harness. Differences outside the allowlist fail the job. `responses` and
`anthropic` scenarios are added by tickets 27 and 28; `runs` and `init`
scenarios by ticket 36.

## Acceptance criteria

- [x] `npm run test:diff` runs the six scenarios above against both CLIs
  and passes on Ubuntu with Go installed.
- [x] Without `go` on `PATH`, every scenario prints a TAP skip and the
  run exits 0.
- [x] Responses are selected by (model, turn count): reordering verifier
  completions in the fake does not change the result.
- [x] Injecting a one-field difference into the TS side's `meta.json`
  (for example a changed budget value, via a test-only fixture) makes
  the comparison fail and name the file and JSON path.
- [x] Injecting a different request body field on one side makes the
  request comparison fail and name the (model, turn count) group.
- [x] Bundle comparison reads decompressed tar entries, so two bundles
  with identical entries but different zstd bytes compare equal.
- [x] The CI differential job runs these scenarios on Ubuntu after
  `npm run build`.
- [x] Every allowlist entry used by a scenario cites the spec.md
  deliberate change number it relies on.

- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
