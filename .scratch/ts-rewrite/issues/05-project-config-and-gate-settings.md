# 05: Project config load and validation, plus `gate settings`

**Blocked by:** 04
**Touches:** `src/config/jsonc.ts`, `src/config/schema.ts` (zod
`ConfigSchema`, `RawConfig`), `src/config/json-schema.ts`
(`renderProjectSchema`), `src/config/load.ts` (`findConfig`, `loadConfig`,
`decode`, `normalize`, `promptPath`, `credentialEnvNames`,
`snapshotEnabled`, `gateOffers`, `ConfigError`, `PROJECT_CONFIG_NAME`),
`src/cli/config.ts` (`projectConfigPath`, `gateConfigPath`,
`loadProjectConfig`, no-config usage errors), `src/cli/gate.ts` (hidden
`gate settings` only, `GATE_DEFAULT_TIMEOUT`, `GATE_DEFAULT_SEVERITY`),
`scripts/schema.ts`, `roast.schema.json`, `package.json` (`schema`
script, `bundle`/`build` run it first), `test/config/`,
`test/tooling/` (gate settings bundle smoke test)
**Spec:** `spec/02-config.md` 2.1-2.4, 2.8, 3 (parsing pipeline, schema,
schema generation, `load.ts`), 5 (Discovery, Parsing and validation,
Schema); `spec/15-packaging.md` 2.7, 5.1 (gate settings smoke test), 5.5;
`spec/12-gate.md` 2.10 (`gate settings` only); `spec/01-cli.md` 2.8 step
2; spec.md "Cross-cutting rules" (Config numbers, JSON encoding),
"Deliberate changes" 7 and 20
**Status:** done

## What to build

Roast can find, parse, and validate a `.roast.json`, and the first
config-reading command works: the hidden `npx roast gate settings`, which
the pre-commit hook calls. It prints `timeout_seconds=<n>` and
`severity=<SEV>` from the config's `gate` section (defaults 180 and
`HIGH`, severity upper-cased, environment never consulted) and exits 2
with a usage error when the config is missing or invalid.

Loading follows the staged pipeline in 02 section 3: JSONC parse with
comments and trailing commas allowed, version check, literal-credential
rejection, `null`-as-unset, lone-surrogate rejection, strict zod schema
with exact-case keys, non-integer lexemes rejected for integer fields,
then `normalize` and `validateSettings` as plain functions so the Go error
order holds. Error wording need only be equivalent to Go's.

The zod schema is the single source of truth for `roast.schema.json`.
Per the approved seam resolution, the generator lives in
`src/config/json-schema.ts` as `renderProjectSchema():string`, and
`scripts/schema.ts` (packaging area 2.7) bundles and runs it, writing the
file only when it changed; `npm run build` runs it first. Ignore the
`src/config/schema.ts` + `scripts/gen-schema.ts` + `build:schema` naming
in 02 section 3. The generated file must still satisfy Go's
`TestSchemaMatchesConfigStruct` until cutover.

The Go duration parser comes from `gocompat` (ticket 03, seam resolution
2); do not add `src/config/duration.ts`. The git toplevel lookup comes
from the shared git runner's `gitRoot` (ticket 03).

Out of scope: role and credential resolution (06), trust (07), stored
credentials (08; `loadProjectConfig` gets a hook point to attach a store,
which 08 fills). Discovery cases that go through `review` (nearest config
in a subdirectory, `--config` overriding discovery for a review, "no
config sends no request", limits bounding a review, flags overriding
config) are verified in ticket 20; here, discovery is exercised through
`gate settings` and at the module seam. Other `gate` subcommands are
ticket 29.

## Acceptance criteria

- [x] `findConfig` returns the nearest `.roast.json`, never looks above
      the stop directory, finds one at the stop directory, and skips a
      directory named `.roast.json` (module seam).
- [x] `findConfig` stops at the Git toplevel when the start directory is
      reached through a symlink and the toplevel is its `realpath`
      (macOS `/var` vs `/private/var`).
- [x] `gate settings` in a temp repo with a toplevel config that sets
      `gate.timeout_seconds` and a lower-case `gate.severity` exits 0 and
      prints the configured timeout and the upper-cased severity; with
      `ROAST_GATE_TIMEOUT` / `ROAST_GATE_SEVERITY` set in `io.env` the
      output is unchanged.
- [x] `gate settings` with no `gate` section prints 180 and `HIGH`.
- [x] `gate settings` with no config exits 2; no user-level config
      directory is read even when one exists under the isolated `HOME`.
- [x] `gate settings` exits 2 for `gate.severity: "SEVERE"`,
      `gate.timeout_seconds: -1`, and `gate.offer: "no"`.
- [x] JSONC comments and a trailing comma after the last property load.
- [x] `loadConfig` rejects: unknown top-level field, unknown profile field
      (`base_url`), missing / zero / future / string `version`, literal
      `api_key` (also beside `api_key_env`), an `upload` section, a
      trailing document, a non-object, YAML text, and a missing file.
- [x] Keys match exactly: `"Version": 1` and a profile `"Model"` are
      unknown fields; a duplicate key keeps the last value; a profile
      named `__proto__` loads as an ordinary profile.
- [x] `null` fields act as unset; `max_output_tokens: 0` normalizes to
      32768 and `-1` is rejected; author-route keys `" Gemini "` and
      `google` are rejected as duplicates.
- [x] Integer fields reject the lexemes `1.0` and `1e3` and accept `1`.
- [x] `confidence_floor` and `quick_confidence_floor` accept 0, 0.5, 1 and
      reject 1.5 and -0.1.
- [x] A string value containing a lone surrogate (as a JSON escape) is
      rejected.
- [x] Session header: a valid value is kept; too long, bad characters,
      and every reserved name in any letter case are rejected.
- [x] Limits: `max_diff_bytes: 0`, `max_attempts: 0`,
      `max_total_tokens: -1`, `request_timeout: "later"`,
      `deadline: "-1s"`, and an unknown limit key are rejected.
- [x] `promptPath` resolves a relative override against the config
      file's directory and leaves an absolute one unchanged.
- [x] `renderProjectSchema()` parsed deep-equals the committed
      `roast.schema.json`.
- [x] Every example config used by the tests validates against the
      generated JSON Schema.
- [x] `npm run schema` rewrites `roast.schema.json` only when the content
      differs; `npm run build` runs it first.
- [x] Bundle smoke test: `node dist/cli.js gate settings` in a temp repo
      with a commented toplevel config exits 0 and prints the configured
      values (bundled `jsonc-parser` and `zod` work).
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
      the Go build and `go test ./...` still pass (including
      `TestSchemaMatchesConfigStruct` against the regenerated schema).
