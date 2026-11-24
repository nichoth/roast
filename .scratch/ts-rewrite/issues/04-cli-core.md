# 04: CLI core -- `run(argv, io)`, errors, exit codes, terminal helpers

**Blocked by:** 01, 03
**Touches:** `src/cli.ts` (signals, flush, EPIPE, `process.exit`),
`src/cli/run.ts` (`CliIO`, `RunResult`, `run`, yargs tree, command
registration), `src/cli/errors.ts` (`ExitCode`, `ErrorCategory`,
`UsageError`, `CancelledError`, `ExitSignal`, `errorChainHas`,
`isCancellation`, `exitCode`, `errorCategoryFor`, `writeError`),
`src/cli/terminal.ts` (`LineReader`, `promptYesDefault`,
`interactiveTerminals`, `openBrowser`, `readSecret`), `src/cli/log.ts`
(`logf`), `src/llm/errors.ts` (error kind classes only, see below),
`test/helpers/env.ts` (`cleanEnv`), `test/helpers/repo.ts` (temp Git
repo), `test/helpers/run.ts` (`runRoast`, redirecting `fetch`),
`test/helpers/terminal.ts` (`simulateTerminals`, `captureBrowser`),
`test/cli/*.ts`
**Spec:** `spec/01-cli.md` 2.1 to 2.5, 2.10 to 2.12, 2.16, 3.1 to 3.4,
3.7 (except `writeInferenceStream`), 4, 5 ("Exit codes and errors",
"Command surface and help", lower seams); spec.md "CLI parsing",
"Process lifetime", "JSON encoding"; `spec/15-packaging.md` 2.9 item 7
**Status:** done

## What to build

Grow the M0 `run(argv, io)` into the CLI core that every command ticket
plugs into, and give later tickets the in-process test seam
(spec.md "Testing Decisions": the CLI run in-process with injectable
stdin, stdout, stderr, env, cwd, signal, and `fetch`).

`run` never calls `process.exit`, never reads `process.argv`,
`process.env`, or `process.cwd()`, and never touches the real terminal; it
writes errors to `io.stderr` and returns `{code, error}`. It builds the
yargs tree of 01 / 3.4 (English locale, locale detection off, the parser
configuration listed there, strict, `exitProcess(false)`, failures
thrown as `UsageError`, global `--error-format`, root-only `--version` /
`-v`, `--help` / `-h`). Provide a registration API so area tickets add
their command modules (`review`, `runs`, `gate`, `skill`, `doctor`,
`ignore`, `trust`, `init`, `login`, `logout`) without editing the core.
The `review` command and its flags belong to ticket 20. Until then the
root / `review` handler only implements the bare-`roast` path that needs
no review: outside a Git repository (via `gitRoot` from ticket 03) bare
`roast` prints a one-line note on stderr plus root help on stdout and
exits 0, while explicit `review` outside a repository is a usage error.
Inside a repository it fails with a usage error until ticket 20 lands.

Errors and exit codes follow 01 / 2.2 to 2.4 and 3.3: exit code from the
error chain (cancellation 5, llm auth 3, `UsageError` 2, else 4; walk
`cause`, cycle-safe), `ExitSignal` for a successful review that exits 1 or
4 with nothing printed, `errorCategoryFor` in the documented order, and
`writeError` in text form (`roast: <msg>` through `textsafe.text`) or JSON
form (`error_category`, `message`, `exit_code`, no HTML escaping). A parse
failure uses the parsed `--error-format` when yargs produced one, else
text; an invalid `--error-format` value is a usage error reported in text.
A `TimeoutError` is never cancellation.

The llm error kinds the category mapping needs do not exist yet. Create
`src/llm/errors.ts` holding only the minimal classes the CLI maps
(`LlmError` base with a `kind`, `AuthError`, `EndpointError`,
`BudgetExhaustedError`, `WorkDeadlineError`, `NoFinalCallError`), so
ticket 13 extends this file (approved seam resolution 6: one llm
`errors.ts`) rather than replacing it.

Terminal helpers live in `src/cli/terminal.ts` (approved seam resolution
3; not `src/cli/prompt.ts`), per 01 / 2.16: `promptYesDefault`,
swappable module-level `interactiveTerminals` and `openBrowser`
(`open` on darwin, `xdg-open` otherwise, killed on abort), `readSecret`
(raw mode without echo on a TTY, where the byte `\x03` is cancellation,
exit 5; plain lines otherwise), and one shared `LineReader` per command
invocation. `logf` writes `roast: <text>\n` sanitized with
`textsafe.text`.

`src/cli.ts` (entry): first SIGINT or SIGTERM aborts `io.signal` with a
`CancelledError`; a second one calls `process.exit(130)`. It waits for
stdout and stderr to flush, then always calls `process.exit(code)`. An
`EPIPE` on stdout is swallowed with no stack trace and the process exits
with the computed code. Extract the signal handler and the EPIPE handling
into functions with an injectable `exit` so they are unit testable; the
end-to-end "second SIGINT against a hanging fake server" test belongs to
ticket 20, where a long-running command exists.

Test helpers (01 / 3.7, 15 / 2.9 item 7): `cleanEnv(base)` drops every
variable whose upper-cased name starts with `ANTHROPIC_`, `OPENAI_`,
`OPENROUTER_`, or `ROAST_`; a temp Git repository helper that sets
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` and isolates `HOME`,
`XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`; `runRoast(args, opts)` wrapping
`run` with buffer streams, that repo as cwd, the clean env, and an
optional redirecting `fetch` (rewrites the URL origin to a fake server and
records the original host); `simulateTerminals` and `captureBrowser` that
swap the module-level functions and restore them at test end. No test
mutates `process.env`. The SSE `writeInferenceStream` helper belongs to
ticket 13.

Debug tracing uses namespace `roast:cli` and never prints bodies,
headers, prompts, or credentials.

## Acceptance criteria

- [x] `ExitCode` constants are 0 to 5 as in 01 / 2.2, and `exitCode`
      maps wrapped cancellation, auth, and usage errors (through `cause`)
      to 5, 3, 2, and anything else to 4.
- [x] `errorCategoryFor` returns `none`, `findings`, `usage`, `auth`,
      `endpoint`, `resource_limit` (budget, deadline, no final call),
      `cancelled`, and `partial` for the matching wrapped errors and
      codes.
- [x] `writeError` in text form escapes control bytes (an ESC in the
      message never reaches stderr); in JSON form stderr parses as an
      object with `error_category`, `message`, `exit_code`, and a message
      containing `<>&` round-trips unchanged.
- [x] `--error-format yaml` exits 2 with a text error; a parse failure
      with `--error-format json` given yields a JSON error on stderr.
- [x] Unknown commands and flags exit 2: `bogus`, `config bogus`,
      `completion`, `eval`, `install`, `replay`, a root positional, and an
      unknown flag.
- [x] `--help` exits 0 with help on stdout and needs no config, Git
      repository, or network.
- [x] `--version` exits 0 and prints the build string on stdout; on a
      subcommand registered for the test it is an unknown flag (exit 2).
- [x] Bare `roast` outside a Git repository exits 0 with help on stdout;
      explicit `review` outside a Git repository exits 2.
- [x] A command registered through the registration API that throws a
      wrapped `CancelledError` while `io.signal` is aborted exits 5 with
      category `cancelled`; one that throws `ExitSignal(1)` exits 1 and
      writes nothing to stderr.
- [x] The entry signal handler aborts on the first signal and calls the
      injected exit with 130 on the second; the EPIPE handler exits with
      the computed code and writes no stack trace.
- [x] `promptYesDefault` returns true for empty, `y`, `Y`, `yes`, false
      for anything else, and false on EOF with no input.
- [x] `readSecret` on a fake TTY stream treats `\x03` as cancellation
      (exit 5 when it reaches `run`); on a non-TTY stream several answers
      fed as one string `"a\nb\n"` are read by consecutive calls sharing
      one `LineReader`.
- [x] The default `interactiveTerminals` returns false for non-file
      streams such as test buffers.
- [x] `cleanEnv` removes `ANTHROPIC_*`, `OPENAI_*`, `OPENROUTER_*`,
      `ROAST_*` (any case) and keeps other variables.
- [x] `npm run lint`, `npm run typecheck`, `npm run test:ts` pass;
      `go test ./...` still passes.
