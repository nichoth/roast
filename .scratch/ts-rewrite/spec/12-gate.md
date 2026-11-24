# Area 12: Gate and `ignore`

## 1. Purpose

The **gate** is the pre-commit hook that runs a quick review of exactly the
staged content of a commit and fails open: only a finding at or above the
configured severity blocks the commit; every operational failure prints a
warning and lets the commit through.

This area owns:

- the hook script (`pre-commit.sh`, shipped unchanged from Go) and its
  contract with the CLI;
- installing, refreshing, inspecting, and removing the hook in a repository
  (`roast gate enable|disable|status`), including coexistence with a
  **foreign** (someone else's) pre-commit hook and with a shared
  `core.hooksPath` dispatcher;
- the per-repository enrollment decision stored in local Git config;
- the hidden `roast gate settings` query the hook makes;
- the **review-time bootstrap**: the one-time offer, made before a review
  runs, to enable the gate;
- `roast ignore` (and the helper `init` reuses), which adds `/.roast/` to
  the toplevel `.gitignore` so run records are not committed.

The gate reads only a project config at the Git toplevel, because the hook
runs from the toplevel without `--config`.

## 2. Behavior contract

### 2.1 Constants

| Name | Value |
|------|-------|
| hook name | `pre-commit` |
| sidecar name | `roast-pre-commit` |
| hook marker | `# roast-gate-hook: v1` |
| hook header | `"#!/bin/sh\n# roast-gate-hook: v1\n"` |
| append begin marker | see 2.6 |
| append end marker | `# <<< roast pre-commit gate <<<` |
| decision config key | `roast.gate` |
| notice config key | `roast.gate-notice` (value written: `sent`) |
| default gate timeout | `180` seconds |
| default gate severity | `HIGH` |
| state ignore entry | `/.roast/` (from the run-record state dir `.roast`) |

**Manual line** -- the one line that invokes the sidecar; it is both the
body of the appended block and what a user adds by hand to a hook Roast
will not edit:

```sh
"$(git rev-parse --git-path hooks/roast-pre-commit)" || exit $?
```

**HookScript** is the byte-exact content of `pre-commit.sh` (it starts with
the hook header). Every "is it current" check is an exact byte comparison
against it. Because the TS version ships the identical file, hooks
installed by the Go version compare equal and are not reported stale. The
file must reach `dist/cli.js` byte-for-byte (esbuild `text` loader; no
reformatting, LF line endings).

### 2.2 Git plumbing

All Git calls are `git -C <repo> ...` where `<repo>` is the working-tree
root from `git rev-parse --show-toplevel` (the scope area's `gitRoot`).

- **Hook path resolution** (`resolveHookPath(repo, name)`):
  `git -C <repo> rev-parse --git-path hooks/<name>`, stdout trimmed. Non-zero
  exit -> error `resolve hooks path in <repo>: <err>`; empty output -> error
  `resolve hooks path in <repo>: git returned nothing`. A relative result is
  joined onto `<repo>`. Git itself honours `core.hooksPath` and, in a linked
  worktree, the common git dir (hooks are shared across worktrees). Used for
  both `hooks/pre-commit` (the hook path) and `hooks/roast-pre-commit` (the
  sidecar path).
- **Shared** = `git -C <repo> config --get core.hooksPath` exits 0. Note:
  no `--local`; a global or system `core.hooksPath` also counts.
- **Config get** (`--local`): `git -C <repo> config --local --get <key>`;
  any failure reads as `""`; output trimmed.
- **Config set**: `git -C <repo> config --local <key> <value>`; failure ->
  error `git config <key>: <err>: <trimmed combined output>`.
- **Config unset**: `git -C <repo> config --local --unset <key>`; callers
  ignore its failure (exit 5 means "not set").

### 2.3 Enrollment decision

`Decision` is one of `none` (Go `""`), `enabled`, `declined`.

`readDecision`: local `roast.gate`, trimmed and lowercased:

- `enabled | enable | true | yes | on | 1` -> `enabled`
- `declined | disabled | false | no | off | 0` -> `declined`
- anything else, including unset -> `none` (a typo means "unanswered")

The hook script accepts exactly the same enabled aliases (it reads with
`--local`, so a global `roast.gate` never enrolls a repo).

`recordDecision(repo, d)`: first unset `roast.gate-notice` (ignore errors);
then if `d` is `none` unset `roast.gate` (ignore errors) and return;
otherwise set `roast.gate` to `enabled` or `declined`.

`recordNotice(repo)`: set `roast.gate-notice` to `sent`.

### 2.4 Inspect (never mutates)

`inspect(repo) -> Status` with fields `repo`, `decision`, `hookPath`,
`sidecarPath`, `shared`, `exists`, `ours`, `appended`, `foreign`,
`appendable`, `executable`, `stale`, `noticeSent`. At most one of `ours`,
`appended`, `foreign` is true.

Algorithm:

1. Resolve hook path and sidecar path (errors propagate). Set `shared`,
   `decision`, `noticeSent` (= local `roast.gate-notice` non-empty).
2. `lstat(hookPath)`. ENOENT -> return (all file flags false). Other error
   -> `stat <path>: <err>`.
3. `exists = true`; `executable = (lstat mode & 0o100) != 0` (owner execute
   bit; Git silently skips a hook without it).
4. A symlink is `foreign` (never appendable); return.
5. Read the file (error -> `read <path>: <err>`). Classify:
   - body starts with the hook header -> `ours`;
     `stale = body !== HookScript || !executable`.
   - else if the body contains a valid appended block (2.6) -> `appended`;
     `stale = !sidecarCurrent(sidecarPath)`. The foreign file's own mode
     never feeds `stale` (Roast does not repair it); it feeds `active`.
   - else `foreign`; `appendable = appendable(bodyBytes)`.

`sidecarCurrent(path)`: `stat` (follows symlinks) succeeds, owner execute
bit set, and content equals HookScript.

`active(status) = decision === enabled && (ours || appended) && executable`.

**Summary** (one line, first match wins; `<p>` is `hookPath`). The Go
strings use an em dash (U+2014), and so does the real TS output: the
character is kept and written as the escape `\u2014` in TS source (spec.md
cross-cutting "Output strings"). Where this spec writes `--` inside these
quoted output strings, read it as U+2014; `pre-commit.sh` bytes are
unchanged:

1. `(ours||appended) && !executable`: `INSTALLED BUT NOT RUNNING -- <p> is
   not executable, so git skips it (chmod +x it, or ``roast gate enable``
   for roast's own hook)`
2. `(ours||appended) && stale`: ``installed dispatcher is stale -- run
   `roast gate enable` to refresh: <p>``
3. `(ours||appended) && decision=declined`: `declined for this repo;
   dispatcher retained: <p>`
4. `(ours||appended) && decision!=enabled`: ``dispatcher installed but not
   enrolled in this repo (`roast gate enable` enables it): <p>``
5. `ours`: `installed: <p>`
6. `appended`: `installed via an appended block in a foreign hook: <p>`
7. `foreign && declined`: `declined; a foreign pre-commit hook is present
   (untouched): <p>`
8. `foreign && appendable`: ``not installed -- a foreign pre-commit hook is
   present (untouched); `roast gate enable` appends to it: <p>``
9. `foreign`: `not installed -- a foreign pre-commit hook is present and is
   not an appendable shell script (untouched): <p>`
10. `declined`: ``declined for this repo (`roast gate enable` turns it on)``
11. `enabled`: ``enabled for this repo but the hook is missing -- run
    `roast gate enable` to reinstall``
12. otherwise: ``not enrolled (`roast gate enable` installs it)``

The doctor area's `git-gate` check consumes `inspect`, `stale`, `active`,
and `summary` (warn when `stale || (enabled && !active)`).

### 2.5 Appendable foreign hooks

`appendable(bytes)` is deliberately conservative:

1. Empty, or not valid UTF-8 -> false. (Check validity on the raw bytes,
   e.g. `new TextDecoder('utf-8', {fatal:true})`; do not decode lossily
   first.)
2. First line (up to the first `\n`), strip one trailing `\r`, trim
   whitespace. Must start with `#!`, else false.
3. Split the rest on whitespace; none -> false. `interp = basename(f[0])`.
4. If `interp === 'env'`: need `f[1]`, else false; `f[1]` starting with
   `-` or containing `=` -> false; `interp = basename(f[1])`.
5. True iff `interp` is one of `sh`, `bash`, `dash`, `ksh`, `zsh`.

Pinned cases: `#!/bin/sh\n`, `#!/bin/bash -e\n`, `#!/usr/bin/env bash\n`,
`#!/usr/bin/env zsh\nx\n` -> true; `#!/usr/bin/env python3\n`,
`#!/usr/bin/perl\n`, `#!/usr/bin/env -S bash\n`, `no shebang\n`, `""`,
`"\x00\x01binary"` -> false.

### 2.6 The appended block

Markers, each a whole line:

```text
# >>> roast pre-commit gate (managed by `roast gate`) >>>
# <<< roast pre-commit gate <<<
```

Block text inserted (note the leading blank line):

```text

# >>> roast pre-commit gate (managed by `roast gate`) >>>
# Added by `roast gate enable`. Delete this block (or run
# `roast gate disable`) to remove the gate; the rest of this file is yours.
"$(git rev-parse --git-path hooks/roast-pre-commit)" || exit $?
# <<< roast pre-commit gate <<<
```

i.e. `"\n" + begin + "\n" + comment1 + "\n" + comment2 + "\n" +
manualLine + "\n" + end + "\n"`.

**Detection** (`appendedBlock(lines)`, lines = body split on `\n`): scan
lines, comparing each trimmed line. A line equal to the begin marker sets
`start = i` and clears `hasInvocation`. A line equal to the end marker while
`start >= 0`: if `hasInvocation`, return `[start, i]`; otherwise reset
`start = -1`. A line equal to the manual line while `start >= 0` sets
`hasInvocation`. No match -> not found. So: markers alone are not
authorship; a begin without an end is not a block; edits to the comment
lines inside a block keep it recognizable. Ownership is anchored: `ours`
requires the header at byte 0, never "contains the marker somewhere".

**Append** (`appendBlock(path)`): read bytes; mode = current permission
bits (fallback `0o755` if stat fails) -- preserved exactly, execute bit
included, so a hook the owner `chmod -x`'d stays disabled. Find the first
`\n`; none -> the file is a one-line hook with no trailing newline
(`appendable` accepts it): append a `\n` to the body first, then proceed
(deliberate change 19; Go failed here with `append gate to <path>: no
complete shebang line` and `gate enable` exited 4). Write
`body[..=nl] + block + body[nl+1..]` atomically with that mode. The
block goes right after the shebang (not at EOF) because a hook ending in
`exit 0` or `exec ...` would never reach a tail block. Consequence: Roast
runs first, and a blocking review stops the foreign hook from running.

**Strip** (`stripBlock(path)`): read; keep mode (fallback `0o755`); split on
`\n`; no valid block -> error `remove gate from <path>: the roast block has
no closing marker; left the file untouched (delete the block by hand)`. If
the line before `start` is blank (trimmed empty), include it in the removed
range. Rejoin the remaining lines with `\n` and write atomically. Every
other byte is preserved.

### 2.7 Writing files

- **writeFileAtomic(path, body, mode)**: create a temp file in
  `dirname(path)` named `.<basename>.roast-<random>` with exclusive create
  (`O_CREAT|O_EXCL`, mode `0o600`, unpredictable name; retry on `EEXIST`),
  write, `fchmod(mode)`, close, `rename` over `path`; remove the temp file on
  any failure. Never use a predictable temp name: `core.hooksPath` can point
  inside the working tree (`.githooks`), where a checked-out symlink at a
  predictable temp path would redirect the write. Errors: `create temp file
  for <path>: ...`, `write <tmp>: ...`, `chmod <tmp>: ...`, `close <tmp>:
  ...`, `replace <path>: ...`.
- **writeScript(path, body)**: `mkdir -p dirname(path)` (mode `0o755`;
  error `mkdir <dir>: ...`), then `writeFileAtomic(path, body, 0o755)`.
- **writeSidecar(path)**: `lstat`; symlink -> error ``<path> is a symlink
  roast did not create; move it aside and re-run `roast gate enable` ``;
  exists and content does not start with the hook header -> error
  ``<path> already exists and was not written by roast; move it aside and
  re-run `roast gate enable` ``; other stat error -> `stat <path>: ...`.
  Otherwise `writeScript(path, HookScript)`.
- **removeOwnedSidecar(path)**: absent -> ok; symlink -> leave; content not
  starting with the header -> leave; else delete (ENOENT ignored).
- **refreshOwnedSidecar(path)**: absent -> ok; not a regular file -> leave;
  starts with header and differs from HookScript -> `writeSidecar(path)`;
  else nothing. Never creates a sidecar.

### 2.8 Install

`install(repo) -> {action, status}` never records a decision (callers do).
Uses `status = inspect(repo)` (the pre-install status is returned):

| State | Effect | Action |
|-------|--------|--------|
| foreign, not appendable | `writeSidecar` only; hook untouched | `manual` |
| foreign, appendable | `writeSidecar`; `appendBlock(hookPath)` | `appended` |
| appended, not stale | none | `up-to-date` |
| appended, stale | `writeSidecar` | `refreshed` |
| ours, not stale | none | `up-to-date` |
| ours, stale | `writeScript(hookPath, HookScript)`, fixes mode | `refreshed` |
| no hook | `writeScript(hookPath, HookScript)` | `installed` |

### 2.9 Remove

`remove(repo) -> {action, status}`:

1. `status = inspect(repo)`.
2. If `shared`: when `(ours || appended) && stale`, run `install(repo)`
   (older dispatchers lack the consent check); then
   `refreshOwnedSidecar(sidecarPath)`; return `preserved`. The shared
   dispatcher is never deleted.
3. Otherwise: `ours` -> delete hook (ENOENT ignored; error `remove <path>:
   ...`), action `removed`; `appended` -> `stripBlock`, action `removed`;
   else `nothing`.
4. In every non-shared case, `removeOwnedSidecar(sidecarPath)` (an error
   here returns the action computed so far plus the error).

### 2.10 Commands

All gate subcommands take no positional arguments (extra args -> usage
error, exit 2). `roast gate` with no subcommand prints help, exit 0.
Errors that are not usage errors exit 4 (the CLI's generic code).

**`roast gate enable`**

1. Git root of cwd; failure -> usage error `not inside a Git repository`.
2. `gateConfigPath(repo)` = project-config search starting and stopping at
   the toplevel (only `<toplevel>/.roast.json`, a non-directory). Search
   error -> usage error with that message. Not found -> usage error:
   ``the pre-commit gate runs from the Git toplevel and finds no
   .roast.json there; put the project config at the toplevel (`npx roast
   init`) before enabling the gate``. The config is not loaded,
   validated, or trust-checked.
3. `install(repo)`, then `recordDecision(repo, enabled)` -- also for
   `manual`.
4. Output on stdout:
   - `manual`: ``<hookPath> is not an appendable shell script; Roast left
     it untouched.\nAdd this line manually:\n\n    <manualLine>\n`` and
     stop.
   - `installed`: `gate installed: <hookPath>`
   - `appended`: `gate appended to existing hook: <hookPath>`
   - `refreshed`: `gate refreshed: <hookPath>`
   - `up-to-date`: `gate already up to date: <hookPath>`
   - then, for all of the above four: `bypass one commit with: ROAST_SKIP=1
     git commit ...`

**`roast gate disable`** (no config required)

1. Git root; failure -> usage error `not inside a Git repository`.
2. `remove(repo)`, then `recordDecision(repo, declined)`.
3. stdout: `removed` -> `gate removed from <hookPath>`; `preserved` ->
   `gate disabled for this repository; shared dispatcher preserved at
   <hookPath>`; otherwise `no Roast gate was installed; recorded the
   decline`.

**`roast gate status`**

1. Git root; failure -> usage error `not inside a Git repository`.
2. `inspect(repo)`; print exactly three lines (labels padded to align):

   ```text
   repo:     <repo>
   gate:     <summary>
   decision: <enabled|declined|none recorded>
   ```

**`roast gate settings`** (hidden from help)

- Flag `--config <path>` (default: nearest `.roast.json` from cwd up to
  the toplevel, the standard project-config lookup). Loads the config the
  standard way (all failures are usage errors, exit 2; a missing config
  names `npx roast init`). No trust check.
- stdout, exactly: `timeout_seconds=<n>\nseverity=<SEV>\n` where `n` is
  `gate.timeout_seconds` or 180, and `SEV` is `gate.severity` uppercased or
  `HIGH`. Environment variables never affect these values (the retired
  `ROAST_GATE_TIMEOUT` / `ROAST_GATE_SEVERITY` are ignored).

Config validation of the `gate` section belongs to the config area and is
restated here for completeness: `timeout_seconds` integer >= 0 (0 disables
the watchdog); `severity` case-insensitively one of `INFO`, `LOW`,
`MEDIUM`, `HIGH`, `CRITICAL`; `offer` boolean, unset means true. Invalid
values fail any config load with a usage error (exit 2).

### 2.11 Review-time bootstrap

Runs before the review itself (before trust, scope, or any network) when
the invoked command is the bare root command or `review`, and
`--error-format` is not `json` (`--format json` does not suppress it).
Nothing here can fail the review: all failures are silent or printed as a
warning.

**Preconditions** (any failing -> do nothing, silently):

1. cwd is in a Git repository (`repo` = toplevel).
2. `gateConfigPath(repo)` finds `<toplevel>/.roast.json` without error.
   A config only in a subdirectory never triggers an offer, since the hook
   could not see it.
3. That file loads (raw config load; no trust check, no stored
   credentials). A load error is silent here; the review reports it.

**Options**: `noOffer = gate.offer === false`; a `prompt` function exists
only when stdin and stderr are both terminals (use the swappable
`interactiveTerminals` seam). The prompt writes `<question> [Y/n] ` to
stderr and reads one line from the one shared stdin reader (the same
reader the rest of the CLI uses, never a fresh buffered reader): `""`,
`y`, `yes` (case-insensitive,
trimmed) -> yes; EOF with no input -> no; anything else -> no. Messages go
to stderr as `roast: <message>\n`. If bootstrap returns an error, print
`roast: pre-commit gate setup skipped: <err>` to stderr and continue.

**Algorithm** (`bootstrap`, returns an outcome: `quiet`, `suppressed`,
`satisfied`, `installed`, `refreshed`, `declined`, `hinted`):

1. If `noOffer`, or env `GIT_INDEX_FILE` is non-empty (we are inside a Git
   hook, e.g. the gate's own review), or `repo` is empty -> `suppressed`.
   `ROAST_NO_HOOK` has no effect.
2. `status = inspect(repo)`.
3. If `shared`: `refreshOwnedSidecar(sidecarPath)`.
4. If `decision !== enabled && (ours || appended) && stale`: `install(repo)`
   (refreshes only a recognized Roast dispatcher, never a foreign hook, so
   an inherited old shared dispatcher gains the consent check), then
   re-`inspect`.
5. `declined` -> `quiet`.
6. `enabled` -> `satisfied` if `active && !stale`; otherwise run the
   install step below without recording.
7. (decision `none`) If `foreign && !appendable` -> hint: ``this repo's
   pre-commit hook is not an appendable shell script, so Roast left it
   untouched; run `roast gate enable` to install the sidecar and print the
   line to add``.
8. No `prompt` -> hint: ``no pre-commit gate in this repo; run `roast gate
   enable` to install it (non-interactive runs never install Git hooks
   without consent)``.
9. Ask: `Install the Roast pre-commit gate in this repository (<repo>)?`,
   or when `foreign`: `This repository already has a pre-commit hook.
   Append the Roast gate to it (<hookPath>)?`. Prompt error -> return it.
10. No -> `recordDecision(declined)`; print ``gate declined for this
    repository; `roast gate enable` turns it on later``; `declined`.
11. Yes -> install step with recording.

**Install step** (`record` flag): `install(repo)`.

- `manual`: if `record`, `recordDecision(enabled)`; then hint: ``this
  repo's pre-commit hook cannot be appended to, so Roast left it untouched;
  add this line to enable the gate:\n    <manualLine>``.
- otherwise, if `record`, `recordDecision(enabled)`; then `installed` ->
  print `pre-commit gate installed: <hookPath> (bypass one commit with
  ROAST_SKIP=1)`, outcome `installed`; `appended` -> print `pre-commit gate
  appended to the existing hook: <hookPath>`, outcome `installed`;
  `refreshed` -> outcome `refreshed` (silent); else `satisfied`.

**Hint** (this is "the gate hint printed during review"): if
`noticeSent`, return `quiet` without printing. Otherwise print the message,
`recordNotice(repo)`, return `hinted` (a `recordNotice` failure is returned
as the error). A hint is printed at most once per repository until a
decision is recorded (recording a decision clears the notice). A
suppressed offer (`gate.offer: false`) does not consume the notice.

The CLI messages here say bare `roast` (not `npx roast`); that is a code
string, kept as is.

### 2.12 Hook script contract (`pre-commit.sh`, shipped unchanged)

Installed as the hook (mode `0o755`) or as the sidecar. Interface:

- **Inputs**: Git's hook environment, above all `GIT_INDEX_FILE` (the
  temporary index holding exactly this commit's content, so a path-scoped
  `git commit <path>` in a dirty tree reviews only that content). The
  script never clears it; a relative value is made absolute against `pwd`.
  `ROAST_SKIP` (any non-empty value) bypasses entirely. `TMPDIR` (made
  absolute, else `/tmp`).
- **Steps**:
  1. `ROAST_SKIP` non-empty -> exit 0 silently.
  2. Local consent: `git config --local --get roast.gate`, lowercased and
     trimmed; not one of `enabled|enable|true|yes|on|1` -> exit 0 silently
     (a shared dispatcher's presence is not enrollment).
  3. Binary: `<git rev-parse --show-toplevel or .>/node_modules/.bin/roast`;
     not executable -> warn, exit 0. Never a `roast` on `PATH`.
  4. Temp dir `roast-gate.XXXXXX` under `TMPDIR`; failure -> warn, exit 0.
     Removed on exit.
  5. `"$ROAST" gate settings`; non-zero exit -> warn plus first 20 stderr
     lines, exit 0. Parse the first `timeout_seconds=` line (non-numeric or
     missing -> 180) and first `severity=` line (not one of the five
     uppercase levels -> `HIGH`).
  6. Warn that the review is starting, then run in the background:
     `"$ROAST" review --staged --quick --format both --max-severity <SEV>
     --task "pre-commit gate"`, stdout (JSON) and stderr (Markdown)
     captured to files.
  7. Watchdog when timeout > 0: poll once a second; at the deadline mark
     timed-out, send SIGTERM, wait up to 5 s, then SIGKILL.
  8. Timed out -> warn, exit 0.
  9. Empty stdout -> warn "no result (exit rc)" plus first 20 stderr
     lines, exit 0 (silence is never a pass).
  10. Exit 0 -> exit 0. Exit other than 0/1 -> warn plus first 40 stderr
      lines, exit 0.
  11. Exit 1 -> print the full captured stderr (the findings), warn that the
      commit is blocked and how to bypass, exit 1.
- **Output**: warnings go to stderr as `roast gate: <message>`.
- **CLI obligations** this places on the TS CLI: `gate settings` output
  format and defaults above; `review` accepts `--staged`, `--quick`,
  `--format both`, `--max-severity`, `--task`; review exit 1 means findings
  at or above `--max-severity` and nothing else; a review that produces a
  result writes non-empty JSON to stdout; bootstrap is suppressed when
  `GIT_INDEX_FILE` is set; SIGTERM ends the review promptly.

### 2.13 `roast ignore`

- No arguments. Git root of cwd; failure -> usage error whose message is
  the git-root error (`not inside a git repository`), exit 2.
- `ensureStateIgnored(repo) -> {path, added}` with `path =
  <repo>/.gitignore`:
  1. Read the file; ENOENT means empty; other errors -> `read <path>: ...`.
  2. Already ignored if any line, whitespace-trimmed, equals one of
     `/.roast/`, `/.roast`, `.roast/`, `.roast` -> `added = false`, no
     write.
  3. Otherwise append `/.roast/\n`, prefixed with `\n` when the file is
     non-empty and does not end in `\n`. Open with append+create, mode
     `0o644` for a new file. Errors: `open <path>: ...`, `append <path>:
     ...`, `close <path>: ...`.
- stdout: added -> `added /.roast/ to <path>`; else `<path> already ignores
  /.roast/`. Running twice changes nothing the second time.
- `roast init` calls the same helper after writing the starter config and
  prints `added /.roast/ to <path>` only when it added the line.

## 3. TypeScript module design

`src/gate/`:

- `pre-commit.sh` -- the Go file, byte-identical, imported with esbuild's
  `text` loader.
- `constants.ts` -- the 2.1 constants, `HOOK_SCRIPT`, `manualLine()`.
- `git-config.ts` -- `configGet(repo, key)`, `configSet`, `configUnset`,
  `resolveHookPath(repo, name)`, `hooksPathConfigured(repo)`. Uses the
  shared git `execFile` helper from `src/scope/` (or `src/git/`, whichever
  the scope area defines), with the caller's env passed through.
- `decision.ts`:

  ```ts
  export type Decision = 'none'|'enabled'|'declined'
  export function readDecision(repo:string, env:Env):Promise<Decision>
  export function recordDecision(
      repo:string, d:Decision, env:Env
  ):Promise<void>
  export function recordNotice(repo:string, env:Env):Promise<void>
  ```

- `hook.ts`:

  ```ts
  export interface GateStatus {
      repo:string; decision:Decision; hookPath:string;
      sidecarPath:string; shared:boolean; exists:boolean;
      ours:boolean; appended:boolean; foreign:boolean;
      appendable:boolean; executable:boolean; stale:boolean;
      noticeSent:boolean;
  }
  export type InstallAction =
      'installed'|'appended'|'refreshed'|'up-to-date'|'manual'
  export type RemoveAction = 'removed'|'nothing'|'preserved'
  export function inspect(repo:string, env:Env):Promise<GateStatus>
  export function isActive(s:GateStatus):boolean
  export function summary(s:GateStatus):string
  export function install(repo:string, env:Env):
      Promise<{action:InstallAction, status:GateStatus}>
  export function remove(repo:string, env:Env):
      Promise<{action:RemoveAction, status:GateStatus}>
  export function appendable(body:Uint8Array):boolean
  ```

  Internal: `appendedBlock`, `appendBlock`, `stripBlock`, `writeScript`,
  `writeSidecar`, `removeOwnedSidecar`, `refreshOwnedSidecar`,
  `sidecarCurrent`.
- `atomic.ts` -- `writeFileAtomic(path, body, mode)` (2.7), using
  `fs.promises.open(tmp, 'wx', 0o600)`, `crypto.randomBytes` for the name.
- `bootstrap.ts`:

  ```ts
  export type Outcome = 'quiet'|'suppressed'|'satisfied'|'installed'|
      'refreshed'|'declined'|'hinted'
  export interface BootstrapOptions {
      repo:string;
      out:(line:string)=>void;
      env:Env;
      prompt?:(question:string)=>Promise<boolean>;
      noOffer:boolean;
  }
  export function bootstrap(o:BootstrapOptions):Promise<Outcome>
  ```

`src/cli/`:

- `gate.ts` -- the `gate` command group (yargs) with `enable`, `disable`,
  `status`, hidden `settings`; `GATE_DEFAULT_TIMEOUT = 180`,
  `GATE_DEFAULT_SEVERITY = 'HIGH'`.
- `config.ts` (shared with other areas) -- `gateConfigPath(repo)` and the
  `noGateConfig` usage error.
- `bootstrap-gate.ts` -- `maybeBootstrapGate(io)` called from the root and
  `review` handlers (yargs middleware or start of the handler, before
  anything else in the review), skipped for `--error-format json`. Uses
  `interactiveTerminals` and the shared line reader for the prompt.
- `ignore.ts` -- `ignore` command, `STATE_IGNORE_ENTRY`,
  `ensureStateIgnored(repo)` (exported for `init`).

Dependencies: `src/config` (`find`, `load`, gate section types),
`src/scope` (`gitRoot`, git exec helper), `src/record` (`STATE_DIR`),
`src/cli` prompt helpers (`interactiveTerminals`, `promptYesDefault`),
usage-error type and exit codes. Consumers: `src/cli/doctor.ts`
(`inspect`, `isActive`, `summary`), `src/cli/init.ts`
(`ensureStateIgnored`).

## 4. Deliberate changes

Change 19 (spec.md) applies here; the rest are resolved decisions and
implementation notes:

- Windows is unsupported, so POSIX mode bits are always meaningful.
- Debug tracing under `roast:gate` may log actions and paths, never file
  bodies.
- U+2014 em dashes in Go's status and error strings are kept in the real
  output (written as `\u2014` escapes in TS source); see 2.4 and spec.md
  "Output strings".
- A one-line hook file with no trailing newline gets a newline before
  Roast's block is appended (spec.md change 19; see 2.6 Append).
- The bootstrap prompt reads through the shared stdin reader, not a fresh
  buffered reader as in Go.
- A global or system `core.hooksPath` still affects `gate disable` (Go
  parity, kept; see 2.2 Shared).
- The Go bootstrap checks `term.IsTerminal` on the real stdin/stderr
  directly; the TS version uses the swappable `interactiveTerminals` seam
  (settled: terminal detection is swappable). Observable behavior on real
  terminals is unchanged.

## 5. Test plan

Isolation for every test that runs git: env `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; temp dirs resolved
with `realpath` (macOS `/var` -> `/private/var`); new repos set
`maintenance.auto=false`, `gc.auto=0`, `user.email`, `user.name`,
`commit.gpgsign=false` (the maintenance settings stop detached background
`git gc` racing temp-dir removal; Go pins this with
`TestRepoDisablesAutomaticMaintenance`). The in-process `run(argv, io)`
must pass its injected env to git children. Assert on exit codes, file
contents and modes, and local git config values, not on message text.

**Hook installation and removal** -- CLI seam (`run(['gate','enable'])`,
`['gate','disable']`, `['gate','status']`) in a temp repo with a toplevel
`.roast.json`, then inspect files and `git config --local`:

- Shipped script starts with the hook header (TestHookScriptCarriesMarker).
- Fresh repo inspects as not enrolled (TestInspectNotEnrolled).
- Enable writes HookScript with mode 0755 (TestInstallCreatesExecutableHook).
- A stale own hook is rewritten; a lost execute bit is repaired
  (TestInstallRefreshesStaleOwnHook, TestInstallRepairsLostExecuteBit).
- A foreign shell hook gains the block after its shebang plus a sidecar;
  a stale sidecar is refreshed (TestInstallAppendsToForeignShellHook,
  TestInstallRefreshesStaleSidecar).
- A non-shell hook is untouched and enable still records consent
  (TestInstallNeverTouchesNonShellHook, TestManualGateEnableRecordsConsent).
- A symlinked hook is foreign and its target untouched
  (TestInstallTreatsSymlinkedHookAsForeign).
- Disable deletes an own hook; strips only the block from a foreign hook
  (byte-identical remainder); leaves a foreign hook alone
  (TestRemoveDeletesOwnHook, TestRemoveStripsAppendedBlockOnly,
  TestRemoveLeavesForeignHookAlone).
- Ownership is anchored: marker text mid-file is not ours
  (TestOwnershipIsAnchored); a begin without an end is never stripped
  (TestMalformedAppendBlockIsNeverStripped); a marker pair without the
  invocation is foreign (TestMarkerPairWithoutInvocationIsForeign).
- Appending preserves the foreign hook's mode, including a missing execute
  bit (TestAppendPreservesForeignMode).
- A foreign file at the sidecar path is never overwritten or deleted
  (TestSidecarIsNeverClobbered, TestRemoveLeavesForeignSidecarAlone).
- A planted symlink at a predictable temp name is not followed
  (TestAtomicWriteDoesNotFollowAPlantedTempSymlink; keep the Go test's
  `pre-commit.roast-tmp` name and add one for `.pre-commit.roast-*`).
- `core.hooksPath` is honoured (TestHonorsCoreHooksPath).
- Decision round trip including aliases, and recording a decision clears
  the notice (TestDecisionRoundTrip, TestRecordDecisionClearsNotice).
- Appendability table from 2.5 (TestAppendable): drive through `gate
  enable` (appended vs untouched) or, if too slow, test `appendable`
  directly as a pure function.
- Enable refuses without a toplevel config (exit 2) and works with one
  (TestGateEnableRefusesConfigTheHookCannotSee,
  TestGateEnableWithToplevelConfig).

**Shared dispatcher** (`core.hooksPath` pointing at a directory used by two
repos):

- A shared hook does not review in a repo without local consent, even with
  a global `roast.gate=enabled` (TestSharedGateRequiresLocalConsent).
- Enrollment aliases agree between `readDecision` and the script
  (TestGateEnrollmentAliasesMatchDispatcher).
- Bootstrap does not adopt an inherited gate; refreshes a declined repo's
  stale legacy dispatcher (TestBootstrapDoesNotAdoptInheritedGate,
  TestBootstrapRefreshesDeclinedLegacyDispatcher).
- Disable preserves the dispatcher for the other repo, refreshes a legacy
  one, never touches a foreign sidecar
  (TestSharedGateDisablePreservesOtherRepository,
  TestSharedGateDisableRefreshesLegacyDispatchers,
  TestSharedGateDisableNeverTouchesForeignSidecar,
  TestGateCommandsKeepSharedDispatcher).

**Bootstrap** -- CLI seam: `run(['review', ...])` against the fake
inference server (approved config), with `interactiveTerminals` simulated
and stdin answers supplied; assert `roast.gate`, `roast.gate-notice`, and
hook presence:

- A declined prompt is remembered and never re-asked
  (TestBootstrapPromptDeclineIsRemembered).
- Accepting installs and records `enabled`
  (TestBootstrapPromptAcceptsAndInstalls).
- Non-interactive runs hint once (`roast.gate-notice=sent`, no hook)
  (TestBootstrapNonInteractiveHintsOnce).
- `GIT_INDEX_FILE` set suppresses it (TestBootstrapSuppressesInsideHook).
- `gate.offer: false` never prompts or hints, and does not consume the
  notice (TestBootstrapNoOfferNeverPrompts,
  TestGateOfferFalseStopsTheGateOffer).
- `ROAST_NO_HOOK` has no effect (TestBootstrapIgnoresNoHookEnvironment,
  TestNoHookEnvironmentDoesNotStopTheGateOffer).
- No offer when the config is only in a subdirectory; offer with a
  toplevel config, also under `--format json`
  (TestReviewDoesNotOfferGateTheHookCannotRun,
  TestReviewOffersGateWithToplevelConfig). Observe via
  `roast.gate-notice`, not stderr text.

**Gate settings** -- CLI seam:

- Values come from the config, severity uppercased, env ignored
  (TestGateSettingsComeFromTheProjectConfig).
- Defaults 180 / HIGH (TestGateSettingsDefaultWhenUnset).
- No config -> exit 2 (TestGateSettingsWithoutProjectConfigIsAUsageError).
- Invalid `severity`, negative `timeout_seconds`, non-boolean `offer` ->
  exit 2 (TestInvalidGateSettingsAreRejected).

**Hook execution** -- real `git commit` in a temp repo (spawned with
`execFile`), with a POSIX shell stub written at
`<repo>/node_modules/.bin/roast` (mode 0755). The stub answers `gate
settings` from `STUB_TIMEOUT` / `STUB_SEVERITY` (optionally
`STUB_SETTINGS_EXIT`, `STUB_SETTINGS_STDERR`); for any other call it
appends `ARGS: $*`, the `git diff --cached --name-only HEAD` names, and the
full `git diff --cached HEAD` to `$STUB_LOG`, then optionally sleeps
(`STUB_SLEEP`), prints `STUB_STDOUT` / `STUB_STDERR`, and exits
`STUB_EXIT`. An empty log means no review ran. The seeded repo has `a.txt`
staged but not committed and `b.txt` committed by path (`git commit b.txt
-m ...`), with `roast.gate=enabled`. Port the stub verbatim. Assert commit
success/failure and the log; where output must be checked, check for a
test-controlled marker the stub printed, not the script's own wording.

- Path-scoped commit reviews only `b.txt`'s content
  (TestGateReviewsOnlyThePathScopedCommitsContent).
- Exit 1 blocks and the stub's stderr reaches the user
  (TestGateBlocksOnFindingsAndPrintsThemToStderr).
- `ROAST_SKIP=1` skips without running the stub
  (TestGateSkipBypassesEntirely).
- Empty stdout allows (TestGateTreatsEmptyStdoutAsInfrastructureFailure).
- Other exits allow, including exit 2 for an untrusted config whose stderr
  reaches the user (TestGateAllowsCommitOnOperationalFailure,
  TestGateAllowsCommitWhenConfigIsUntrusted).
- Missing binary allows (TestGateAllowsCommitWhenRoastIsMissing).
- Timeout allows (TestGateTimesOutWithoutBlocking; sleeps, so gate behind
  an opt-out env for quick runs); timeout and severity come from `gate
  settings`, not env (TestGateTimeoutComesFromTheProjectRoast,
  TestGateSeverityComesFromTheProjectRoast); a failing `gate settings`
  allows (TestGateAllowsCommitWhenSettingsAreUnavailable).
- Appended block runs alongside a foreign hook, including one that exits
  early, and a non-executable hook does not run
  (TestGateRunsAlongsideAForeignHook,
  TestGateRunsInAForeignHookThatExitsEarly,
  TestGateDoesNotRunWhenHookIsNotExecutable).

Since the script is unchanged, these tests mainly prove the TS install
path writes a working hook; they need `sh` and `git` only, no Node build.

**ignore** -- CLI seam (`run(['ignore'])`, `run(['init', ...])`):

- Creates `.gitignore` containing `/.roast/\n`
  (TestIgnoreCreatesToplevelGitignore).
- Appends, adding a newline to an unterminated last line
  (TestIgnoreAppendsToExistingGitignore).
- Leaves each equivalent entry form unchanged
  (TestIgnoreLeavesEquivalentEntryUnchanged).
- Second run is a no-op (TestIgnoreTwiceIsIdempotent).
- Outside a repository -> exit 2
  (TestIgnoreOutsideGitRepositoryIsUsageError).
- `init` adds the entry (TestInitIgnoresTheStateDirectory).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/gate/gate.go`, `hook.go`, `bootstrap.go`, `pre-commit.sh`
- `internal/cli/gate.go`, `internal/cli/ignore.go`
- `internal/cli/cli.go` (`gateBootstrapCommands`, `PersistentPreRunE`,
  `maybeBootstrapGate`, exit codes)
- `internal/cli/config.go` (`gateConfigPath`, `errNoGateConfig`,
  `loadProjectConfig`)
- `internal/cli/prompt.go` (`promptYesDefault`)
- `internal/cli/doctor.go` (`doctorGitChecks`, consumer)
- `internal/cli/init.go` (consumer of `ensureStateIgnored`)
- `internal/config/config.go` (`Gate`, `Offers`, `validateSettings`,
  `Find`)
- Tests: `internal/gate/hook_test.go`, `hook_exec_test.go`,
  `bootstrap_test.go`, `shared_test.go`; `internal/cli/gate_test.go`,
  `gate_config_test.go`, `ignore_test.go`, `settings_test.go` (gate
  tests), `init_test.go` (`TestInitIgnoresTheStateDirectory`)

## 7. Resolved

Resolved (maintainer decisions, see spec.md):

1. Go's em dashes in status and error strings are kept as U+2014 in
   output, written as `\u2014` escapes in TS source (spec.md cross-cutting
   "Output strings"); `pre-commit.sh` bytes are unchanged.
2. A global `core.hooksPath` affecting `gate disable` stays as Go parity
   (spec.md Further Notes).
3. A one-line hook with no trailing newline gets a newline before Roast's
   block is appended (spec.md change 19).
4. The bootstrap prompt uses the one shared stdin reader.
