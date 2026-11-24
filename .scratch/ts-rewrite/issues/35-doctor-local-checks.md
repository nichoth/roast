# 35: `doctor`, part 1 -- command, config checks, and local checks

**Blocked by:** 08, 14, 29, 33
**Touches:** `src/cli/doctor.ts` (`doctor` command, `doctorChecks`,
`DoctorResult`), `test/cli/doctor.ts` (`approveDoctorConfig`)
**Spec:** `spec/14-doctor-init-skill.md` 2.2 ("Result type", "Output",
"Check order", `build`, `config-file`, `config`, `config-trust`,
`proxy-env`, `git`/`git-gate`, `project-credentials`/`user-credentials`,
"Skill checks"), 3 (`src/cli/doctor.ts`), 4, 5 (doctor);
`spec/03-trust-credentials.md` 2.14, 5.6 (doctor rows)
**Status:** done

## What to build

A user diagnoses their setup with `npx roast doctor [--json]
[--config <path>]`. Checks run sequentially in the order of 2.2:

1. `build`, `config-file`, `config`, `config-trust`.
2. For finder, then verifier: the per-role checks. **Not in this
   ticket.** Leave one clear slot in `doctorChecks` where they run;
   tickets 43 and 44 fill it. Until then a valid config produces no
   per-role results.
3. The local checks: `git`, `git-gate`, `project-credentials`,
   `user-credentials`, `proxy-env`, then one skill check per user-level
   skill target.

The output is a text table, or with `--json` an array of
`{name, status, detail}`. Any `fail` exits 4. Warnings alone exit 0.
When `config-file` or `config` fails, the per-role slot is skipped and
the local checks still run.

This is the first of four tickets split from the original `doctor`
ticket. It sends no network requests.

Points that need care:

- **Trust.** `config-trust` follows trust hash v2. An unapproved custom
  endpoint, or an approval written by the Go version, fails. The detail
  names `npx roast trust`.
- **Credential files.** Doctor loads each scope's credentials file that
  exists. A broken file fails `<scope>-credentials` even when env
  credentials shadow it, and never leaks the key.
- **`proxy-env` (new).** It warns when `HTTPS_PROXY` / `https_proxy` is
  non-empty and `NODE_USE_ENV_PROXY` is not `1`, and never prints the
  proxy URL. It reads `io.env`.
- **Gate and skill checks.** These read `inspect` / `summary` /
  `isActive` from ticket 29 and the user-level skill targets from
  ticket 33.

Tests that use a custom endpoint chdir into a temp Git repo and approve
there, never in this checkout. Tests that expect a clean exit isolate
`HOME` and `XDG_CONFIG_HOME`.

## Acceptance criteria

- [x] `proxy-env` is `warn` with exit 0 when `HTTPS_PROXY` (and
      separately `https_proxy`) is set without `NODE_USE_ENV_PROXY`. It
      is `pass` with `NODE_USE_ENV_PROXY=1` or with no proxy variable.
      The proxy URL never appears in stdout.
- [x] A seeded Go-era (v1) trust record fails `config-trust` with exit 4.
      A built-in-only config passes `config-trust` without an approval.
      An unapproved custom endpoint fails it.
- [x] A stored credential is reported with its scope. A broken project
      or user file fails `<scope>-credentials` and the exit without
      leaking the key, while the other checks still run. An absent user
      file is not reported as a failure.
- [x] A missing config gives a failing `config-file` plus all local
      checks, and exits 4.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
