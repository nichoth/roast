# 33: `skill install` / `status`

**Blocked by:** 04
**Touches:** `src/skill/skill.ts` (`installationTargets`, `inspect`,
`install`, swappable `lookPath`, `SkillStatus`, `InstallationTarget`),
`src/skill/assets.ts` (`SKILL_FILES`, one text-loader import per file
under `internal/skill/assets/roast/`), `src/cli/skill.ts` (`skill`
group, `install`, `status`, `skillTargets`), `test/skill/`,
`test/cli/skill.ts`
**Spec:** `spec/14-doctor-init-skill.md` 2.4, 3 (`src/skill/skill.ts`,
`src/cli/skill.ts`), 5 (skill); `spec/15-packaging.md` 2.5 (text
assets stay at their Go location until M6)
**Status:** done

## What to build

A user can install Roast's agent skill into their project with
`npx roast skill install`, and check it with `npx roast skill status`.
By default the skill goes under the Git toplevel's harness directories.
`--global` targets the user-level directories of detected harnesses.
`--dir <parent>` targets exactly `<parent>/roast` and wins over
`--global`. `--force` overwrites installed files that differ.

`skill` with no subcommand prints help, exit 0. Outside a repository
without `--global` or `--dir`, both subcommands are usage errors
(exit 2).

The installer:

- reports each target as `not_installed`, `symlink`, `up_to_date`, or
  `stale`, and lists the stale files;
- never modifies a symlinked target (a development install);
- refuses when a bundled path is a symlink inside the target;
- refuses to overwrite differing files without `--force`.

Home comes from `io.env.HOME`, never `os.homedir()`, and so do
`CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME`. A missing `HOME` is an error
as in Go. Harness detection uses the swappable `lookPath`.

The skill files are imported as text from
`internal/skill/assets/roast/` until M6, so the Go embed and the TS
bundle read the same bytes. Every file under that directory needs its
own explicit import.

Tests isolate `HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME`, and
stub `lookPath`. They must not clear `PATH`, because the CLI shells out
to `git`.

## Acceptance criteria

- [x] Each bundled file in `SKILL_FILES` equals the file's bytes on
      disk.
- [x] Install then inspect gives `up_to_date`. Editing an installed file
      gives `stale` listing that file. Install without `--force` then
      fails, and with `--force` restores `up_to_date`.
- [x] A bundled path that is a symlink inside the target is refused and
      nothing is written through it.
- [x] A target that is itself a symlink inspects as `symlink` and is
      never modified by install.
- [x] `installationTargets` includes the harnesses `lookPath` detects,
      skips undetected ones, and expands `~` in a configured root.
- [x] `skill install --dir <p>` then `skill status --dir <p>` exits 0,
      and status reports harness `custom` with state `up_to_date`.
- [x] Run from a subdirectory, `skill install` writes only under the
      Git toplevel, not under the subdirectory or `HOME`. Project
      `status` goes from `not_installed` to `up_to_date`.
- [x] Outside a Git repository without `--global` or `--dir`, both
      subcommands exit 2 and write nothing.
- [x] `--global` writes only user-level directories, and project status
      stays `not_installed`. `--dir` limits writes to one parent with
      and without `--global`.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
