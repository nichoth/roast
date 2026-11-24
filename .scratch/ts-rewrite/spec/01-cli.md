# Area 01: CLI surface and review orchestration

## 1. Purpose

This area is the `roast` executable's front door. It owns:

- the command tree (root command, `review`, and the registration of every
  other subcommand, whose behavior other areas specify);
- every `review` flag, its type, default, and validation;
- how a setting is resolved from flag, then project config, then default;
- the global `--error-format text|json` flag, the JSON error shape, error
  categories, and the exit code contract;
- `--version` and build metadata;
- the review pipeline's orchestration: load the project config, resolve the
  finder and verifier roles, check that the config is a trusted project
  config, build the scope, pin and snapshot the reviewed corpus, build
  prompts, open the run record, run the finder, run the verifier, render,
  finalize the run record, and pick the exit code;
- stdout/stderr discipline and cancellation on SIGINT/SIGTERM;
- the shared terminal helpers (yes/no prompt, secret input, terminal
  detection, browser opening) used by trust, login, init, and gate;
- the in-process `run(argv, io)` test seam and shared test fixtures
  (ambient environment clearing, SSE stream fixtures).

Areas referenced by name and not re-specified here: **config** (project
config load/find, role resolution, finder flip, endpoint override,
credentials resolution), **trust** (`requireTrust`, trust prompt),
**credentials** (stored credentials store), **scope** (Git root, diff,
manifest, fit/truncation, notes), **context** (pinned trees, file context,
quote grounder, exploration tools, numbered snippets), **prompts** (system
and user prompt rendering), **llm** (clients, ledger, error kinds, raw
response capture), **finder** (`review.Find`, severity, mode and language
classification), **verifier** (`verify.Verify`), **render** (JSON and
Markdown report, text sanitization `textsafe`), **records** (run IDs, run
directory, meta, artifacts, index, seen-before, run bundle), **snapshot**
(worktree pin, snapshot capture/delete), **gate** (bootstrap offer, hook),
**login**, **doctor/init/skill/ignore/trust/runs** commands, **packaging**.

## 2. Behavior contract

### 2.1 Process entry

- The process runs the CLI with `argv = process.argv.slice(2)`, real
  stdin/stdout/stderr, the process environment and working directory, and
  an abort signal that fires on the first SIGINT or SIGTERM.
- At startup, before anything else, the entry checks the Node version. Below
  22.18 it writes a clear one-line error to stderr naming the required and
  the running version and exits 2, without loading the rest of the CLI
  (deliberate change 3, spec.md).
- After the command finishes, if it returned an error, the error is written
  to stderr (section 2.4) and the process exits with the computed code.
- Signal handlers stay installed for the life of the process. The first
  SIGINT or SIGTERM aborts the signal and lets the command wind down. A
  second SIGINT or SIGTERM force-exits immediately with status 130. This
  replaces Go, where repeat signals were ignored (deliberate change 22,
  spec.md).
- Ctrl-C at a raw-mode secret prompt arrives as the byte `\x03`, not as a
  signal. It is treated as cancellation (exit 5), not as input.
- Every tool that spawns a process (git, `open`, `xdg-open`) kills it when
  the abort signal fires, and the entry calls `process.exit` after flushing
  stdout and stderr, so no child or handle keeps the process alive
  (cross-cutting rule "Process lifetime", spec.md).

### 2.2 Exit codes

| Code | Name        | When                                                  |
|------|-------------|-------------------------------------------------------|
| 0    | Clean       | Command succeeded; review had no gating finding and   |
|      |             | was not partial. Also help, `--version`, empty diff.  |
| 1    | Findings    | Review succeeded and `--max-severity` was given and   |
|      |             | some kept finding's effective severity rank is >= the |
|      |             | threshold rank. Never produced by an error.           |
| 2    | Usage       | Any `UsageError`: bad flag, unknown flag or command,  |
|      |             | positional arg where none allowed, invalid flag value |
|      |             | or combination, missing/invalid project config, role  |
|      |             | resolution/validation failure, untrusted config,      |
|      |             | not in a Git repository (explicit `review`), prompt   |
|      |             | over the byte ceiling, invalid `--mode` / `--lang`.   |
| 3    | Auth        | An error wrapping the llm area's auth error kind      |
|      |             | (provider answered 401/403).                          |
| 4    | Partial     | Any other error (endpoint failure, resource limits,   |
|      |             | Git failures, run record write failures), and a       |
|      |             | successful review that was partial (finder result     |
|      |             | incomplete, or any kept finding's verdict undecided). |
| 5    | Cancelled   | An error wrapping cancellation (the abort signal).    |

Exit code from an error (`exitCode(err)`), evaluated in order:

1. no error -> 0;
2. error chain contains cancellation -> 5;
3. error chain contains the llm auth kind -> 3;
4. error chain contains a `UsageError` -> 2;
5. otherwise -> 4.

A successful review returns a non-error "exit with code" signal (Go
`gateExit`) for codes 1 and 4; it carries no message and nothing is written
to stderr for it, in either error format.

Review exit selection after a completed run (`reviewExitError`), in order:

1. finalizing the run record failed -> that error (exit 4 normally); an
   artifact failure always wins over the severity gate;
2. `--max-severity` given and `maxSeverityRank >= thresholdRank` -> exit 1;
3. partial -> exit 4;
4. otherwise exit 0.

Severity ranks: INFO 0, LOW 1, MEDIUM 2, HIGH 3, CRITICAL 4. The result's
max severity is the highest effective severity rank (finder area defines
"effective": the verifier may recalibrate) over the kept findings
(`result.findings`, not dropped ones), or -1 when there are none. So
`--max-severity INFO` gates on any kept finding and no findings never
gate.

### 2.3 Error categories

Stable machine-readable classification `ErrorCategoryFor(code, err)`,
evaluated in order:

1. code 0 -> `none`;
2. code 1 -> `findings`;
3. chain contains cancellation -> `cancelled`;
4. chain contains llm auth -> `auth`;
5. chain contains llm endpoint -> `endpoint`;
6. chain contains llm budget-exhausted, work-deadline, or no-final-call ->
   `resource_limit`;
7. chain contains a `UsageError`, or code is 2 -> `usage`;
8. code 5 -> `cancelled`;
9. otherwise -> `partial`.

So exit 4 carries one of `endpoint`, `resource_limit`, `partial`.

### 2.4 Error output (`--error-format`)

- `--error-format` is a global (persistent) string flag, default `text`,
  accepted on every command. Allowed values: `text`, `json`. Any other
  value is a usage error `invalid --error-format "<v>" (text|json)`, raised
  before the command runs. The bad-value error itself is printed in text
  form.
- Errors always go to stderr.
- Text form: one line, `roast: <message>\n`, where `<message>` is passed
  through the render area's text sanitizer (`textsafe.Text`): control
  characters are escaped: a message containing `a`, ESC, `[2J.go`
  prints as the literal text `a\x1b[2J.go` and no ESC byte reaches the
  terminal. Errors can
  carry Git stderr naming repository paths.
- JSON form: one JSON object plus newline:

  ```json
  {"error_category":"usage","message":"invalid --format \"x\"","exit_code":2}
  ```

  Keys in this order: `error_category` (section 2.3), `message` (raw error
  message, not sanitized; JSON escaping makes it safe), `exit_code`.
  No HTML escaping: `<`, `>`, `&` and U+2028/U+2029 are written as is
  (Go's encoder escapes them). Parity is defined on parsed JSON, not bytes
  (cross-cutting rule "JSON encoding", spec.md), so `JSON.stringify` output
  is correct.
- The format used for an error is the value of `--error-format` as parsed
  when the command failed. If parsing failed and yargs produced a parsed
  `--error-format`, that value is used; otherwise `text`. An invalid parsed
  value is itself reported in text form (section above).

### 2.5 Command tree

Root command `roast`:

- Short: "Adversarial cross-model code review". Long: "A finder proposes
  potential defects, then an independent verifier adjudicates each claim
  against the local checkout." Help text need not match cobra exactly, but
  root help must describe the tool.
- Takes every `review` flag (section 2.6) and no positional arguments.
  A positional argument, including an unknown subcommand name such as
  `roast bogus` or `roast config bogus`, is a usage error (exit 2).
- `--version` / `-v` on the root only: prints `roast version <S>\n` to
  stdout and exits 0, where `<S>` is the build string (section 2.10). No
  config is read and the gate bootstrap does not run.
- `--help` / `-h` on any command prints help to stdout and exits 0 with no
  configuration, Git repository, or network needed. Help shows effective
  defaults for `--deadline` (10m, 25m with `--scope repo`, 0 disables),
  `--max-tokens-total` (3000000, 0 disables), `--max-turns` (16, 40 with
  `--scope repo`), `--request-timeout` (10m, 0 disables).
- Bare `roast` (no subcommand) behaves as `review` except: if the working
  directory is not inside a Git repository, it writes
  `roast: not in a Git repository; cd into one to review, or try
  \`roast doctor\` / \`roast --help\`\n` (one line) to stderr, prints root
  help to stdout, and exits 0. Explicit `roast review` outside a Git
  repository is an error (section 2.7).

Subcommands registered on the root (behavior in other areas): `review`,
`runs`, `gate`, `skill`, `doctor`, `ignore`, `trust`, `init`, `login`,
`logout`. Must not exist: `config`, `eval`, `install`,
`internal-update-helper`, `replay`, `completion` (dropped), `runs label`,
`runs sync`, `runs status`. Group commands with no default action (`gate`,
`skill`) print their help to stdout and exit 0 when given no subcommand,
and give a usage error (exit 2) for an unknown subcommand. Hidden
subcommand `gate settings` is part of the gate area.

Shared argument rules for every command (Go `noArgs`, `usageArgs`,
`flagUsageError`): an unknown flag, a malformed flag value, or a wrong
positional argument count is a `UsageError` (exit 2).

### 2.6 `review` flags

`roast review` and bare `roast` take the same flags. "Changed" means the
flag appeared on the command line, even with a value equal to its
default. Values parsed per section 2.11.

| Flag | Type | Default | Meaning |
|------|------|---------|---------|
| `--config` | string | `""` | project config path; empty -> discover |
| `--base` | string | `""` | diff base ref (default: scope area) |
| `--uncommitted-only` | bool | false | only uncommitted changes |
| `--staged` | bool | false | exactly the staged set |
| `--task` | string | `(not provided)` | what the builder was asked to do |
| `--format` | string | `both` | `json`, `markdown`, `both` |
| `--max-severity` | string | `""` | exit 1 threshold, case-insensitive |
| `--paths` | string slice | none | limit review to these Git pathspecs |
| `--exclude` | string slice | none | exclude these pathspecs |
| `--include-vendored` | bool | false | review vendored/generated files |
| `--mode` | string | `auto` | `code`, `prose`, `mixed`, `auto` |
| `--quick` | bool | false | single-shot finder, no verification |
| `--no-verify` | bool | false | skip verification |
| `--interactive` | bool | false | finder may navigate the checkout |
| `--max-turns` | int | 16 | max interactive finder turns |
| `--deadline` | duration | 0 (unset) | finder work deadline |
| `--request-timeout` | duration | 0 (unset) | per inference request |
| `--max-tokens-total` | int | 0 (unset) | shared token ceiling |
| `--max-verified` | int | 25 | max findings sent to verifier |
| `--max-attempts` | int | 4 | provider/structured-output attempts |
| `--show-dropped` | bool | false | render malformed/refuted candidates |
| `--lang` | string slice | none | prompt packs; `none` disables |
| `--scope` | string | `diff` | `diff` or `repo` (survey triage) |
| `--author-model` | string | `""` | author model or family |
| `--finder-base-url` | string | `""` | finder endpoint override |
| `--finder-model` | string | `""` | finder model override |
| `--finder-protocol` | string | `""` | `chat`, `responses`, `anthropic` |
| `--finder-max-output-tokens` | int | 0 | finder output ceiling |
| `--verifier-base-url` | string | `""` | verifier endpoint override |
| `--verifier-model` | string | `""` | verifier model override |
| `--verifier-protocol` | string | `""` | verifier protocol override |
| `--verifier-max-output-tokens` | int | 0 | verifier output ceiling |

Plus global `--error-format`. Flags take values only through the command
line; no environment variable sets any of them (removed variables such as
`ROAST_FINDER_MODEL`, `ROAST_DEADLINE`, `ROAST_AUTHOR_MODEL`,
`ROAST_NO_HOOK`, `ROAST_SNAPSHOT`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`
have no effect).

### 2.7 Flag validation (before any config is read)

In this order, each a `UsageError` with the given message:

1. `--staged` and `--uncommitted-only` both set ->
   `--staged and --uncommitted-only cannot be combined`.
2. `--format` not in json/markdown/both -> `invalid --format "<v>"`.
3. `--max-turns < 1` -> `max-turns must be positive`.
4. `--deadline < 0` -> `deadline cannot be negative`.
5. `--request-timeout < 0` -> `request-timeout cannot be negative`.
6. `--max-tokens-total < 0` -> `max-tokens-total cannot be negative`.
7. `--max-verified < 0` -> `max-verified cannot be negative`.
8. `--max-attempts < 1` -> `max-attempts must be positive`.
9. `--scope` not diff/repo -> `invalid --scope "<v>" (diff|repo)`.
10. survey (`--scope repo`) with `--quick` ->
    `--quick cannot run a repository survey; drop --quick`.
11. survey with `--staged`, `--uncommitted-only`, or non-empty `--base` ->
    `--scope repo cannot be combined with --staged, --uncommitted-only, or
    --base`.
12. `--max-severity` non-empty and not (after upper-casing and trimming)
    one of INFO, LOW, MEDIUM, HIGH, CRITICAL ->
    `invalid --max-severity "<v>"`. Valid -> threshold rank; absent ->
    no gate (rank -1).

These validate the raw flag values, so `--max-attempts=0` is a usage error
even when the config sets `limits.max_attempts`. `--mode` and `--lang` are
validated later (section 2.8 step 10), after the empty-diff exit. An empty
diff therefore exits 0 even with an invalid `--mode` or `--lang`; this is
kept for Go parity.

### 2.8 Review orchestration

The gate bootstrap (section 2.9) runs first, before flag validation, for
bare `roast` and `review` only. Then, in order:

1. **Flag validation** (section 2.7).
2. **Project config.** `loadProjectConfig(--config)`: path is `--config`
   as given (relative to cwd) when non-empty; otherwise config area `Find`
   from cwd upward, stopping at the Git toplevel of cwd, or at cwd itself
   when cwd is not in a repository. No file found -> `UsageError`
   `no project config (.roast.json) found between here and the Git
   toplevel; run \`npx roast init\` to create one`. Find or load failure
   -> `UsageError` with the config area's message. The loaded config gets
   the stored credentials store for the repository containing cwd
   (project scope) and the user (credentials area), read lazily.
3. **Roles.** `ResolveRole("finder")`, `ResolveRole("verifier")`; then
   apply role flags to each (`applyRoleFlags`): if `--<role>-base-url` or
   `--<role>-protocol` changed, call config's `OverrideEndpoint(role,
   resolved, baseURL|undefined, protocol|undefined)` (passing only the
   changed ones); then if `--<role>-model` changed set the model; if
   `--<role>-max-output-tokens` changed set it. Then the finder flip:
   `ResolveFinderFlip(finderRole, --author-model)`; if it returns a note,
   log it; if it returns a warning, log it; the finder role becomes the
   flip's role. Then `ValidateRole("finder", ...)`, and
   `ValidateRole("verifier", ...)` only when verification will run
   (`doVerify = !quick && !noVerify`). Every failure in this step is a
   `UsageError` carrying the config area's message (for example
   `--finder-max-output-tokens=0` fails validation).
4. **Git root.** `GitRoot(cwd)`; failure -> `UsageError`
   `not inside a git repository`. (So `review --config <path>` outside a
   repository fails here with exit 2.)
5. **Trust.** trust area `requireTrust(repo, cfg, stdin, stderr)`; its
   error is returned as-is (usage error when untrusted). Nothing is sent
   anywhere before this passes.
6. **Scope inputs.** `excludes = cfg.review.excludes ++ --exclude`.
   Defaults depend on `--quick`: max diff bytes 1_000_000 (quick 200_000),
   max file context bytes 400_000 (quick 100_000). `maxDiff =
   limits.max_diff_bytes ?? default`. Build options: base, uncommitted
   only, staged only, paths, excludes, include vendored, scope kind,
   `maxFileDiffBytes = maxDiff`.
7. **Staged pin.** With `--staged`: context area `PinIndexTree(repo)`
   gives the tree used for all reads; failure -> error
   `pin staged tree: <inner>` (exit 4). Its OID is passed to scope build
   as the staged tree OID.
8. **Build scope.** scope area `Build(repo, opts)`; error returned as-is.
   Each scope note is logged.
9. **Empty scope.** If the scope is empty (survey: no files; otherwise the
   diff is blank after trimming whitespace), write a report (section
   2.12) with assessment `NO_DIFF`, empty findings, dropped, notes, files
   reviewed, mode `code`, and the task; create no run record, no
   snapshot, send no request; exit 0 regardless of `--max-severity`.
10. **Corpus pinning and snapshot.**
    - `runID = records.NewRunID()`.
    - Reviewed input: the diff, or for a survey the manifest
      (`inputKind` is `diff` or `manifest`).
    - Unless the scope is staged: snapshot area `PinWorktree(repo)`;
      success -> reads use the pinned worktree tree; failure -> log
      `could not pin the working tree (<err>); reading it live with .git,
      ignored, and denylisted paths blocked` and read live.
    - `captureSnapshot` (section 2.13). If a snapshot was captured, it is
      deleted on any exit before the run record is initialized (step 15).
11. **Grounding, fit, mode, langs.**
    - Quote grounder over (repo, tree, diff) -- context area.
    - `originalDiffBytes` = UTF-8 byte length of the diff before fitting.
    - `maxFileContext = limits.max_file_ctx_bytes ?? default`.
    - scope area `Fit(scope, maxDiff)` truncates the diff in place and
      returns the size breakdown; non-empty breakdown means truncated.
    - Mode: `--mode auto` -> finder area `ClassifyMode(files)`; then the
      mode must be code/prose/mixed else `UsageError`
      `invalid --mode "<flag value>"`.
    - Langs (`resolveLangs`): prose -> `[]`; no `--lang` -> finder area
      `ClassifyLangs(files)`; any value `none` -> must be the only value
      (else `UsageError` `--lang none cannot be combined with another
      language pack`), result `[]`; each value must be one of `go`,
      `react`, `frontend`, `web` (else `UsageError`
      `unknown language pack "<v>"`); result is the flag values in order.
12. **Prompts.** Finder override path: `prompts.finder_prose` when mode is
    prose, else `prompts.finder_code`, resolved via `cfg.PromptPath`.
    System prompt: prompts area `Finder(mode, scopeKind, quick, langs,
    overridePath)`. Verifier system: `Verifier(cfg.PromptPath(
    prompts.verifier))`. Errors returned as-is (exit 4). Finder user
    prompt: survey -> `FinderUser({task, survey:true, manifest})`; else
    `FinderUser({task, diff, fileContext})` with context area
    `BuildFileContext(repo, files, maxFileContext, tree)`.
13. **Budgets** (flag -> config -> default, section 2.14):
    - `maxTokensTotal`: `--max-tokens-total`, `limits.max_total_tokens`,
      3_000_000. 0 disables.
    - `maxVerified`: `--max-verified`, `limits.max_verified`, 25.
      0 disables the cap.
    - `requestTimeout`: `--request-timeout`, `limits.request_timeout`,
      10m. 0 disables.
    - `maxAttempts`: `--max-attempts`, `limits.max_attempts`, 4.
    - Ledger: llm area ledger with limit `maxTokensTotal`, shared by both
      roles.
    - `interactive = --interactive && !quick`; `maxTurns = --max-turns`.
      Survey forces `interactive = true` and, when `--max-turns` was not
      changed, `maxTurns = 40`.
    - Small-diff downgrade (interactive and not survey): `minLines =
      interactive.min_diff_lines ?? 80`, `minFiles = interactive.min_files
      ?? 4`; if (count of `\n` in the fitted diff) < minLines AND (number
      of scope files) < minFiles, log `diff is small; using a single
      structured finder call` and set `interactive = false`.
    - `deadline`: `--deadline`, `limits.deadline`, default 10m (25m for a
      survey). If > 0, the finder's absolute deadline is now + duration;
      0 means none. It bounds the finder only.
    - `budgets` object (shared by reference with the report and the run
      meta; key order irrelevant): `deadline_duration` and
      `request_timeout` as Go duration strings (section 2.11),
      `max_total_tokens`, `verifier_cap` (= maxVerified), `max_turns`,
      `max_attempts`, `max_prompt_bytes`; after the review,
      `ledger_committed_tokens` when the ledger limit > 0.
    - Finder tools: context area `ExplorationTools(repo, tree)` when
      interactive, else none.
    - Confidence floor: `review.quick_confidence_floor` when quick, else
      `review.confidence_floor` (config area owns defaults).
14. **Prompt ceiling.** `promptCeiling = limits.max_prompt_bytes ??
    8_000_000`. If UTF-8 bytes of finder system + finder user >
    ceiling: `UsageError` `finder prompt is <n> bytes, over the <c>-byte
    ceiling; narrow the review scope or adjust limits.max_diff_bytes,
    limits.max_file_ctx_bytes, or limits.max_prompt_bytes in the project
    config`. No request is sent and the snapshot is deleted.
15. **Run record init.** Build meta (records area owns the shape):
    run ID, UTC timestamp (RFC 3339 with nanoseconds in Go; see records
    area), repo, argv (the argv given to `run`, without the program
    name), roast `{version, commit}`, scope meta (kind, base, uncommitted
    only, staged only, include vendored, paths, excludes, base OID,
    merge-base OID, head OID, survey, staged, files), derived meta (mode,
    langs, quick, interactive, max turns, confidence floor, do verify,
    task, max severity as typed, max diff bytes, max file ctx bytes),
    roles meta for `finder` and `verifier` (profile, base URL, model,
    protocol, max output tokens, session header, digest of that role's
    system prompt), snapshot meta, digests (input kind, digest and byte
    length of the reviewed input, digests of system and user prompts),
    budgets, env names only (records `CaptureEnv` over
    `cfg.CredentialEnvNames()`), caveats from the snapshot. Scope base and
    head OIDs fall back to the snapshot meta's base/head when the scope
    has none. Then write meta (required) and the artifacts `input`,
    `finder_system`, `finder_user`, `verifier_system` (required). Any
    failure: remove the run directory and return
    `initialize run record: <e>` or `initialize run artifact <name>: <e>`
    (exit 4; the snapshot is deleted). After success the snapshot is
    durable and is kept on every later exit.
16. **Finder.** Response recorder for the run (records area) appends every
    raw provider response (role, protocol, model, content type, body).
    Create the finder client (section 2.15); error returned. Log
    `finder=<model> profile=<profile> protocol=<protocol>
    endpoint=<base URL>`. Call finder area `Find(signal, client, {system,
    user, quick, confidenceFloor, interactive, tools, maxTurns, ground,
    deadline, survey, capture: records finding spill for runID})`. An
    error is returned (exit per section 2.2; the run directory stays as
    initialized, unfinalized).
17. **Verifier.** `usage = {finder: finderClient.usage()}`. `partial =
    result.incomplete`. When `doVerify` and the result has at least one
    finding: create the verifier client (error returned); log
    `verifying <n> finding(s) with <model> (profile=<p> protocol=<p>)`;
    `result = Verify(signal, client, result, {systemPrompt:
    verifierSystem, userPrompt(finding), tools: ExplorationTools(repo,
    tree) (always), maxTurns: 8, maxVerified, ledger, log})`. The verifier
    `log` callback writes each message plus newline to stderr verbatim
    (no `roast: ` prefix, no sanitizing). Then `usage.verifier =
    verifierClient.usage()`, and `partial` becomes true if any kept
    finding has an undecided verdict. Verifier user prompt per finding:
    prompts area `VerifierUser({severity, confidence, file, lines,
    description, codeQuote, fixedCode, fileSnippet})` where `lines` is
    `?` for none, `N` for one, `first-last` for more, and `fileSnippet`
    is context area `NumberedSnippet(repo, file, 60_000, tree)`.
18. **Survey completion** (survey only): `reviewKind = survey_triage`. If
    the result is incomplete or its stop reason is `deadline`,
    `token_budget`, or `budget_exhausted`: `completion = partial`,
    `stopReason` = the result's stop reason or
    `incomplete_no_submission` when empty. Otherwise `completion =
    complete`, `stopReason = converged`, and assessment `NO_FINDINGS`
    becomes `NO_FINDINGS_IN_SAMPLED_AREAS`.
19. **Report.** Render area report fields: result, mode, files reviewed,
    task, run ID, budgets, quick, verified (= doVerify), diff truncated,
    original diff bytes, size breakdown (path, bytes), usage, prompt packs
    (langs), review kind, completion, manifest file count (= files
    length), stop reason. Add `ledger_committed_tokens` to budgets when
    the ledger limit > 0. Prior notes: records area `SeenBefore(repo,
    findings, 3)`; for each fingerprint, `seen previously in run <runTS>`
    plus ` (dropped: <reason>)` when it had a drop reason; omitted when
    none. Write the report (section 2.12).
20. **Finalize.** Set meta usage (per role: uncached input, cached input,
    cache write, output tokens, calls) and budgets. Then, each required:
    write `result.json` artifact (render JSON), write report Markdown
    (render Markdown with dropped shown, regardless of `--show-dropped`),
    rewrite meta, resolve run dir, build the run bundle (records area),
    append the run index (records `Record(report, repo, argv)`, best
    effort). Errors: `finalize run result: <e>`, `finalize run report:
    <e>`, `finalize run metadata: <e>`, `resolve run bundle directory:
    <e>`, `build local run bundle: <e>`. On success log
    `run <runID> · report <path>` (U+00B7 middle dot) if the report path
    resolves.
21. **Exit** per `reviewExitError` (section 2.2).

Cancellation behavior that follows from the above (baseline, not a
design choice): cancellation during the finder returns a cancellation
error -> exit 5, run directory left initialized. Cancellation during
verification makes each remaining verdict undecided (verifier area does
not propagate the error), so the report and run record are still written
and the exit is 4. Cancellation before the finder starts surfaces from the
first operation that observes the signal.

### 2.9 Gate bootstrap offer

Runs before the command action for bare `roast` and `review` only, and
only when `--error-format` is not `json`. Silent no-op when: cwd is not in
a Git repository; there is no `.roast.json` at the Git toplevel itself
(`gateConfigPath(repo)` = config `Find(repo, repo)`); or that config fails
to load. Otherwise call gate area `Bootstrap({repo, out: stderr, noOffer:
!cfg.gate.offers(), prompt})` where `gate.offers()` is `gate.offer`
unset or true, and `prompt` (yes/no via section 2.16) is provided only
when stdin and stderr are both terminals. A bootstrap error is logged as
`roast: pre-commit gate setup skipped: <err>` and never fails the
command. `ROAST_NO_HOOK` has no effect.

### 2.10 Version and build info

Build values: `version` (package version), `commit` (short 7-char Git
commit), `date` (committer date, ISO 8601 strict, `git log -1
--format=%cI`), all injected at build time. Running from source (no
injection) reports `dev`, `unknown`, `unknown`. Build
string: if version is `dev` or date is `unknown` -> `<version> (commit
<commit>)`, else `<version> (<commit>, <date>)`. Run meta records
`{version, commit}`.

### 2.11 Value syntax

- Booleans: `--quick`, `--quick=true`, `--quick=false`, `--quick false`
  (also `1`, `0`,
  `t`, `f`, `TRUE`, `FALSE` as in Go `strconv.ParseBool`). There is no
  `--no-<flag>` negation; `--no-verify` is its own flag.
- Integers: decimal only, optional sign. Invalid -> usage error naming the
  flag. Go's `0x`, `0o` and `_` forms are not accepted (accepted yargs
  difference, spec.md "CLI parsing").
- Durations (Go `time.ParseDuration`): optional sign, then one or more
  `<number><unit>` with decimal fractions allowed and units `ns`, `us`,
  `µs`, `μs`, `ms`, `s`, `m`, `h`; `0` alone is valid; empty or unitless
  non-zero is invalid. Examples: `90s`, `10m`, `1h30m`, `1.5h`, `-1s`.
  Invalid -> usage error. Negative parses, then fails validation.
- Duration formatting (Go `Duration.String`), used for `budgets`:
  `0s` for zero; under one second uses the largest of `ns`, `µs`, `ms`
  with fraction (`1.5ms`); otherwise `[<h>h][<m>m]<s>s` where seconds may
  have a fraction and hours/minutes appear once a larger unit is present:
  `45s`, `3m0s`, `10m0s`, `25m0s`, `1h30m0s`, `1m30.5s`.
- String slices (`--paths`, `--exclude`, `--lang`): each occurrence is
  split on plain commas (no CSV quoting, so `--paths '"a,b"'` yields
  `"a` and `b"`), results appended across occurrences:
  `--paths a,b --paths c` -> `[a, b, c]`.
- Boolean flags may consume a following `true` or `false` token, so
  `--quick false` is read as the value `false`. Go treated it as a
  positional and failed with a usage error; this is an accepted yargs
  difference.
- Scalar flags given twice: last wins.
- `--` ends flags; any positional after it is a usage error.

### 2.12 stdout/stderr discipline

- stdout: the JSON report (one line plus newline) when `--format` is
  `json` or `both`; help; `--version`; other commands' primary output.
- stderr: the Markdown report plus newline when `--format` is `markdown`
  or `both` (rendered with `showDropped = --show-dropped`); every log line;
  gate offer; trust prompt; errors.
- Log lines (`logf`) are `roast: <text>\n` with `<text>` sanitized by
  `textsafe.Text`.
- Order within one review on stderr: gate bootstrap output, finder flip
  note then warning, trust prompt/messages, scope notes, pin-failure
  note, small-diff note, `finder=...` line, finder/llm output, `verifying
  ...` line, verifier log lines, Markdown report, `run <id> · report
  <path>`.

### 2.13 Snapshot capture decision (`captureSnapshot`)

Inputs: enabled (`cfg.review.snapshotEnabled()`), repo, runID, scope,
index tree OID (staged pin OID or empty), worktree pin.

- Disabled -> meta `{reason: "disabled by review.snapshot"}`, caveats
  `["Git snapshot capture was disabled; this run cannot be replayed."]`.
- `head` = scope head OID, else snapshot `HeadOID(repo)`. `base` = scope
  base OID, else (when scope base ref non-empty) `RevOID(repo, base)`.
- snapshot area `Capture(repo, {runID, headOID, baseOID, indexTree,
  worktree: pin})`. Failure -> meta `{reason: <err>, head, base}`, caveats
  `["Git snapshot capture failed: <err>"]`.
- Success -> meta: captured true, ref, commit, index tree, worktree tree,
  head, base (from the capture result), `diffPair`: `head..index` if
  staged, else `head` if survey, else `head..worktree` if scope base ref
  empty, else `base..worktree`; `fileModes` = `regular and executable
  files plus symlinks; empty directories are not represented`;
  `excludedPaths` from the capture. `baseTree` = `TreeOID(repo, src)`
  where `src` is head for `head..index`, `head..worktree`, `head`, else
  base; omitted when `src` empty. Caveat `snapshot excluded <n>
  denylisted untracked path(s)` when n > 0.

### 2.14 Flag -> config -> default resolution

- `configInt(configured, fallback)`: configured value if set (an explicit
  0 counts as set), else fallback.
- `flagOrConfigInt(changed, flagValue, configured, fallback)`: flag value
  if the flag was changed, else `configInt`.
- `flagOrConfigDuration` likewise for durations.
- Settings with flags (flag -> config -> default): deadline,
  request timeout, max tokens total, max verified, max attempts. Settings
  with config only (config -> default): max diff bytes, max file ctx
  bytes, max prompt bytes, interactive thresholds, confidence floors,
  snapshot. `--max-turns` has no config key; survey changes its default.
- Each invocation re-resolves; flags never persist.

### 2.15 LLM client configuration

`clientConfig(roleName, role, ledger, capture, maxAttempts,
requestTimeout)`: role name, base URL with all trailing `/` removed, API
key, model, protocol, max output tokens, session header, max attempts,
request timeout, shared ledger, response capture callback. Both roles use
the same ledger, capture, attempts, and timeout.

### 2.16 Terminal helpers (shared)

- `promptYesDefault(out, reader, question)`: writes `<question> [Y/n] `;
  reads one line; on EOF with empty input -> false; answer trimmed and
  lower-cased: `""`, `y`, `yes` -> true; anything else -> false. Read
  errors other than EOF propagate.
- `interactiveTerminals(stdin, stderr)`: true only when both are real
  terminal streams (a non-TTY or non-file stream, such as a test buffer,
  is never a terminal). Swappable module-level function.
- `openBrowser(url)`: spawn `open <url>` on darwin, `xdg-open <url>`
  otherwise, detached, not awaited; returns spawn errors only. Callers
  always print the URL too. Swappable module-level function.
- `readSecret(out, stdin, lines, prompt)`: writes prompt; if stdin is a
  TTY, reads one line in raw mode without echo, then writes a newline and
  returns it trimmed; otherwise reads one line from the shared line reader
  `lines` (kept across calls so buffered input survives); EOF with no
  text -> error; result trimmed.
- One shared line reader per command invocation must serve every prompt
  in that command (AGENTS.md login note).

## 3. TypeScript module design

### 3.1 Files

```
src/cli.ts                 entry: shebang, signals, run(), exit
src/cli/run.ts             run(argv, io): yargs tree, error output
src/cli/errors.ts          UsageError, ExitSignal, exitCode, category
src/cli/review.ts          runReview orchestration (section 2.8)
src/cli/review-flags.ts    flag definitions, parsing, validation
src/cli/resolve.ts         configInt, flagOrConfigInt/Duration,
                           resolveLangs, applyRoleFlags
src/cli/snapshot-meta.ts   captureSnapshot (section 2.13)
src/cli/config.ts          projectConfigPath, gateConfigPath,
                           loadProjectConfig, errNo*Config
src/cli/gate-offer.ts      maybeBootstrapGate
src/cli/terminal.ts        promptYesDefault, interactiveTerminals,
                           openBrowser, readSecret, LineReader
src/cli/log.ts             logf (textsafe + prefix)
src/duration.ts            parseGoDuration, formatGoDuration
src/buildinfo.ts           version, commit, date, buildString()
test/cli/*.ts              tests; test/helpers/ for fixtures
```

Subcommand modules (`src/cli/runs.ts`, `gate.ts`, ...) belong to their
areas but register through the same builder API (section 3.3).

### 3.2 Run context and the test seam

```ts
export interface CliIO {
    stdin:NodeJS.ReadableStream;
    stdout:NodeJS.WritableStream;
    stderr:NodeJS.WritableStream;
    env:Readonly<Record<string, string|undefined>>;
    cwd:string;
    signal?:AbortSignal;
    fetch?:typeof globalThis.fetch;
}

export interface RunResult {
    code:number;
    error?:Error;
}

export function run (argv:string[], io:CliIO):Promise<RunResult>
```

- `run` never calls `process.exit`, never reads `process.argv`,
  `process.env`, or `process.cwd()`, and never touches the real terminal.
  It writes the error (section 2.4) to `io.stderr` itself and returns
  `{code, error}` so tests can assert on both.
- Cross-area requirement: every area reached from `run` takes `cwd`,
  `env`, `signal`, and (for network) `fetch` from a context object passed
  down, instead of process globals. `git` is run with `execFile(...,
  {cwd, env})`. Records resolve `.roast/runs` from `io.cwd`. Credentials
  read `HOME` / `XDG_CONFIG_HOME` from `io.env`.
- `fetch` defaults to `globalThis.fetch`; tests pass a wrapper that
  rewrites the URL origin to the fake server while recording the
  original host (equivalent of Go `redirectDefaultTransport`). Login's
  loopback callback client uses the real `fetch`.
- `signal` defaults to a never-aborting signal.

```ts
// src/cli.ts (entry)
const controller = new AbortController()
// onSignal: first signal aborts, second exits 130 (see below)
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
const { code } = await run(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    signal: controller.signal,
})
// flush both streams, then exit
process.exit(code)
```

The entry waits for stdout/stderr writes to flush (write callback or
`drain`) before `process.exit`, so piped JSON output is never cut off. It
always calls `process.exit`, even on success, so a lingering child or
handle cannot hold the process open. An `EPIPE` on stdout is caught by an
`error` listener on `process.stdout`: it never prints a stack trace and the
process exits quietly with the already computed exit code. A second SIGINT
or SIGTERM calls `process.exit(130)` directly:

```ts
let signalled = false
const onSignal = ():void => {
    if (signalled) process.exit(130)
    signalled = true
    controller.abort(new CancelledError())
}
```

Node version check: the first statements of `src/cli.ts` compare
`process.versions.node` with 22.18 (numeric major/minor) and, when lower,
write the error and `process.exit(2)` before any other module is imported
(dynamic `import()` of the CLI body follows the check).

Every tool that spawns a process (git runner, `openBrowser`, hook helpers)
takes `signal` and kills the child (`SIGTERM`, then `SIGKILL` after a short
grace) when it aborts.

### 3.3 Errors

```ts
export const ExitCode = {
    Clean: 0, Findings: 1, Usage: 2, Auth: 3, Partial: 4, Cancelled: 5,
} as const

export type ErrorCategory = 'none'|'findings'|'usage'|'auth'|'endpoint'|
    'resource_limit'|'partial'|'cancelled'

export class UsageError extends Error {}
export class CancelledError extends Error {}  // name 'AbortError'-aware
// Successful review asking for a non-zero exit (Go gateExit).
export class ExitSignal extends Error {
    constructor (readonly code:1|4) { super(`exit ${code}`) }
}

export function errorChainHas (
    err:unknown,
    test:(e:Error) => boolean
):boolean   // walks err, err.cause, ... (cycle-safe)

export function isCancellation (err:unknown, signal?:AbortSignal):boolean
export function exitCode (err:unknown, signal?:AbortSignal):number
export function errorCategoryFor (code:number, err:unknown):ErrorCategory
export function writeError (
    out:NodeJS.WritableStream,
    code:number,
    err:Error,
    format:'text'|'json'
):void
```

- Wrapping preserves Go message concatenation: `new Error(\`pin staged
  tree: ${inner.message}\`, {cause: inner})`. Category/exit detection
  walks `cause`.
- llm area exports its error kinds (auth, endpoint, budget exhausted,
  work deadline, no final call) as classes or a tagged `kind` property;
  `errorCategoryFor` imports them.
- Cancellation: an error in the chain that is a `CancelledError`, or an
  `AbortError` raised while `io.signal` is aborted with a
  `CancelledError` reason. A `TimeoutError` from `AbortSignal.timeout`
  is never cancellation (Go `DeadlineExceeded` is not `Canceled`).

### 3.4 yargs setup

```ts
yargs(argv)
    .scriptName('roast')
    .locale('en')
    .detectLocale(false)   // English only, whatever LANG/LC_ALL say
    .parserConfiguration({
        'boolean-negation': false,   // --no-verify is a real flag
        'camel-case-expansion': false,
        'dot-notation': false,
        'parse-numbers': false,      // ints parsed by our helper
        'parse-positional-numbers': false,
        'duplicate-arguments-array': false, // scalar: last wins
        'strip-aliased': true,
    })
    .strict()
    .exitProcess(false)
    .fail((msg, err) => { throw err ?? new UsageError(msg) })
    .option('error-format', { type: 'string', default: 'text',
        global: true })
    .version(false)          // custom root-only --version / -v
    .help('help').alias('help', 'h')
    .command(['review', '$0'], ..., reviewBuilder, reviewHandler)
    .command(runsCommand) // ... other areas
```

- Output capture: parse with the callback form so yargs returns help and
  error text instead of printing; `run` writes help to `io.stdout`.
- Root-only `--version`/`-v`: handled in `run` before command dispatch
  when it is a root-level flag (no subcommand token precedes it); on a
  subcommand it is an unknown flag.
- Bare vs explicit review: the handler checks whether the first
  positional token was `review`; only bare `roast` gets the
  not-in-a-Git-repository help path (section 2.5).
- "Changed" detection: review flags with a meaningful "changed" state
  (`max-turns`, `deadline`, `request-timeout`, `max-tokens-total`,
  `max-verified`, `max-attempts`, all `--<role>-*` flags) are declared
  without a yargs `default`; `undefined` means not changed and the
  documented default is applied in `review-flags.ts`. Help text states
  the defaults in the description.
- All int and duration flags are declared `type: 'string'` and parsed by
  `parseIntFlag` / `parseGoDuration`; failures are `UsageError`.
- Slice flags are declared `type: 'string', array: true` and each element
  is split on plain commas; a test pins `--paths a,b --paths c`. Booleans
  keep yargs `type: 'boolean'` with `--flag=false` support; `--quick false`
  is read as a value (accepted difference from Go) and a test pins it.
- yargs is pinned to English with `.locale('en')` and `.detectLocale(false)`
  so messages never depend on the environment.
- `--error-format` validation and the gate bootstrap run in a yargs
  middleware (or at the top of each handler) after parsing, before the
  action, in that order. On a parse failure, `run` uses the parsed
  `--error-format` if yargs produced it, else `text`.
- Group commands (`gate`, `skill`) register a handler that prints help
  when there is no subcommand; `.strict()` makes unknown subcommands
  usage errors.

### 3.5 Review orchestration types

```ts
export interface ReviewFlags {
    config:string; base:string; uncommittedOnly:boolean;
    staged:boolean; task:string; format:'json'|'markdown'|'both';
    maxSeverity:string; paths:string[]; exclude:string[];
    includeVendored:boolean; mode:string; quick:boolean;
    noVerify:boolean; interactive:boolean; maxTurns?:number;
    deadlineMs?:number; requestTimeoutMs?:number;
    maxTokensTotal?:number; maxVerified?:number; maxAttempts?:number;
    showDropped:boolean; lang:string[]; scope:'diff'|'repo';
    authorModel:string; finder:RoleFlags; verifier:RoleFlags;
}
export interface RoleFlags {
    baseUrl?:string; model?:string; protocol?:string;
    maxOutputTokens?:number;
}
export function validateReviewFlags (f:ReviewFlags):number // gate rank
export function runReview (f:ReviewFlags, ctx:RunContext):Promise<void>
export function resolveLangs (
    flags:string[], files:string[], mode:string
):string[]
export function applyRoleFlags (
    name:'finder'|'verifier', role:ResolvedRole, flags:RoleFlags
):ResolvedRole
export function flagOrConfig<T> (
    flag:T|undefined, configured:T|undefined, fallback:T
):T
```

`runReview` throws `UsageError`, other errors, or `ExitSignal`; it never
writes the error itself. Durations are carried in milliseconds as
numbers internally; `formatGoDuration(ms)` produces budget strings (Go
nanosecond precision beyond ms is not needed for flags; config durations
use the same parser, see config area). Snapshot cleanup uses
`try/finally` with a `durable` flag, matching the Go `defer`.

Dependencies: config, credentials, trust, scope, context, prompts, llm,
finder, verifier, render (incl. textsafe), records, snapshot, gate,
buildinfo, duration, `@substrate-system/debug` (`roast:cli`).

### 3.6 Build info

Version, commit, and build date are injected at build time; from source
they are `dev` / `unknown` / `unknown`. esbuild `define`s
`__ROAST_VERSION__` (from `package.json`),
`__ROAST_COMMIT__` (`git rev-parse --short=7 HEAD`), `__ROAST_DATE__`
(`git log -1 --format=%cI`), each falling back to `dev` / `unknown` /
`unknown` when unavailable. `src/buildinfo.ts` exports them and
`buildString()`. Tests run unbundled code where the globals are absent:
`buildinfo.ts` reads them through `typeof` guards.

### 3.7 Test fixtures

- `test/helpers/env.ts`: `cleanEnv(base)` returns a copy of an env with
  every variable whose upper-cased name starts with `ANTHROPIC_`,
  `OPENAI_`, `OPENROUTER_`, or `ROAST_` removed. Tests build `io.env`
  from it (plus `PATH`, `HOME` isolation, and explicit variables); no
  test mutates `process.env`.
- `test/helpers/inference-stream.ts`: `writeInferenceStream(res,
  protocol, response)` turns a complete response object into the native
  SSE stream for `anthropic`, `responses`, or `chat`, exactly as in
  section 3.8. `writeJSONStream(res, protocol, body)` parses a JSON
  string first. Unknown protocol -> error.
- `test/helpers/run.ts`: `runRoast(args, opts)` wraps `run` with buffer
  streams, a temp repo cwd, clean env, and an optional redirecting
  `fetch`; returns `{code, error, stdout, stderr}`.
- Terminal and browser swaps: `simulateTerminals(t, value)` and
  `captureBrowser(t)` replace the module-level functions and restore
  them at test end.

### 3.8 SSE fixture format (`writeInferenceStream`)

Sets `Content-Type: text/event-stream`. Each event is
`[event: <name>\n]data: <json>\n\n`. For `responses`, every emitted
object gets `sequence_number` 0, 1, 2, ... in emission order.

- `anthropic`: `message_start` with `message` = response with `content:
  []`, `stop_reason: null`, `usage` copied with `output_tokens: 0`. For
  each content block at index i: `content_block_start` (`index`,
  `content_block` = block with `thinking` and `signature` emptied for
  thinking, `text` emptied for text, `input: {}` for tool use); deltas
  (`thinking_delta` + `signature_delta`; `text_delta`; or
  `input_json_delta` with `partial_json` = JSON of the input);
  `content_block_stop`. Then `message_delta` (`delta: {stop_reason,
  stop_sequence: null}`, `usage` = response usage) and `message_stop`.
  Event name = the object's `type`.
- `responses`: `response.created` (`response` with `output: []`,
  `status: in_progress`); per output item: `response.output_item.added`
  (item with `arguments: ""`, `status: in_progress`),
  `response.function_call_arguments.delta` (`item_id`, `delta` =
  arguments), `response.function_call_arguments.done` (`arguments`),
  `response.output_item.done` (full item), each with `output_index`;
  then `response.completed` with the full response.
- `chat`: no `event:` lines. Three chunks, each `{id, object:
  "chat.completion.chunk", created: 1, model, choices}`: first, choices
  with `delta` = message with `tool_calls` re-indexed (`index` = position)
  and `finish_reason: null`; second, choices with empty `delta` and the
  real `finish_reason`; third, `choices: []` plus `usage`. Then
  `data: [DONE]\n\n`.

## 4. Deliberate changes

1. The cobra `completion` command is dropped.
2. Windows is not supported: `openBrowser` uses `open` (darwin) or
   `xdg-open` (linux) only.
3. Node `>=22.18`, checked at startup; below it the CLI prints a clear
   error and exits 2 (spec.md change 3).
4. Debug tracing via `@substrate-system/debug` namespace `roast:cli`
   (`DEBUG=roast:*`), never including request/response bodies, headers,
   prompts, or credentials.
5. First TypeScript release is `2.0.0`; build info comes from esbuild
   defines instead of Go ldflags / `debug.ReadBuildInfo`.
6. Help text wording and layout come from yargs and need not match
   cobra.
7. A second SIGINT or SIGTERM force-exits with status 130; Go ignored
   repeats (spec.md change 22). Ctrl-C (`\x03`) at a raw-mode secret prompt
   is cancellation, exit 5.
8. Accepted yargs parsing differences: decimal-only integers, `--quick
   false` read as a value, plain comma splitting of list flags (spec.md
   "CLI parsing").
9. JSON error output is not HTML-escaped; parity is on parsed JSON.
10. EPIPE on stdout exits quietly with the computed code instead of dying
    by SIGPIPE.
11. A parse failure reports in the parsed `--error-format` when yargs
    produced one, else text.

Not a change: the gate bootstrap's terminal check uses the swappable
`interactiveTerminals(io.stdin, io.stderr)` instead of Go's direct check
of the process's stdin/stderr; in production these are the same streams.

## 5. Test plan

All at the `run(argv, io)` seam with a `node:http` fake inference server
unless noted. Assert exit codes, JSON, files, and requests; never exact
human-readable text.

Exit codes and errors:

- Exit code constants 0..5 (TestExitCodeContract) -- unit.
- Category mapping for clean, findings, usage, auth, endpoint, budget,
  cancelled, partial (TestErrorCategoryFor) -- unit on
  `errorCategoryFor` with wrapped errors.
- `review --error-format json --format invalid` in a Git repo -> exit 2,
  stderr parses as `{error_category: "usage", exit_code: 2}` with a
  message (TestJSONErrorOutput).
- Text error output escapes control bytes (TestWriteErrorEscapesControls)
  -- unit on `writeError`.
- Artifact failure wins over the severity gate
  (TestReviewExitErrorPrefersArtifactFailureOverFindingGate) -- unit.
- `--max-attempts=0`, `--request-timeout=-1s`, `--max-tokens-total=-1`,
  `--finder-max-output-tokens=0` with `--quick --uncommitted-only` -> exit
  2, category usage (TestInvalidResourceOverridesAreUsageErrors).
- Unknown subcommands and wrong arg counts -> exit 2: `gate bogus`,
  `config bogus`, `skill bogus`, `runs show` (0 and 2 args), `runs
  checkout` (0 and 3 args); `gate` and `skill` alone -> exit 0 with help
  on stdout (TestCommandUsageErrorsExitWithUsageCode).
- `runs sync`, `runs status` -> exit 2 (TestRunsUploadSubcommandsAreUnknown).
- New: SIGINT-equivalent abort during the finder -> exit 5, category
  `cancelled` (signal passed through `io.signal`).
- New: `--version` exits 0 and prints the build string on stdout.
- New: a second abort-style signal force-exits 130 -- entry-level test
  spawning the built CLI against a fake server that never answers, sending
  SIGINT twice (first alone gives exit 5); no child process remains.
- New: `\x03` fed to the raw-mode secret prompt -> cancellation, exit 5
  (unit on `readSecret` with a fake TTY stream).
- New: Node below 22.18 -> exit 2 with an error on stderr (unit on the
  version-check function with injected version strings).
- New: EPIPE on a closed stdout pipe -> no stack trace, exit code equals
  the computed code (entry-level test piping into a closed reader).
- New: parse failure with `--error-format json` parsed -> JSON error;
  with none parsed -> text.
- New: `--paths a,b --paths c` splits to three entries; `--max-attempts
  0x10` -> exit 2; `--quick false` is read as false; JSON error output
  compared as parsed JSON (message containing `<>&` round-trips).
- New: empty diff with invalid `--mode` -> exit 0.

Command surface and help:

- `--help` exits 0 with no config (TestHelpNeedsNoConfiguration).
- Required commands exist and forbidden ones do not, including no
  `runs label` (TestPublicCommandSurface) -- assert via running
  `<cmd> --help` exit codes rather than introspection.
- Review help states effective defaults (TestReviewHelpShowsEffectiveDefaults)
  -- keep only as a loose check that the four default numbers appear, or
  drop as brittle.
- Bare `roast` outside Git -> exit 0, help on stdout
  (TestBareCommandOutsideGitShowsHelp).
- `review --config <file>` outside Git -> exit 2
  (TestExplicitReviewOutsideGitStillFails).
- `runs`, `runs prune --dry-run` work in a repo
  (TestRunsLocalSubcommandsStillWork).

Pipeline (end to end with fake server):

- Finder + verifier on a custom endpoint, `--format json --max-severity
  HIGH` with all budgets 0 and `--max-attempts=1` -> exit 1, confirmed
  finding in JSON, run bundle and `provider_responses` captured for both
  roles, meta budgets record 0s / 0 / 1, role meta records profile,
  protocol, session header; session header sent only by the finder
  profile; `runs show`, `runs checkout`, `runs` work on the run; only
  inference requests reach the server
  (TestFinderVerifierPipelineWithMockEndpoint).
- Anthropic-protocol finder with chat verifier
  (TestNativeAnthropicFinderWithChatVerifier).
- `--scope repo` sends the manifest, uses interactive tools, two finder
  requests (TestRepositorySurveyUsesManifestAndInteractiveTools).
- Corpus pinned without a snapshot (no HEAD; `review.snapshot: false`):
  verifier reads the pinned file, severity canonicalized, exit 1
  (TestReviewPinsCorpusWithoutSnapshot).
- Run records live under the Git toplevel even with the config in a
  subdirectory and cwd deeper (TestRunRecordsLiveUnderProjectToplevel).

Settings resolution:

- Config limits appear in meta budgets and derived meta
  (TestLimitsInProjectConfigBoundTheReview).
- `limits.max_diff_bytes` truncates the finder diff
  (TestMaxDiffBytesInProjectConfigTruncatesTheDiff).
- `limits.max_prompt_bytes` too small -> exit 2, no request
  (TestMaxPromptBytesInProjectConfigRejectsALargePrompt).
- Invalid limits -> non-zero, no request (TestInvalidLimitsAreRejected).
- Interactive thresholds: small diff downgrades `--interactive`; zero
  thresholds keep it (TestInteractiveThresholdsInProjectConfig).
- `review.snapshot` false -> no snapshot, no `refs/roast/` refs
  (TestReviewSnapshotSettingInProjectConfig).
- Flags override config for one invocation only, including
  `--finder-model` (TestFlagsOverrideProjectConfigForOneInvocation).
- Removed environment variables change nothing (defaults in budgets,
  no request to env-named endpoints)
  (TestRemovedEnvironmentVariablesHaveNoEffect).
- `--author-model` flips the finder; `ROAST_AUTHOR_MODEL` does not
  (TestAuthorModelFlagSelectsTheFinderFlip,
  TestAuthorModelEnvironmentDoesNotFlipTheFinder).
- Role flag credential rules (TestProtocolFlagMovesAnUnmodifiedDefaultEndpoint,
  TestProtocolFlagClearsWrongProviderCredential,
  TestBaseURLFlagDoesNotCarryAmbientProviderKey) -- config area unit
  tests of `OverrideEndpoint`, plus one CLI test that a changed
  `--finder-base-url` withholds the ambient key.
- Gate offer: `gate.offer: false` suppresses it without using it up;
  `ROAST_NO_HOOK` does not suppress it; invalid gate settings -> exit 2
  (TestGateOfferFalseStopsTheGateOffer,
  TestNoHookEnvironmentDoesNotStopTheGateOffer,
  TestInvalidGateSettingsAreRejected). Assert the offer through gate
  state or a stable marker, not prose.

Config discovery (CLI level; config area owns details):

- JSONC config used; nearest config below the toplevel; `--config`
  overrides discovery; invalid config rejected; missing config is a usage
  error naming `npx roast init`; user config directory not read;
  `config init --from-url` unknown (TestReviewUsesModelsFromJSONCProjectConfig,
  TestReviewUsesNearestProjectConfigBelowGitToplevel,
  TestConfigFlagOverridesDiscoveredProjectConfig,
  TestReviewRejectsInvalidProjectConfig,
  TestReviewWithoutProjectConfigNamesRoastInit,
  TestUserConfigDirectoryIsNotRead, TestConfigInitFromURLIsUnknown).
- Prompt override paths resolve against the config directory
  (TestPromptOverrideResolvesAgainstConfigDirectory,
  TestPromptOverrideFromSubdirectoryWithoutLocalCopy).

Terminal and trust prompt (trust area owns, seam shared):

- Inline trust prompt approves on yes, declined sends nothing,
  non-terminal fails closed (TestInlineTrustPromptApprovesOnYes,
  TestInlineTrustPromptDeclinedSendsNothing,
  TestNonTerminalReviewFailsClosedWithoutPrompting).
- Default terminal detection rejects non-file streams
  (TestDefaultTerminalDetectionRejectsNonFiles) -- unit.

Lower seams (unit): `parseGoDuration` / `formatGoDuration` round trips
(`0s`, `45s`, `3m0s`, `1h30m0s`, `1.5ms`), `resolveLangs`,
`flagOrConfig`, `captureSnapshot` diff pair selection, `cleanEnv`
(TestClearAmbientEnvironmentUnsetsProviderVariables), `buildString`
formats (replaces TestResolve, which tested Go toolchain metadata and is
not ported), `promptYesDefault` answers including EOF.

## 6. Go baseline references

At commit `cd08f10`:

- `cmd/roast/main.go`
- `internal/cli/cli.go`, `internal/cli/config.go`,
  `internal/cli/prompt.go`
- `internal/buildinfo/buildinfo.go`, `scripts/build.ts` (ldflags)
- `internal/testutil/env.go`, `internal/testutil/inference.go`
- Tests: `internal/cli/cli_test.go`, `settings_test.go`,
  `project_config_test.go`, `records_test.go`, `hardening_test.go`,
  `prompt_override_test.go`, `trust_prompt_test.go`, `main_test.go`,
  `internal/buildinfo/buildinfo_test.go`,
  `internal/testutil/env_test.go`
- Behavior read from neighbors: `internal/review/types.go` (severity
  ranks, `MaxSeverity`), `internal/verify/verify.go` (verifier errors
  become undecided verdicts), `internal/llm/provider.go` (context error
  normalization), `internal/scope/scope.go` (`GitRoot`, `Empty`),
  `internal/config/config.go` (`Gate.Offers`).

## 7. Resolved

1. JSON error output: parity is on parsed JSON, no HTML escaping
   (spec.md, "JSON encoding").
2. Parse failure uses the parsed `--error-format` when yargs produced one,
   else text (spec.md, "CLI parsing").
3. Integer flags are decimal only, an accepted yargs difference (spec.md,
   "CLI parsing").
4. `--quick false` is read as a value by yargs: accepted (spec.md, "CLI
   parsing").
5. List flags split on plain commas: accepted (spec.md, "CLI parsing").
6. A second Ctrl-C force-exits 130; Ctrl-C at a raw-mode secret prompt is
   cancellation, exit 5 (spec.md, change 22).
7. EPIPE on stdout exits quietly with the computed exit code (spec.md,
   "CLI parsing").
8. Empty diff skips `--mode`/`--lang` validation: keep Go parity.
