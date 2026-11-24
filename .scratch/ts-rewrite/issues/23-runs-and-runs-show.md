# 23: `runs` and `runs show`

**Blocked by:** 18
**Touches:** `src/cli/runs.ts` (the `runs` command with `--limit`,
`--json`, and the `show` subcommand; a registration point the snapshot
commands in ticket 24 extend), `src/cli/run.ts` (register `runs`),
`test/cli/runs.ts`
**Spec:** `spec/10-records.md` 2.1 (record directory), 2.10, 2.14, 2.15,
section 3 (`src/cli/runs.ts`), section 5 ("`runs` command" and "Run IDs
and reports" rows for `runs show`); `spec/01-cli.md` section 5 rows for
`runs` usage errors; spec.md deliberate change 11
**Status:** done

## What to build

A developer inspects past reviews. `npx roast runs` reads the monthly
JSONL index files under `<toplevel>/.roast/runs/`, keeps the last
`--limit` lines (default 20; `<= 0` means all) across files in
chronological order, and prints one formatted line per run, or the raw
lines verbatim with `--json`. With no records it writes the
"no run records" note to stderr and exits 0. Outside a Git repository it
is a usage error. Any positional argument, including the removed `runs
sync` and `runs status`, is a usage error.

`npx roast runs show <run-id>` prints the stored `report.md` with
control bytes escaped visibly (`textsafe.text`), nothing appended.
Exactly one argument is required. Run IDs are resolved through the
records area (`reportPath`), which rejects `.`, `..`, and path
separators (deliberate change 11); a missing report is a plain error
(exit 4).

Line splitting follows Go's `bufio.Scanner` rules (split on `\n`, strip
one trailing `\r`, final unterminated line counts, a line over 16 MiB
stops reading that file). The formatted line uses the Go format string in
2.14 with `%-Ns` padding counted in code points.

Tests fabricate records with the records-area module functions (ticket
18) in a temp Git repository; no review is needed. Out of scope: `runs
checkout` and `runs prune` (ticket 24).

## Acceptance criteria

- [x] `runs` in a repository with no records exits 0 and writes nothing
  to stdout.
- [x] `runs` outside a Git repository exits 2.
- [x] `runs sync`, `runs status`, and any other positional exit 2.
- [x] `runs --json --limit 2` prints exactly the last two raw lines
  across two monthly index files, verbatim, including an unparseable one.
- [x] `runs` without `--json` prints one line per parseable index line
  containing its run ID, and skips unparseable lines.
- [x] `runs --limit 0` prints every line.
- [x] A CRLF-terminated index line is read without the `\r`.
- [x] `runs show <id>` round-trips a report written by the records module
  and exits 0.
- [x] `runs show <id>` on a report holding ESC, BEL, and C1 bytes writes
  output containing none of them.
- [x] `runs show` with zero or two arguments exits 2.
- [x] `runs show ..` and `runs show a/b` exit 4 without touching the
  filesystem outside `.roast/runs/`.
- [x] `runs show <id>` for a run directory without `report.md` exits 4.

- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
