# Area 14: `doctor`, `init`, `skill`

## 1. Purpose

Three setup and diagnostic commands that sit around a review:

- `roast doctor` checks the project config, each role's inference
  profile and credential, whether the project config is trusted, the
  configured inference routes (only when trusted), the Git repository and
  gate, stored credential files, and the user-level agent skill installs.
  It prints one result per check and fails when any check fails.
- `roast init` writes a starter project config (`.roast.json`) in the
  working directory, places the finder and verifier models on built-in
  providers, adds the run-record directory to the toplevel `.gitignore`,
  and on a terminal offers to log in to each built-in provider that has no
  credential yet.
- `roast skill install|status` installs or inspects Roast's bundled agent
  skill (`SKILL.md`) in the project's or the user's agent skill
  directories.

Vocabulary follows `CONTEXT.md`: finder, verifier, role, inference
profile, project config, trusted project config, credential, built-in
provider, stored credential, gate.

## 2. Behavior contract

### 2.1 Shared CLI conventions used here

- Exit codes (owned by the CLI core area): `0` clean, `2` usage error,
  `4` any other error (Go's `ExitPartial`). A plain (non-usage) error from
  these commands exits `4`. Errors print to stderr as `roast: <message>`,
  or as the JSON error object when `--error-format json` is set (CLI core
  area). Positional arguments to any of these commands are a usage error.
- CLI messages in this area say bare `roast` in some hints (for example
  `run \`roast skill install --global\``) and `npx roast` in others; keep
  each message's spelling as listed below (AGENTS.md: CLI messages are
  code, not docs).
- "Git toplevel" is resolved from the process working directory with the
  scope area's `gitRoot(".")` (`git rev-parse --show-toplevel`). Its error
  message is the scope area's.

### 2.2 `roast doctor`

Flags:

- `--config <path>` (string, default `""`): project config path; the
  default is the nearest `.roast.json` up to the Git toplevel.
- `--json` (bool, default false): emit a JSON array instead of text
  lines.

#### Result type

Every check yields one result:

```ts
type DoctorStatus = 'pass'|'warn'|'fail'
interface DoctorResult {
    name:string    // check id, e.g. 'finder-credential'
    status:DoctorStatus
    detail:string  // human-readable; never contains a credential value
}
```

#### Output

- Text (default): one line per result, in order:
  `${STATUS.padEnd(5)} ${name.padEnd(18)} ${detail}\n` where `STATUS` is
  the status upper-cased (`PASS`, `WARN`, `FAIL`). Go uses
  `%-5s %-18s %s`; names longer than 18 characters are not truncated.
- `--json`: the full array, `JSON.stringify(results, null, 2)` followed
  by `\n` (Go `json.Encoder` with two-space indent). Keys in order
  `name`, `status`, `detail`. Example:

```json
[
  {
    "name": "build",
    "status": "pass",
    "detail": "2.0.0 (abc1234, 2026-11-18)"
  },
  {
    "name": "config-file",
    "status": "pass",
    "detail": "/repo/.roast.json"
  }
]
```

- Output is always written in full first. Then, if any result has status
  `fail`, the command returns the plain error
  `one or more doctor checks failed` (exit `4`). Warnings never fail.
- No detail may contain an API key value (tests assert the secret string
  is absent from the whole stdout).

#### Check order

Checks run sequentially in exactly this order:

1. `build`
2. `config-file`
3. `config`
4. `config-trust`
5. For role `finder`, then role `verifier`: `<role>-credential`,
   `<role>-profile`, `<role>-endpoint`, `<role>-roundtrip`
6. Local checks: `git`, `git-gate`, `project-credentials`,
   `user-credentials`, `proxy-env`, then one `<harness>-skill` per
   user-level skill target (or a single `agent-skills`).

Early exits: if `config-file` or `config` fails, steps after it up to 5
are skipped and the local checks (6) still run. Within step 5 the rules
below decide which per-role checks appear.

#### `build`

- Uses the shared build info (CLI core area). esbuild injects version,
  commit, and build date through `define` at build time; running from
  source reports version `dev`, so the development-build warning below
  still applies. Its one-line string, Go `buildinfo.String()`, is
  `"<v> (commit <c>)"` when the version is the sentinel `dev` or the
  date is unknown, else `"<v> (<commit>, <date>)"`.
- `warn` with detail `<string>; development build` when the version is the
  development sentinel `dev`; otherwise `pass` with detail `<string>`.

#### `config-file`

- With `--config <path>`: that path is used as given (no existence check
  here; a missing file fails the `config` check). `pass`, detail = path.
- Without `--config`: search with the config area's `find(cwd, stop)`,
  where `stop` is the Git toplevel of cwd, or cwd itself outside a
  repository.
  - Search error -> `fail`, detail = error message.
  - Nothing found -> `fail`, detail = the shared "no project config"
    message: `no project config (.roast.json) found between here and the
    Git toplevel; run \`npx roast init\` to create one`.
  - Found -> `pass`, detail = the absolute path.

#### `config`

- Load with the config area's `load(path)`. Error -> `fail`, detail =
  error message.
- Success -> `pass`, detail `schema version <version>` (always
  `schema version 1`).
- The loaded config gets stored credentials attached
  (`withStoredCredentials`, credentials area) before any role resolves,
  exactly as `review` does.

#### `config-trust`

Uses the trust area. Returns the result and a boolean `trusted` that gates
the endpoint probes.

Conditions, in order (status, detail in equivalent wording, trusted):

1. Projection does not require approval: `pass`,
   `no approval required (default provider endpoints and key variables
   only)`, trusted.
2. Approval required, cwd not in a Git repository: `fail`,
   `approval required but not granted: not inside a Git repository`,
   not trusted.
3. Approval required, approvals file unreadable: `fail`,
   `approval required; could not read approvals: <err>`, not trusted.
4. Approval required, not approved: `fail`,
   `approval required and not granted; endpoint probes skipped; run
   \`npx roast trust\``, not trusted.
   If the approvals file holds a version 1 (Go-era) record for this
   clone, the detail instead says the config was approved by an older
   Roast and names `npx roast trust`, e.g. `approval required; approved
   by an older Roast; endpoint probes skipped; run \`npx roast trust\``
   (still `fail`, not trusted).
5. Approval required and approved: `pass`,
   `approval required and granted for this clone`, trusted.

The approval lookup uses the Git toplevel of the process cwd and the hash
of the config's trust projection (trust area). Tests rely on the details
containing `not granted`, `npx roast trust`, and `granted` respectively;
the older-Roast case contains `older Roast` and `npx roast trust`.

#### `proxy-env`

Local check, no network. Node's `fetch` ignores proxy variables unless
`NODE_USE_ENV_PROXY=1` is set (spec.md, cross-cutting "Network").

- `warn` when `HTTPS_PROXY` or `https_proxy` is set to a non-empty value
  and `NODE_USE_ENV_PROXY` is not `1`. Detail: `HTTPS_PROXY is set but
  NODE_USE_ENV_PROXY is not; Node ignores proxy variables unless
  NODE_USE_ENV_PROXY=1` (naming whichever variable is set; the proxy
  URL is never printed, since it may embed credentials).
- Otherwise `pass`: `no proxy configured` when neither variable is set,
  or `proxy variables honored (NODE_USE_ENV_PROXY=1)`.
- Reads the injected `ctx.env`, not `process.env`. Warnings never fail.

#### Per-role checks (`finder`, then `verifier`)

For each role name:

1. Resolve the role (config area `resolveRole`). Error -> one result
   `<role>-profile` `fail` with the error message; no other checks for
   this role.
2. `<role>-credential`: detail = the credential source description
   (config area, `CredentialSource.String()`):
   - role env: `<VAR> (role override)`
   - profile env: `<VAR> (profile api_key_env)`
   - provider env: `<VAR> (ambient provider key)`
   - stored: `stored <scope> credential for <provider>`
   - none, withheld: `none; <VAR> is set but is sent only to its
     provider's default endpoint`
   - none: `none`

   Status `pass`, or `fail` when the resolved API key is empty after
   trimming whitespace.
3. Validate the role (config area `validateRole`: model set, not a
   placeholder, key present, endpoint/protocol/max output tokens valid).
   Error -> `<role>-profile` `fail` with the error message; skip 4 to 6.
4. `<role>-profile` `pass`, detail
   `<profile>: <model> via <protocol> at <baseURL> with credential
   <credential description>`, plus `, session header <name>` when the
   profile sets a session header.
5. If `trusted` is false, stop here for this role (probing would send the
   credential to an endpoint this clone has not approved; no request is
   made at all).
6. `<role>-endpoint`, then `<role>-roundtrip` (both always run when
   trusted; a failed endpoint check does not skip the roundtrip).

#### `<role>-endpoint` (models listing probe)

- URL: `baseURL` with trailing `/` characters removed, plus `/models`.
  If it does not parse as an absolute request URI -> `fail`,
  `invalid models endpoint: <err>`.
- `GET` with a 5 second timeout (per request; Go also gives the client a
  5 second timeout). Headers: for protocol `anthropic`,
  `x-api-key: <key>` and `anthropic-version: 2023-06-01`; for every other
  protocol, `Authorization: Bearer <key>`. No session header, no other
  headers.
- Read and discard at most 32 KiB of the body.
- Results:
  - transport error -> `fail`, `GET <url>: <err>`
  - 2xx -> `pass`, `GET <url>: HTTP <status>` (Go prints the status line,
    e.g. `200 OK`)
  - 401 or 403 -> `fail`, `credential rejected by <url>: HTTP <status>`
  - >= 500 -> `fail`, `<url> returned HTTP <status>`
  - anything else (e.g. 404, 3xx, 429) -> `warn`,
    `endpoint is reachable but model listing returned HTTP <status>`

#### `<role>-roundtrip` (two-turn tool probe)

Exercises what a review relies on: a tool call, its result replayed on the
next request, and a final submission on the reserved wrap-up turn, all
under automatic tool choice with an unchanged conversation prefix. A
single-call probe passes on routes that then fail every review.

- Max output tokens: the role's value if in `1..512`, else `512`.
- Overall timeout 35 seconds (two requests of at most 15 s plus setup).
- Build an LLM client (LLM area) with: role name, base URL, API key,
  model, protocol, max output tokens as above, the role's session header,
  `maxAttempts: 1`, `requestTimeout: 15s`. Construction error -> `fail`
  with the error message.
- Token: `roast-doctor-` + a fresh random string (Go `rand.Text()`, 26
  base32 characters, 128 bits).
- Tools:
  - `doctor_lookup`, description `Return the diagnostic token.`, schema
    `{"type":"object","properties":{},"additionalProperties":false}`.
    Running it records that it was called and returns `{"token":<token>}`.
  - `doctor_probe`, description `Return the diagnostic result.`, schema
    `{"type":"object","properties":{"ok":{"type":"boolean"},"token":
    {"type":"string"}},"required":["ok","token"],
    "additionalProperties":false}`. It is the final tool.
- Converse (LLM area agent loop) with system prompt
  `This is a connectivity check. Call doctor_lookup once, then call
  doctor_probe with ok=true and the token doctor_lookup returned.`, user
  message `Run the check now.`, tools `[doctor_lookup, doctor_probe]`,
  final tool `doctor_probe`, max turns `2`. Both strings are sent
  verbatim.
- Results:
  - auth error (LLM area `ErrAuth`) -> `fail`,
    `credential rejected by the configured inference route`
  - other error -> `fail`,
    `<protocol>/<model> two-turn tool probe failed: <err>`
  - `ok` false -> `fail`, `doctor_probe returned ok=false`
  - `doctor_lookup` never ran, or returned token differs -> `fail`,
    `doctor_probe did not return the token from doctor_lookup; the tool
    result did not round-trip` (must name `doctor_lookup`)
  - otherwise `pass`, `<model> via <protocol> (two-turn tool loop)`
- A conforming fake therefore sees exactly two requests per role. The
  probe must work with servers that reject forced tool choice and reject
  a follow-up whose tool list or opening messages differ from the first
  request (LLM area invariants; doctor only chooses the options above).

#### `git`, `git-gate`

- cwd not in a Git repository -> one result `git` `warn`,
  `not inside a Git repository`; no `git-gate` result.
- Otherwise `git` `pass`, detail = toplevel path. Then inspect the gate
  (gate area `inspect(repo)`):
  - inspect error -> `git-gate` `warn`, error message
  - status stale, or decision is enabled but the gate is not active ->
    `warn`, detail = gate area `summary(status)`
  - otherwise `pass`, detail = `summary(status)`

#### `project-credentials`, `user-credentials`

For scope `project` then `user` (credentials area paths:
project = `<git-common-dir>/roast/credentials.json`, user =
`$XDG_CONFIG_HOME/roast/credentials.json` or
`~/.config/roast/credentials.json`):

- Path resolution fails (outside a repository; no home) -> no result.
- `lstat` says the file does not exist -> no result.
- credentials `loadCredentials(path)` error -> `<scope>-credentials`
  `fail`, error message
  (never contains the key).
- Otherwise `pass`, detail `<path> (none stored)` when empty, or
  `<path> (<p1>, <p2>)` with provider names sorted ascending and joined by
  `, `.

These run even when env credentials shadow the file, and even when the
config failed to load.

#### Skill checks

Uses user-level skill targets only (`installationTargets('', '')`, see
2.4), even inside a project.

- Target resolution error (no home) -> one result `agent-skills` `warn`,
  error message.
- Per target, name `<harness>-skill` (`agents-skill`, `claude-skill`,
  `polytoken-skill`):
  - inspect error -> `warn`, error message
  - `not_installed` -> `warn`,
    `not installed; run \`roast skill install --global\``
  - `stale` -> `warn`, `stale; run \`roast skill install --global --force\``
  - `symlink` -> `pass`, `<path> (development symlink)`
  - `up_to_date` -> `pass`, `<path>`

### 2.3 `roast init`

Flags:

- `--finder-model <id>` (string, default `""`): finder model ID, a bare
  OpenAI or Anthropic ID or `<vendor>/<model>` for OpenRouter; the ID
  picks the provider. Empty -> placeholder.
- `--verifier-model <id>` (string, default `""`): same rules for the
  verifier.
- `--no-login` (bool, default false): do not offer to log in.

Help text (long): writes a starter `.roast.json` in the working
directory, then adds `/.roast/` to the toplevel `.gitignore`; never
overwrites an existing file; on a terminal offers to log in to each
built-in provider the config uses that has no credential yet.

#### Sequence

1. Resolve the Git toplevel of cwd. Failure -> usage error (exit 2) with
   the Git error message. Nothing is written.
2. Build the starter body (`starter(finderModel, verifierModel)`, 2.3.1).
   An unplaceable model -> usage error `--<role>-model: <message>` (role
   `finder` or `verifier`; finder is checked first). Nothing is written.
   Other errors -> plain error.
3. Create `<cwd>/.roast.json` exclusively (`O_CREAT|O_EXCL|O_WRONLY`,
   mode `0644`; Node flag `'wx'`). The file goes in the working
   directory, not the toplevel.
   - Exists -> usage error
     `<path> already exists; edit it, or remove it to start over`. The
     existing file is untouched.
   - Other create error -> plain error `create <path>: <err>`; write and
     close errors -> `write <path>: <err>`, `close <path>: <err>`.
4. Print `wrote <path>\n` to stdout (absolute path).
5. Ensure the run-record directory is ignored: the ignore area's
   `ensureStateIgnored(toplevel)` appends `/.roast/` to
   `<toplevel>/.gitignore` unless an equivalent entry exists (creating
   the file, terminating an unterminated last line). If it changed the
   file, print `added /.roast/ to <gitignore path>\n` to stdout. An error
   here is a plain error (exit 4) although the config is already written.
6. Unless `--no-login`, run the login offer (2.3.3). Nothing in it
   affects the exit code.
7. Exit 0.

#### 2.3.1 Placing models (`placeModel`)

Input is trimmed of surrounding whitespace first (`Starter` trims both
models; an all-whitespace flag counts as empty).

Two spelling patterns:

```ts
// bare ID served by the OpenAI and Anthropic default endpoints
const STARTER_MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/
// OpenRouter <vendor>/<model>[:<variant>]
const OPENROUTER_MODEL_ID =
    /^[a-z0-9][a-z0-9._-]*\/([a-z0-9][a-z0-9._-]*)(:[a-z0-9][a-z0-9._-]*)?$/
```

`placeModel(model)` returns a built-in provider name or "unplaceable":

1. If `OPENROUTER_MODEL_ID` matches: unplaceable when the variant group is
   exactly `:api`, or when the model part (group 1) is a family name
   (below). Otherwise `openrouter`.
2. Else if `STARTER_MODEL_ID` does not match: unplaceable (uppercase,
   whitespace, `[1m]`, `@`, `:` suffixes, extra slashes, empty parts).
3. Else `family = inferFamily(model)` (config area). Unplaceable when
   `family` is not a built-in provider name (`openai`, `anthropic`,
   `openrouter`; `inferFamily` never returns `openrouter` for a bare ID)
   or when the model is itself a family name. Otherwise `family`.

`inferFamily` rules relevant here (config area owns it): lower-case and
trim; a `<prefix>/` where prefix is one of `anthropic openai google gemini
mistral xai cohere deepseek` returns that family (`gemini` -> `google`);
otherwise any `<x>/` prefix is dropped; then `:api` and `[1m]` suffixes
are dropped; then `anthropic` or `claude-*` -> `anthropic`; `openai`,
`gpt-*`, `codex-*`, `chatgpt-*`, or a prefix `o1`, `o3`, `o4` ->
`openai`; `google`, `gemini`, `gemini-*` -> `google`; `mistral`,
`mistral-*`, `codestral-*` -> `mistral`; `xai`, `grok-*` -> `xai`;
`cohere`, `command-*` -> `cohere`; `deepseek`, `deepseek-*` ->
`deepseek`; else `""`.

A *family name* is a string whose `inferFamily` is non-empty and equals
its canonical family (`gemini` -> `google`, every other name maps to
itself). In practice: `anthropic`, `openai`, `google`, `gemini`,
`mistral`, `xai`, `cohere`, `deepseek`.

Unplaceable error message (equivalent wording; `Model` is the trimmed
model):

```
<role> model "<model>" is not a model ID init can place: use a bare
OpenAI or Anthropic model ID (claude-opus-5-5), or OpenRouter's
<vendor>/<model> form (anthropic/claude-opus-5-5). For another provider,
edit inference_profiles in .roast.json
```

(One line in the real message; wrapped here. The model is JSON-quoted as
Go `%q`.)

#### 2.3.2 Starter config (`starter`)

Provider assignment:

1. Defaults: finder on `openai`, verifier on `anthropic`.
2. Each non-empty model is placed (2.3.1); finder first. Unplaceable ->
   `UnplaceableModelError{role, model}`.
3. Exactly one model given: the empty (placeholder) role goes to
   `otherProvider(placed)`: `openrouter` -> `openrouter` (the user chose a
   gateway); `openai` -> `anthropic`; anything else -> `openai`.
4. Empty models become placeholders `<finder-model>` and
   `<verifier-model>`. A placeholder is any trimmed model longer than 2
   characters that starts with `<` and ends with `>`; `validateRole`
   rejects it with an actionable message before any request.

Profile naming:

- Profile names are the provider names.
- If both roles are on the same provider with different models, they are
  `<provider>-finder` and `<provider>-verifier`.
- If both roles are on the same provider with the same model, one
  profile (named after the provider) serves both roles.

Each profile is rendered on the built-in provider's endpoint with its
first protocol and standard key variable (config area provider table), so
the starter needs no trust approval:

- `openai`: endpoint `https://api.openai.com/v1`, protocol
  `responses`, `api_key_env` `OPENAI_API_KEY`
- `anthropic`: endpoint `https://api.anthropic.com/v1`, protocol
  `anthropic`, `api_key_env` `ANTHROPIC_API_KEY`
- `openrouter`: endpoint `https://openrouter.ai/api/v1`, protocol
  `chat`, `api_key_env` `OPENROUTER_API_KEY`

The `$schema` value is the constant
`./node_modules/@substrate-system/roast/roast.schema.json`.

All string values are rendered as JSON string literals *without* HTML
escaping (so `<finder-model>` stays literal; `JSON.stringify` already
does this).

The exact template. `__SCHEMA__`, `__FINDER_PROFILE__` and
`__VERIFIER_PROFILE__` are JSON string literals; `__PROFILES__` is the
rendered profiles joined with `",\n"` (finder's profile first, the
verifier's only when its name differs):

```jsonc
// Roast project config. Commit this file. It holds every setting except
// credentials, which come from "npx roast login" or environment variables.
{
  "$schema": __SCHEMA__,
  "version": 1,

  // Each profile names a model, its endpoint and protocol, and the
  // environment variable that holds its credential. These use built-in
  // provider endpoints with the standard key variables, so they need no
  // `npx roast trust` approval.
  "inference_profiles": {
__PROFILES__
  },

  // The finder proposes defects; the verifier checks each one. Using
  // different model families keeps the two independent.
  "roles": {
    "finder": {"profile": __FINDER_PROFILE__},
    "verifier": {"profile": __VERIFIER_PROFILE__}
  },

  // Review defaults.
  // "review": {
  //   "confidence_floor": 0.6,
  //   "quick_confidence_floor": 0.8,
  //   "excludes": [],
  //   "snapshot": true
  // },

  // Per-review limits. Durations are strings such as "90s" or "10m".
  // "limits": {
  //   "deadline": "10m",
  //   "request_timeout": "10m",
  //   "max_total_tokens": 3000000,
  //   "max_diff_bytes": 1000000,
  //   "max_prompt_bytes": 8000000,
  //   "max_file_ctx_bytes": 400000,
  //   "max_attempts": 4,
  //   "max_verified": 25
  // },

  // The pre-commit gate.
  // "gate": {
  //   "timeout_seconds": 180,
  //   "severity": "HIGH",
  //   "offer": true
  // },
}
```

The file ends with a single `\n` after the final `}`. Note the trailing
comma after the `roles` object: the config loader must accept trailing
commas (`jsonc-parser` `allowTrailingComma: true`; Go's hujson does).

One rendered profile (four-space indent for the name, six for fields):

```
    "openai": {
      "endpoint": "https://api.openai.com/v1",
      "protocol": "responses",
      "api_key_env": "OPENAI_API_KEY",
      "model": "<finder-model>"
    }
```

The commented-out values must track the defaults in the CLI core and gate
areas: confidence floor `0.6`, quick confidence floor `0.8`, snapshot on,
deadline `10m`, request timeout `10m`, max total tokens `3000000`, max
diff bytes `1000000`, max prompt bytes `8000000`, max file context bytes
`400000`, max attempts `4`, max verified `25`, gate timeout `180`, gate
severity `HIGH`, gate offer `true`. Define these once and render the
template from the same constants the CLI uses, or keep a test that pins
them together.

Placements pinned by the Go tests (finder model, verifier model ->
providers, profile count):

- (empty), (empty) -> finder on openai, verifier on anthropic; 2 profiles
  (`openai`, `anthropic`)
- `claude-opus-5-5`, `gpt-5-codex` -> finder on anthropic, verifier on openai; 2
  profiles
- `gpt-5`, `claude-sonnet-5-5` -> finder on openai, verifier on anthropic; 2
  profiles
- `claude-opus-5-5`, (empty) -> finder on anthropic, verifier on openai; 2
  profiles
- (empty), `gpt-5` -> finder on anthropic, verifier on openai; 2 profiles
- `codex-mini-latest`, `claude-opus-5-5` -> finder on openai, verifier on
  anthropic; 2 profiles
- `claude-opus-5-5`, `claude-sonnet-5-5` -> finder on anthropic, verifier on
  anthropic; 2 profiles (`anthropic-finder`, `anthropic-verifier`)
- `gpt-5`, `gpt-5` -> finder on openai, verifier on openai; 1 profile
- `anthropic/claude-opus-5-5`, `openai/gpt-6.1-terra` -> finder on openrouter,
  verifier on openrouter; 2 profiles (`openrouter-finder`,
  `openrouter-verifier`)
- `meta-llama/llama-4:free`, `anthropic/claude-opus-5-5` -> finder on
  openrouter, verifier on openrouter; 2 profiles
- `claude-opus-5-5`, `openai/gpt-6.1-terra` -> finder on anthropic, verifier on
  openrouter; 2 profiles
- `anthropic/claude-opus-5-5`, `gpt-5` -> finder on openrouter, verifier on
  openai; 2 profiles
- `anthropic/claude-opus-5-5`, (empty) -> finder on openrouter, verifier on
  openrouter; 2 profiles
- (empty), `openai/gpt-6.1-terra` -> finder on openrouter, verifier on
  openrouter; 2 profiles

Unplaceable, as either role: `gemini-2.5-pro`, `some-model`, `openai`,
`claude-opus-5-5[1m]`, `openai:api`, `Claude-Opus-5-5`, `claude-x@2024`,
`gpt-5 mini`, `Anthropic/claude-opus-5-5`, `anthropic/Claude-Opus-5-5`,
`anthropic/ claude-opus-5-5`, `anthropic/claude-opus-5-5[1m]`,
`openai/gpt-5:api`, `anthropic/anthropic`, `google/gemini`, `openai/`,
`/gpt-5`, `openai/gpt-5/mini`, `meta-llama/llama-4:`.

#### 2.3.3 Login offer

Runs after the config is written. Every failure is reported on stderr
and skipped; none fails `init`.

1. Load the written config (config area). Error -> stderr
   `skipping login: <err>`, return.
2. Attach stored credentials, then compute `providersNeedingLogin(cfg)`
   (login area, shared with `roast login` with no argument): for each
   role name in the config's `roles`, sorted ascending, resolve it (error
   -> usage error, reported here as `skipping login: <err>`); skip roles
   with a non-empty API key; take the built-in provider at the role's
   endpoint and protocol (`providerAt`); skip non-built-in and
   already-listed providers. Order therefore follows `finder`, then
   `verifier`.
3. Empty list -> return silently.
4. If stdin and stderr are not both terminals (the swappable
   `interactiveTerminals(stdin, stderr)`), print to stderr
   `run \`npx roast login\` to store an API key for each provider the
   config uses` and return. No prompt, no key validation, no browser.
5. Resolve the project-scope credentials path (login area
   `loginPath(global=false)`). Error -> `skipping login: <err>`, return.
6. Create **one** buffered line reader over stdin and share it across
   every prompt and every `loginProvider` call (buffered answers that
   tests feed as one string must survive between prompts).
7. For each provider: prompt on stderr `Log in to <name> now? [Y/n] `
   (`promptYesDefault`): the trimmed, lower-cased answer `""`, `y`, `yes`
   means yes; anything else means no; end of input with an empty answer
   means no; a read error -> `skipping login: <err>`, return.
   - no -> next provider.
   - yes -> `loginProvider(provider, defaultLoginFlags, projectCredsPath,
     'project', stdin, sharedReader, stdout, stderr)` (login area: paste
     login with key validation and retries for OpenAI/Anthropic, PKCE
     browser login for OpenRouter). Error -> stderr
     `login to <name> failed: <err>`, continue with the next provider.

Keys are always stored in project scope by `init`.

### 2.4 `roast skill`

`roast skill` with no subcommand prints help and exits 0. Subcommands:

| Command | Flags |
|---|---|
| `skill install` | `--dir <parent>`, `--global`, `--force` |
| `skill status` | `--dir <parent>`, `--global` |

- `--dir`: operate only on `<parent>/roast` (harness `custom`); wins over
  `--global`.
- `--global`: the user-level directories instead of the project.
- `--force` (install only): overwrite installed files that differ.

#### Installation targets

```ts
interface InstallationTarget {
    harness:'custom'|'agents'|'claude'|'polytoken'
    parent:string   // the skills directory
    path:string     // join(parent, 'roast')
}
```

CLI resolution (`skillTargets(dir, global)`):

1. `dir` non-empty, or `global` -> `installationTargets(dir, '')`.
2. Otherwise resolve the Git toplevel of cwd. Failure -> usage error
   `<git error>; run inside a project or pass --global` (exit 2).
   Then `installationTargets('', toplevel)`.

`installationTargets(parent, projectRoot)`:

1. `parent` non-empty -> `[{harness:'custom', parent, path:join(parent,
   'roast')}]`. No home lookup, no dedupe.
2. Resolve home: Go `os.UserHomeDir()`, i.e. `$HOME`; empty or unset ->
   error `resolve user home: <reason>` (plain error, exit 4; also in
   project mode, since home is resolved before the project branch).
3. `claudeRoot = configuredRoot(home, env.CLAUDE_CONFIG_DIR, '.claude')`.
   `claudePresent` is true when `CLAUDE_CONFIG_DIR` is non-empty, or
   `claudeRoot` is an existing directory, or an executable `claude` is
   found on `PATH`.
4. `projectRoot` non-empty (project targets):
   - `agents`: `<projectRoot>/.agents/skills` (always)
   - `claude`: `<projectRoot>/.claude/skills` when `claudePresent` or
     `<projectRoot>/.claude` is an existing directory.
5. Otherwise (user-level targets):
   - `agents`: `<home>/.agents/skills` (always)
   - `claude`: `<claudeRoot>/skills` when `claudePresent`
   - `polytoken`: `<configRoot>/polytoken/skills`, where
     `configRoot = configuredRoot(home, env.XDG_CONFIG_HOME, '.config')`,
     when `<configRoot>/polytoken` is an existing directory or an
     executable `polytoken` is found on `PATH`.
6. Finalize (steps 4 and 5): clean each parent path (`path.normalize`
   without trailing slash), set `path = join(parent, 'roast')`, drop any
   target whose `path` equals an earlier one (first wins). Order is as
   listed.

`configuredRoot(home, override, fallback)`: empty override ->
`join(home, fallback)`; `~` -> `home`; prefix `~/` ->
`join(home, rest)`; anything else -> the cleaned override (a relative
override stays relative).

"Existing directory" follows symlinks (`stat`, not `lstat`).

#### Skill assets

The bundled skill is a directory of files, rooted at
`src/skill/assets/roast/` (today only `SKILL.md`). Each file has a
relative path (`SKILL.md`) and exact bytes. All comparisons are
byte-for-byte.

#### `inspect(target)` -> `{state, path, stale}`

- `lstat(target)` ENOENT -> `not_installed`.
- Other `lstat` error -> error `stat skill directory <target>: <err>`.
- `target` is a symlink -> `symlink` (a development checkout; its
  contents are not compared).
- Not a directory -> error `skill path <target> is not a directory`.
- Otherwise, for every bundled file, read `join(target, rel)`; a read
  error or differing bytes adds `rel` to `stale`. `stale` sorted
  ascending. Non-empty -> `stale`, else `up_to_date`. Extra files in the
  target are ignored. An existing empty directory is `stale`.

States serialize as `not_installed`, `symlink`, `up_to_date`, `stale`.

#### `install(target, force)`

1. `inspect`. `symlink` or `up_to_date` -> return it unchanged (no
   writes). `stale` without `force` -> error
   `skill files differ; re-run with --force to overwrite`.
2. `mkdir -p target` (mode `0755`).
3. For each bundled file, sorted by relative path: if the destination
   exists and is a symlink -> error `refusing to overwrite symlink <dest>`
   (files before it may already be written); another `lstat` error ->
   error; `mkdir -p` its directory (`0755`); write the bytes (mode
   `0644`, replacing an existing regular file).
4. Return `inspect(target)` again.

#### `skill install` command

1. Resolve targets (above).
2. Inspect every target first. An inspect error -> that error (exit 4).
   A `stale` target without `--force` -> plain error (exit 4)
   `<harness> skill files differ (<stale joined by ", ">); re-run with
   --force to overwrite`, before anything is written to any target.
3. For each target in order: `install(path, force)`; error -> return it.
   Print one tab-separated line to stdout based on the state *before*
   installing:
   - `symlink` -> `<harness>\tsymlink (development install), left
     unchanged\t<path>`
   - `up_to_date` -> `<harness>\talready up to date\t<path>`
   - otherwise -> `<harness>\tinstalled (<state after>)\t<path>` (state
     after is normally `up_to_date`)

Install is idempotent: a second run writes nothing and reports
`already up to date`.

#### `skill status` command

For each target in order: inspect (error -> return it, exit 4) and print
`<harness>\t<state>\t<path>`, plus `\t<stale joined by ",">` (no space)
when `stale` is non-empty, then `\n`. Exit 0 regardless of state.

#### `SKILL.md` contract

`SKILL.md` moves over unchanged (byte-identical) as a text asset. It is
an Agent Skills file: YAML front matter with `name: roast` and a
`description` that tells an agent when to run Roast (after a coherent,
non-trivial change, before declaring work complete, or when asked), then
sections on setup and the trust boundary, when to review, invocations,
and handling findings. It writes every invocation as `npx roast ...`
and describes the install locations (project `.agents/skills` at the Git
toplevel, `.claude/skills` when Claude Code is in use, `--global` for the
user-level Agent Skills, Claude Code and Polytoken locations, and
`npx roast skill status`). It must be updated whenever target resolution
changes. Because `inspect` compares bytes, any change to it makes every
existing install `stale` until reinstalled with `--force`.

## 3. TypeScript module design

Layout follows the Go packages: CLI command code under `src/cli/`, the
starter under `src/config/`, the skill package under `src/skill/`.

### `src/skill/skill.ts`

```ts
export type SkillState = 'not_installed'|'symlink'|'up_to_date'|'stale'
export interface SkillStatus {
    state:SkillState
    path:string
    stale:string[]
}
export type Harness = 'custom'|'agents'|'claude'|'polytoken'
export interface InstallationTarget {
    harness:Harness
    parent:string
    path:string
}
export interface SkillEnv {
    env:NodeJS.ProcessEnv   // HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME,
                            // PATH
}
export function installationTargets (
    parent:string,
    projectRoot:string,
    opts:SkillEnv
):Promise<InstallationTarget[]>
export function inspect (target:string):Promise<SkillStatus>
export function install (
    target:string,
    force:boolean
):Promise<SkillStatus>
// swappable for tests, like interactiveTerminals
export let lookPath:(name:string, env:NodeJS.ProcessEnv)=>Promise<boolean>
```

- `src/skill/assets.ts` exports `SKILL_FILES:ReadonlyMap<string,
  Uint8Array>` built from esbuild text-loader imports (one explicit
  import per file, since esbuild has no directory embed). Encode with
  `TextEncoder` (UTF-8); the source file must stay UTF-8 without BOM so
  bytes round-trip identically.
- `lookPath` walks `PATH` entries and checks for an executable regular
  file (`fs.access(X_OK)` plus `stat().isFile()`), mirroring Go's
  `exec.LookPath`.
- Home comes from `env.HOME` (not `os.homedir()`, which falls back to the
  password database) so tests can isolate it and an unset `HOME` is an
  error as in Go.

### `src/config/starter.ts`

```ts
export const SCHEMA_REF =
    './node_modules/@substrate-system/roast/roast.schema.json'
export const PLACEHOLDER_FINDER_MODEL = '<finder-model>'
export const PLACEHOLDER_VERIFIER_MODEL = '<verifier-model>'
export function isPlaceholderModel (model:string):boolean
export class UnplaceableModelError extends Error {
    role:'finder'|'verifier'
    model:string
}
export function placeModel (model:string):string|null
export function starter (finderModel:string, verifierModel:string):string
```

Depends on `src/config/` (`inferFamily`, `lookupProvider`, and the
defaults constants shared with `src/cli/`).

### `src/cli/doctor.ts`

```ts
export type DoctorStatus = 'pass'|'warn'|'fail'
export interface DoctorResult {
    name:string
    status:DoctorStatus
    detail:string
}
export function doctorChecks (
    configPath:string,
    ctx:CliContext,   // cwd, env, fetch, signal (CLI core area)
):Promise<DoctorResult[]>
export function doctorEndpointCheck (
    role:'finder'|'verifier',
    resolved:ResolvedRole,
    ctx:CliContext
):Promise<DoctorResult>
export function doctorRoundtripCheck (
    role:'finder'|'verifier',
    resolved:ResolvedRole,
    ctx:CliContext
):Promise<DoctorResult>
```

- The endpoint probe uses the swappable `fetch` from the CLI context
  (the equivalent of `redirectDefaultTransport`) with
  `AbortSignal.any([ctx.signal, AbortSignal.timeout(5000)])`; read the
  body through a reader and cancel after 32 KiB.
- The roundtrip uses the LLM area's client and agent loop with
  `AbortSignal.timeout(35_000)` combined with the command signal.
- Status text: Node `fetch` gives `status` and `statusText`; render
  `HTTP ${status} ${statusText}`.trim (statusText may be empty on HTTP/2).
- Depends on: config (`find`, `load`, `resolveRole`, `validateRole`,
  credential description, trust projection), credentials (paths, `load`,
  `withStoredCredentials`), trust (`approved`), scope (`gitRoot`), gate
  (`inspect`, `summary`, `active`), skill (`installationTargets`,
  `inspect`), llm (client, converse, `AuthError`), CLI core (build info,
  error/exit mapping).

### `src/cli/init.ts`

```ts
export function writeStarter (
    cwd:string,
    finderModel:string,
    verifierModel:string
):Promise<string>                 // path; throws UsageError / Error
export function offerLogin (
    path:string,
    io:CliIO                      // stdin, stdout, stderr, env, signal
):Promise<void>                   // never throws
```

Depends on: config (`load`, starter), ignore (`ensureStateIgnored`),
login (`providersNeedingLogin`, `loginProvider`, `loginPath`), terminal
(`interactiveTerminals`, `promptYesDefault`, shared line reader).

### `src/cli/skill.ts`

`skill` command group with `install` and `status`, and
`skillTargets(dir, global, ctx)` mapping flags onto
`installationTargets`.

## 4. Deliberate changes

- Trust hash v2 (decision 4): `config-trust` reports an approval written
  by the Go version as not granted (`fail`, probes skipped), since the
  trust area treats v1 approvals as absent. The detail says it was
  approved by an older Roast and names `npx roast trust`, as `review`
  does.
- New `proxy-env` check (spec.md, "Network"): warns when `HTTPS_PROXY`
  is set without `NODE_USE_ENV_PROXY=1`.
- Build info is injected by esbuild `define`; from source it is `dev`.
- Debug tracing (decision 5): `roast:doctor`, `roast:init`,
  `roast:skill` namespaces may log check names, statuses, target paths,
  and probe URLs, never keys, headers, prompts, or bodies.
- `completion` is dropped (decision 1); no effect here.

No other behavior changes.

## 5. Test plan

Highest seam is the in-process CLI `run(argv, io)` with a `node:http`
fake and swappable `fetch`, terminal detection, and browser opener.
Doctor tests that probe must chdir into a temp Git repo and approve the
config there (never in this checkout); doctor tests that expect a clean
exit isolate `HOME` and `XDG_CONFIG_HOME`. Skill tests isolate `HOME`,
`CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` and stub `lookPath` (do not clear
`PATH`; the CLI shells out to `git`). Assert on exit codes, JSON, files,
and requests, never on human text beyond the substrings listed.

### doctor

- Models endpoint probe sends `GET <base>/models` with the bearer key and
  passes on 2xx without echoing the key (`TestDoctorEndpointCheck`);
  check the `anthropic` header pair too. Unit seam on
  `doctorEndpointCheck`.
- `--json --config` emits a parseable array of at least 8 results, exit 0
  for an approved working config, credential detail
  `DOCTOR_KEY (profile api_key_env)`, no secret in stdout
  (`TestDoctorJSON`). CLI seam.
- A withheld ambient key: finder credential fails naming the withheld
  variable, finder profile fails with the not-sent message, verifier
  passes with its named key, and no endpoint receives the withheld key
  (`TestDoctorReportsWithheldAmbientCredential`).
- Roundtrip uses the configured protocol route (`/v1/responses`, two
  requests) (`TestDoctorRoundtripUsesConfiguredResponsesRoute`).
- Session header appears in the profile detail and is sent on probe
  requests (`TestDoctorReportsAndSendsSessionHeader`).
- Two-turn tool loop passes on `anthropic`, `chat`, `responses` against a
  fake that rejects forced tool choice and changed prefixes; exactly two
  requests (`TestDoctorRoundtripRunsTwoTurnToolLoop`).
- A model that skips `doctor_lookup` and guesses a token fails, detail
  names `doctor_lookup` (`TestDoctorRoundtripRequiresTheToolResult`).
- Proxy check: with `HTTPS_PROXY` (and separately `https_proxy`) set and
  `NODE_USE_ENV_PROXY` unset, `--json` contains `proxy-env` with status
  `warn` and exit 0; with `NODE_USE_ENV_PROXY=1` or no proxy variable it
  is `pass`; the proxy URL never appears in stdout. CLI seam with the
  env injected (`TestDoctorWarnsWhenProxyIsIgnored`, new).
- Version 1 trust record: seed a Go-era record for the clone; `config-trust`
  fails, exit 4, zero requests to the endpoint, detail contains
  `npx roast trust` (`TestDoctorReportsOlderRoastApproval`, new).
- Built-in-only config: `config-trust` pass with no approval required
  (`TestDoctorReportsNoApprovalRequired`).
- Custom endpoint: unapproved -> `config-trust` fail mentioning
  `not granted` and `npx roast trust`, non-zero exit, zero requests to the
  endpoint; after `trust --yes` -> pass, endpoint probed
  (`TestDoctorReportsApprovalRequiredAndState`).
- Stored credentials: project or user file reported with its scope
  (`TestDoctorReportsAStoredCredentialAndItsScope`); a broken file fails
  `<scope>-credentials` and the exit without leaking the key
  (`TestDoctorFailsABrokenCredentialsFile`); a usable project file passes
  and an absent user file is not reported
  (`TestDoctorReportsAUsableCredentialsFile`); other checks still run
  with a broken file
  (`TestDoctorRunsItsOtherChecksWithABrokenCredentialsFile`).
- New (not pinned in Go, worth adding): a run with any `fail` exits 4;
  warnings alone exit 0; a missing config yields `config-file` fail plus
  the local checks.

### init and starter

- Placement table and profile count, and different models never share a
  profile (`TestStarterPlacesEachRole`). Unit seam on `starter` parsed
  back through the config loader.
- Two OpenRouter models -> `openrouter-finder`, `openrouter-verifier`
  (`TestStarterNamesTwoOpenRouterProfilesByRole`); no models -> `openai`
  and `anthropic` (`TestStarterKeepsTheDefaultProfileNames`).
- Unplaceable list rejected as either role with the right role and model
  on the error (`TestStarterRejectsModelsItCannotPlace`).
- `init` writes a config whose models a review then uses against the fake
  provider with the right credentials
  (`TestInitWritesAConfigWhoseModelsAReviewUses`).
- Unplaceable flag -> usage error, nothing written
  (`TestInitRejectsAModelItCannotPlace`).
- Placeholder models make a review fail actionably before any request
  (`TestInitPlaceholderModelsFailAReviewActionably`).
- Existing config -> usage error, file unchanged
  (`TestInitRefusesToOverwriteAnExistingConfig`).
- `/.roast/` added to the toplevel `.gitignore`
  (`TestInitIgnoresTheStateDirectory`).
- `$schema` points at a `.json` inside
  `node_modules/@substrate-system/roast/`
  (`TestInitSchemaPointsIntoTheInstalledPackage`).
- Login offer on a simulated terminal: answers `y` + key for each of
  anthropic then openai store both keys in project scope only; `n` + `n`
  stores nothing, validates nothing, opens nothing
  (`TestInitOffersToLogInToEachProvider`).
- `--no-login` never offers (`TestInitNoLoginNeverOffersALogin`); no
  terminal never prompts (`TestInitWithoutATerminalNeverPrompts`).
- A failing login (three rejected keys) still exits 0 and stores nothing
  (`TestInitSucceedsWhenALoginFails`).
- Starter defaults agree with the CLI defaults (new: parse the
  commented-out blocks or render from shared constants).

### skill

- Install then inspect: `up_to_date`; edit a file -> `stale` listing it;
  install without force errors; with force restores
  (`TestInstallAndInspect`). Unit seam.
- A bundled path that is a symlink in the target is refused
  (`TestInstallRefusesEmbeddedPathSymlink`).
- A symlinked target is `symlink` and never modified
  (`TestInspectTreatsTargetSymlinkAsDevelopmentInstall`).
- Detected harnesses included, undetected skipped, `~` expansion
  (`TestInstallationTargetsIncludeDetectedHarnesses`,
  `TestInstallationTargetsSkipUndetectedHarnesses`,
  `TestConfiguredRootExpandsHome`).
- CLI `install --dir` then `status --dir` prints `custom\tup_to_date\t`
  (`TestSkillInstallAndStatusCommands`).
- From a subdirectory, install writes under the Git toplevel only, not
  home or the subdirectory
  (`TestSkillInstallFromSubdirectoryWritesToGitToplevel`).
- Status before and after a project install
  (`TestSkillStatusReportsProjectInstallAsCurrent`).
- Outside Git without `--global`/`--dir`: usage error for both
  subcommands (`TestSkillCommandsOutsideGitNeedGlobalOrDir`).
- `--global` writes only user-level directories and project status stays
  `not_installed` (`TestSkillGlobalUsesUserLevelDirectories`).
- `--dir` limits to one parent with and without `--global`
  (`TestSkillDirLimitsToOneParentWithAndWithoutGlobal`).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/cli/doctor.go`, `internal/cli/init.go`,
  `internal/cli/skill.go`, `internal/cli/config.go`
  (`projectConfigPath`, `errNoProjectConfig`), `internal/cli/prompt.go`
  (`promptYesDefault`, `interactiveTerminals`), `internal/cli/login.go`
  (`providersNeedingLogin`, `loginProvider`, `loginPath`),
  `internal/cli/ignore.go` (`ensureStateIgnored`), `internal/cli/cli.go`
  (exit codes, defaults).
- `internal/config/starter.go`, `internal/config/provider.go`,
  `internal/config/config.go` (`InferFamily`, `canonicalFamily`,
  `ValidateRole`, `CredentialSource.String`).
- `internal/skill/skill.go`, `internal/skill/assets/roast/SKILL.md`.
- `internal/gate/hook.go` (`Status.Active`, `Status.Summary`),
  `internal/buildinfo/buildinfo.go`.
- Tests: `internal/cli/doctor_test.go`, `doctor_probe_test.go`,
  `doctor_trust_test.go`, `stored_credentials_test.go` (doctor tests),
  `init_test.go`, `skill_test.go`; `internal/config/starter_test.go`;
  `internal/skill/skill_test.go`.

## 7. Resolved

1. Build info is injected by esbuild `define` (version, commit, date);
   from source it is `dev` and keeps the warning (spec.md, "Runtime").
2. `config-trust` says "approved by an older Roast" for a v1 record and
   names `npx roast trust` (spec.md, decision 4).
3. Doctor checks only user-level skill installs: Go parity, kept
   (spec.md, "Further Notes").
4. Hints say bare `roast skill install`: Go parity, kept (spec.md,
   "Further Notes").
5. `init` writes `.roast.json` in the working directory: Go parity, kept
   (spec.md, "Further Notes").
6. New `proxy-env` check warns when `HTTPS_PROXY`/`https_proxy` is set
   without `NODE_USE_ENV_PROXY=1` (spec.md, "Network").
7. Windows-specific behavior removed (spec.md, decision 2).
