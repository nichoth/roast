# 03: Shared Go-compat and utility modules (prefactor)

**Blocked by:** 01
**Touches:** `src/gocompat/strings.ts` (`isGoSpace`, `goTrimSpace`,
`goExt`, `truncateUtf8`, `formatFixed2`, `compareBytes`, `goQuote`),
`src/gocompat/duration.ts` (`GoDuration`, `parseGoDuration`,
`isGoDuration`, `toMillis`, `formatGoDuration`),
`src/gocompat/match.ts` (`goPathMatch`), `src/textsafe/textsafe.ts`
(`text`, `line`, `textBytes`, `lineBytes`), `src/fsutil/atomic.ts`
(`writeFileAtomic`), `src/git/git.ts` (`GitError`, `git`, `gitOk`,
`gitRoot`), `src/util/pool.ts` (`mapPool`), `test/gocompat/*.ts`,
`test/textsafe/*.ts`, `test/fsutil/*.ts`, `test/git/*.ts`,
`test/util/*.ts`
**Spec:** spec.md "Modules" (gocompat, fsutil), "Bytes and text",
"Process lifetime"; `spec/09-verify-render.md` 2.9, 2.10, 3
(`textsafe`, `gocompat`), 5 (textsafe and gocompat units);
`spec/02-config.md` 2.4 "Duration strings"; `spec/01-cli.md` 2.11
(duration formatting); `spec/08-finder-prompts.md` 2.11 (`goExt`);
`spec/04-scope.md` 2.12.1 (`strconv.Quote` rules), 2.13 (`gitRoot`), 3.3
(git runner rules), 3.4 (`compareBytes`); `spec/05-context.md` 2.7 (`%q`),
2.9 (`path.Match` rules); `spec/11-snapshot.md` "Secret denylist" (match
rules); `spec/03-trust-credentials.md` 2.6 and 2.12 (atomic writes);
`spec/12-gate.md` 2.7 (`writeFileAtomic`)
**Status:** done

## What to build

Small, dependency-free modules that several areas would otherwise each
write their own copy of. Making them first keeps later tickets from
duplicating Go-parity logic. Every module here is pure or a thin shell and
is tested as a unit (a lower seam allowed by spec.md "Testing Decisions"
for `gocompat` and `textsafe`).

Seam resolutions approved for the whole rewrite, which this ticket
implements and later tickets import:

1. **One git runner** in `src/git/git.ts`, not separate runners in scope,
   context, trust, records, gate, and snapshot. Scope and context add
   their specialized wrappers (`gitPatch`, `gitCapped`, streaming) on top
   of it in their own tickets. It runs `execFile('git', ['-C', repo,
   ...args])` with Buffer output and effectively unlimited `maxBuffer`,
   optional stdin `input`, and an `AbortSignal` that kills the child
   (SIGTERM, then SIGKILL after a short grace) and rejects with the
   signal's reason. The environment is the caller's `env` (from the CLI
   context, never read from `process.env` inside the runner when one is
   passed) with optional extra variables merged over it. Failure is a
   `GitError` with message `exit status <code>: <trimmed stderr>`,
   `exitCode`, and `stderr`. `gitOk` resolves `false` on a non-zero exit
   and rejects only on abort or spawn failure. `gitRoot(start, opts)` runs
   `rev-parse --show-toplevel`, trims it, and fails with `not inside a git
   repository` on any failure.
2. **Go durations live in `gocompat`**, not `src/duration.ts` (area 01)
   or `src/config/duration.ts` (area 02). `parseGoDuration` follows the
   `time.ParseDuration` grammar in `spec/02-config.md` 2.4 (signs, decimal
   fractions, `ns us µs μs ms s m h`, bare `0`, int64 overflow invalid)
   and returns nanoseconds as `bigint`. `formatGoDuration(ns:bigint)`
   reproduces Go `Duration.String` (`spec/01-cli.md` 2.11). `toMillis`
   converts for timers. The config and CLI tickets import these.
3. **Atomic writes live in `fsutil`** with options covering all three
   callers: trust (`trust-<random>.json` temp, parent `mkdir -p` 0o755,
   no parent chmod), credentials (`credentials-<random>.json`, parent
   0o700 and chmod even if it exists), and the gate (temp
   `.<basename>.roast-<random>`, final file mode set with `fchmod`, for
   example 0o755 hook scripts). In every case the temp file is opened
   exclusive-create with mode 0o600 and an unpredictable name (retry on
   `EEXIST`), renamed over the target, and removed on any failure; no
   `fsync`. The caller supplies the error prefix (`write trust record`,
   `write credentials`) or per-step messages for the gate. Gate code must
   use this module rather than its own `gate/atomic.ts`.
4. `compareBytes` (UTF-8 byte order, used for every sort in scope and
   records), `goPathMatch` (Go `path.Match` / `filepath.Match` on `/`
   paths: `*`, `?`, `[...]` with `^` and ranges, `\` escapes, malformed
   pattern never matches), and `goQuote` (Go `strconv.Quote`, lowercase
   hex, rules in `spec/04-scope.md` 2.12.1) are consolidated here instead
   of in `scope/text.ts`, `record/json.ts`, `context/glob.ts`, and
   `snapshot/denylist.ts`. Callers that need extra wrapping (for example
   `manifestQuote` replacing `<` and `>`) do it in their own module.

Also here: `isGoSpace` / `goTrimSpace` (Go `unicode.IsSpace`, trims
U+0085, not U+FEFF), `goExt` (Go `filepath.Ext`: `docs/.md` -> `.md`,
`file.` -> `.`), `truncateUtf8` (byte-measured, never splits a code
point), `formatFixed2` (Go `%.2f`, half-to-even on exact binary ties),
`textsafe` exactly as `spec/09-verify-render.md` 2.10 and 3 (string
variants escape lone surrogates as lowercase `\uNNNN`; byte variants use a
hand-written Go `DecodeRune` validity check, not `TextDecoder`), and
`mapPool(items, limit, fn, signal?)`, the small promise pool that replaces
Go worker pools: at most `limit` concurrent calls, results in input
order, never starts all items at once.

No consumer wiring happens here; later tickets import these modules.

## Acceptance criteria

- [x] `textsafe.text` escapes C0 controls, DEL, C1 controls, and invalid
      bytes, keeps `\n`, `\t`, and valid non-ASCII, collapses CRLF, and
      escapes a lone CR, matching every Go vector in 09 / 2.10.
- [x] `textsafe.line` escapes `\n` and `\t` as two characters and does
      not collapse CRLF.
- [x] Over every code point U+0000 to U+00FF plus the bytes `ff fe c2`,
      and over random byte arrays for `textBytes` / `lineBytes`, outputs
      contain no control character, no invalid byte, and (line mode) no
      `\n` or `\t`; applying either function twice equals applying it
      once.
- [x] A lone surrogate in a string input comes out as a lowercase
      `\uNNNN` escape; a well-formed surrogate pair is unchanged.
- [x] `formatFixed2` gives `0.12 0.38 0.62 0.88` for 0.125, 0.375, 0.625,
      0.875 and the negatives symmetrically.
- [x] `goTrimSpace` trims U+0085 and does not trim U+FEFF; `goExt` returns
      `.md` for `docs/.md` and `.` for `file.`; `truncateUtf8` never
      splits a code point and measures UTF-8 bytes.
- [x] `parseGoDuration` accepts `90s`, `10m`, `1h30m`, `1.5h`, `.5s`,
      `-1s`, `0`, `-0s`, both micro signs, and rejects `""`, `10`, `1x`,
      and values overflowing int64 nanoseconds.
- [x] `formatGoDuration` produces `0s`, `45s`, `3m0s`, `10m0s`, `1h30m0s`,
      `1m30.5s`, `1.5ms`; parse then format round-trips those strings.
- [x] `goPathMatch` covers `*` and `?` not crossing `/`, classes with
      negation and ranges, escapes, and returns false for a malformed
      pattern.
- [x] `goQuote` matches Go `strconv.Quote` for quotes, backslashes, the
      named control escapes, other controls and DEL as `\xNN`,
      non-printable code points as `\uXXXX` / `\UXXXXXXXX`, and printable
      non-ASCII kept literally.
- [x] `compareBytes` orders strings by UTF-8 bytes (a supplementary-plane
      character sorts after U+FFFF, unlike `<` on JS strings).
- [x] `writeFileAtomic` leaves only the target file (mode as requested,
      0o600 by default) and no temp file after success, leaves the
      original untouched and no temp file when the write fails, and in
      credentials mode tightens an existing 0o755 parent to 0o700.
- [x] In a temp Git repository, `gitRoot` from a subdirectory returns the
      toplevel (compared after `realpath`); outside a repository it fails
      with the not-in-a-repository error.
- [x] A git call whose signal aborts mid-run rejects with the abort
      reason and leaves no child process; a failing git call rejects with
      a `GitError` carrying the exit status and trimmed stderr; `gitOk`
      resolves `false` for a failing `rev-parse --verify`.
- [x] The git runner passes the caller's env (an injected variable is
      visible to git, for example via `git var` or a config env) without
      reading `process.env` when an env is given.
- [x] `mapPool` with limit 2 over 5 slow items never has more than 2 in
      flight and returns results in input order.
- [x] `npm run lint`, `npm run typecheck`, `npm run test:ts` pass;
      `go test ./...` still passes.
