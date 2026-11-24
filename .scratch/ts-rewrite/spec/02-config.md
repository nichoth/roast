# Area 02: Project config and built-in providers

## 1. Purpose

This area owns the **project config** (`.roast.json`) and the registry of
**built-in providers**. It:

1. Finds the project config nearest the working directory, searching
   upward no further than the Git toplevel.
2. Parses it as JSONC and validates every field (one zod schema is the
   source of truth; `roast.schema.json` is generated from it).
3. Applies defaults and normalizes values (profile protocol, output
   limit, author-route family names, confidence floors).
4. Resolves a **role** (finder or verifier) into a runtime-ready role:
   the **inference profile**'s model, endpoint, protocol, output limit,
   session header, and the **credential** picked from environment
   variables or a **stored credential**.
5. Re-binds the credential when command-line flags move a role to another
   endpoint or protocol.
6. Selects an alternate finder profile from the author's model family
   (author routes) and validates a resolved role before any model call.
7. Knows each built-in provider's endpoint, accepted protocols, standard
   key variable, key page, and login method.

Out of scope, referenced only: the trust projection and its hash (area
"trust and credentials"), the stored-credential file format and lookup
order within the store (same area), the `init` starter config and model
placement (area "doctor and init"), CLI flag parsing and the use of limits
during a review (area "CLI").

## 2. Behavior contract

### 2.1 Constants

| Name | Value |
| --- | --- |
| Config file name | `.roast.json` |
| Supported `version` | `1` |
| Default `max_output_tokens` | `32768` |
| Default `review.confidence_floor` | `0.6` |
| Default `review.quick_confidence_floor` | `0.8` |
| OpenAI default endpoint | `https://api.openai.com/v1` |
| Anthropic default endpoint | `https://api.anthropic.com/v1` |
| OpenRouter endpoint | `https://openrouter.ai/api/v1` |
| Max `session_header` length | 64 (characters; all are ASCII) |
| Default profile protocol | `responses` |

The defaults that the CLI applies to unset `limits`, `interactive`, and
`gate` settings live in the CLI and gate areas. For reference (they must
match the descriptions in the generated schema):

| Setting | Default | Notes |
| --- | --- | --- |
| `limits.deadline` | `10m` | `0s` disables |
| `limits.request_timeout` | `10m` | |
| `limits.max_total_tokens` | `3000000` | `0` disables |
| `limits.max_diff_bytes` | `1000000` | `200000` for `--quick` |
| `limits.max_prompt_bytes` | `8000000` | |
| `limits.max_file_ctx_bytes` | `400000` | `100000` for `--quick` |
| `limits.max_attempts` | `4` | includes the first attempt |
| `limits.max_verified` | `25` | |
| `interactive.min_files` | `4` | |
| `interactive.min_diff_lines` | `80` | |
| `gate.timeout_seconds` | `180` | `0` disables |
| `gate.severity` | `HIGH` | compared upper-cased |
| `gate.offer` | `true` | |
| `review.snapshot` | `true` | |

A config value overrides the default; a command-line flag (where one
exists) overrides the config for one invocation (`flag -> config ->
default`). The quick-mode defaults apply only when the config leaves the
limit unset.

### 2.2 Config discovery

`findConfig(start, stop)` returns the path of the nearest `.roast.json` at
or above `start`, never looking above `stop`, or `""` when there is none.
`stop` must be `start` or an ancestor of it.

Algorithm:

1. `dir = path.resolve(start)` (absolute, symlinks NOT resolved).
2. `stopCanonical = realpath(path.resolve(stop))`. A failure (for example
   `stop` does not exist) is an error `find project config: <cause>`.
3. Loop:
   1. `candidate = join(dir, ".roast.json")`. `stat` it (following
      symlinks). If it exists and is not a directory, return `candidate`
      (spelled through the non-canonical `dir`). A directory named
      `.roast.json` is skipped. A stat error other than "not found" (for
      example permission denied) is an error
      `find project config: <cause>`.
   2. `canonical = realpath(dir)`; failure is an error as above.
   3. If `canonical === stopCanonical`, or `dirname(dir) === dir` (the
      filesystem root), return `""`.
   4. `dir = dirname(dir)`.

The comparison uses canonical paths because on macOS a temp directory is
`/var/...` while `git rev-parse --show-toplevel` prints `/private/var/...`.
If `stop` is not an ancestor, the walk ends at the filesystem root.

CLI entry points (module `src/cli/config.ts` in the CLI area, specified
here because they are config behavior):

- `projectConfigPath(explicit)`: if `explicit` (the `--config` flag value)
  is non-empty, return it unchanged (no existence check; `loadConfig`
  reports a missing file). Otherwise `cwd = process.cwd()` (an error is
  `find project config: <cause>`), `stop` = Git toplevel of `cwd`
  (`git -C <cwd> rev-parse --show-toplevel`, trimmed); if that fails
  (not a repository, or `git` missing), `stop = cwd`. Return
  `findConfig(cwd, stop)`.
- `gateConfigPath(repo)`: `findConfig(repo, repo)`. The pre-commit hook
  runs from the Git toplevel without `--config`, so only a toplevel
  `.roast.json` counts.
- `loadProjectConfig(explicit)`: path from `projectConfigPath`; any error
  is a usage error (exit 2) with the error's message. An empty path is the
  usage error "no project config (.roast.json) found between here and the
  Git toplevel; run `npx roast init` to create one". A `loadConfig` error
  is a usage error with its message. On success, attach the stored
  credential store for the working directory (see 2.6) and return.
- Usage error for `gate enable` with no toplevel config: "the pre-commit
  gate runs from the Git toplevel and finds no .roast.json there; put the
  project config at the toplevel (`npx roast init`) before enabling the
  gate". (Used by the gate area.)
- No user-level config is ever read (no `~/.config/roast/config.*`); with
  no project config, a review is a usage error naming `npx roast init`
  and sends no request.

### 2.3 Loading and parsing

`loadConfig(path)`:

1. Read the file as UTF-8. Failure: `open config <path>: <cause>`.
2. Decode (below). Failure: `parse config <path>: <cause>`.
3. Record `dir = path.resolve(dirname(path))` on the config (used by
   `promptPath`).
4. Normalize and validate (2.4). These errors are returned WITHOUT the
   `parse config <path>:` prefix (Go returns them bare).

Decoding, in this order (the first failure wins):

1. Parse JSONC: `//` line comments, `/* */` block comments, and trailing
   commas in objects and arrays are allowed (the `init` starter writes a
   trailing comma). Anything else that is not
   JSON is an error (YAML, unquoted keys, single quotes, empty input).
2. The document must be exactly one JSON value; trailing content after it
   (for example a second object) is an error ("config must contain
   exactly one JSON object").
3. Version header: the value must be an object (an array, string, or
   number is a type error). Read `version`:
   - absent or `null`: error `version is required (set "version": 1)`.
   - not an integer number (for example `"1"`): type error.
   - an integer other than 1 (`0`, `2`): error `unsupported config
     version <n> (this build supports version 1)`.
4. Literal credential: if `inference_profiles` is an object, and any of
   its values is an object containing the key `api_key` (any value,
   including `null`), error `inference_profiles.<name>.api_key is not
   allowed: a project config never holds a credential; name its
   environment variable with api_key_env`. This check runs before the
   unknown-field check so it gives the clearer message, and it applies
   even when `api_key_env` is also set. If `inference_profiles` is not an
   object of objects, this step is skipped and step 5 reports the type
   error.
5. Strict structural decode against the schema (2.4): unknown keys at any
   object level are errors naming the key (for example `upload`,
   `gateway`, `base_url`, `unknown_limit`); every type mismatch is an
   error.

Null handling (Go `encoding/json` parity): a JSON `null` for any field
means "unset" -- the field takes its zero/unset value exactly as if it
were absent (`"limits": null`, `"max_output_tokens": null`,
`"snapshot": null`, `"pin": null`, a profile value of `null` are all
accepted). The exception is `version` (step 3), where `null` is "required".

Duplicate keys: the last occurrence wins (same as Go `encoding/json`).

Key case: JSON keys match exactly, case-sensitively (deliberate change 7
in `spec.md`). Go matched struct keys case-insensitively; here `"Version"`,
`"INFERENCE_PROFILES"`, and `"Model"` are unknown fields and rejected.

Integer lexemes: an integer field rejects a number whose raw token text is
not a plain integer (`1.0`, `1e3`), as Go does ("Config numbers" in
`spec.md`). The check uses the raw token text, not the parsed value.

Lone surrogates: validation rejects any string (key or value) containing a
lone UTF-16 surrogate, so the trust hash is always defined.

### 2.4 Fields of `.roast.json`

Top level (object, unknown keys rejected):

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `$schema` | string | no | Editor schema reference; ignored. |
| `version` | integer | yes | Must be `1`. |
| `inference_profiles` | object of profile | no | Named profiles. |
| `roles` | object of role | no | `finder` and/or `verifier`. |
| `review` | object | no | Review defaults. |
| `prompts` | object | no | Prompt-override paths. |
| `limits` | object | no | Per-review limits. |
| `interactive` | object | no | Interactive-mode thresholds. |
| `gate` | object | no | Pre-commit gate settings. |

`{"version": 1}` alone is a valid config. There are no built-in roles or
models: a role absent from `roles` fails only when it is resolved.

#### Inference profile (`inference_profiles.<name>`)

Unknown keys rejected. Every string field treats `""` as unset.

| Key | Type | Default | Validation |
| --- | --- | --- | --- |
| `endpoint` | string | protocol default (2.7) | see endpoint rule |
| `api_key_env` | string | unset | `^[A-Za-z_][A-Za-z0-9_]*$` |
| `model` | string | `""` | none at load; checked by `validateRole` |
| `protocol` | string | `responses` | `chat`, `responses`, `anthropic` |
| `max_output_tokens` | integer | `32768` | `0`/unset -> default; `< 0` error |
| `session_header` | string | unset | see session-header rule |

Every profile is normalized and validated whether or not a role uses it,
in document order (Go iterates a map, so with several bad profiles the
reported one is arbitrary; TS reports the first in document order):

1. Name: `name.trim() === ""` is an error `inference profile names cannot
   be empty`.
2. `protocol` empty -> `responses`. `max_output_tokens` `0` -> `32768`.
3. `api_key_env` set and not matching the pattern: error
   `inference_profiles.<name>.api_key_env is not a valid environment
   variable name`.
4. Endpoint rule, applied to the effective endpoint (`endpoint`, or the
   protocol default when unset), with `field = inference_profiles.<name>`
   (shared with `validateRole`, see 2.9, `validateEndpoint`):
   - The URL must parse, scheme `http` or `https`, non-empty host, no
     userinfo (`user:pass@`), no query, no fragment. Else
     `<field> endpoint must be an http(s) URL without credentials, a
     query, or a fragment`.
   - Protocol must be `chat`, `responses`, or `anthropic`. Else
     `<field> protocol must be chat, responses, or anthropic`.
   - `max_output_tokens <= 0` (after defaulting, so only a negative
     value): `<field> max_output_tokens must be positive`.
5. Session-header rule (only when non-empty), field
   `inference_profiles.<name>.session_header`:
   - At most 64 characters and every character an RFC 9110 token
     character: ASCII letters, digits, or one of
     ``!#$%&'*+-.^_`|~``. Else `<field> must be an HTTP header name of at
     most 64 letters, digits, or !#$%&'*+-.^_`|~ characters`.
   - Not reserved, compared case-insensitively: any name starting with
     `x-stainless-`, or one of `Authorization`, `X-Api-Key`,
     `Proxy-Authorization`, `Cookie`, `Host`, `Content-Type`,
     `Content-Length`, `Content-Encoding`, `Transfer-Encoding`,
     `Connection`, `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`,
     `Upgrade`, `Expect`, `Accept`, `Accept-Encoding`, `User-Agent`,
     `X-Agent-Session-Id`, `Anthropic-Version`, `Anthropic-Beta`,
     `Anthropic-Workspace-Id`, `OpenAI-Organization`, `OpenAI-Project`.
     Else `<field> cannot be "<name>", which is reserved for credentials,
     request framing, or a header Roast or the provider SDK sets`.
   - The value is kept as written (case preserved).

#### Role (`roles.<name>`)

Keys of `roles` must be `finder` or `verifier` (case-sensitive); any other
key is an error `roles.<name> is not a role (finder or verifier)`. Role
object, unknown keys rejected:

| Key | Type | Default | Validation |
| --- | --- | --- | --- |
| `profile` | string | required | non-empty; must name a profile |
| `pin` | boolean | `false` | finder only in effect |
| `author_routes` | object of string | `{}` | see below |

Errors, in this order per role (roles in document order):

1. `profile` empty or absent: `roles.<name>.profile is required`.
2. Unknown profile: `roles.<name>.profile references unknown inference
   profile "<profile>"`.
3. For each `author_routes` entry (document order): normalize the key as
   `canonicalFamily(key.trim().toLowerCase())` (`gemini` -> `google`).
   - Normalized key empty: `roles.<name>.author_routes contains empty
     model family`.
   - Value not a profile name: `roles.<name>.author_routes.<key>
     references unknown inference profile "<value>"` (`<key>` is the
     normalized key).
   - Two keys normalizing to the same value: `roles.<name>.author_routes
     contains duplicate family "<key>"`.

`pin` and `author_routes` are accepted on `verifier` too but have no
effect there (only finder selection reads them).

Keys of `author_routes` can be either an exact author model ID
(lower-cased) or a family name; see 2.10.

#### `review`

| Key | Type | Default | Validation |
| --- | --- | --- | --- |
| `confidence_floor` | number | `0.6` | `0..1`; `0` -> default |
| `quick_confidence_floor` | number | `0.8` | `0..1`; `0` -> default |
| `excludes` | array of string | `[]` | none |
| `snapshot` | boolean | `true` | none |

An explicit `0` floor cannot be expressed: it becomes the default. Both
floors are validated to `0..1` (deliberate change 20); a value outside the
range is an error `<key> must be between 0 and 1 (got <value>)`, checked
in `normalize` before the floor defaults apply. `excludes` are added
before any `--exclude` flags.

#### `prompts`

| Key | Type | Meaning |
| --- | --- | --- |
| `finder_code` | string | Finder prompt for code changes |
| `finder_prose` | string | Finder prompt for prose changes |
| `verifier` | string | Verifier prompt |

`""` is unset (the embedded template is used). The raw strings are part
of the trust projection (trust area). Callers read the file through
`promptPath` (2.8), never the raw string. Contents are used verbatim.

#### `limits`

Every key is optional; unset means the CLI default (2.1). Optional numbers
distinguish an explicit `0` from unset.

| Key | Type | Minimum |
| --- | --- | --- |
| `deadline` | duration string | `>= 0` |
| `request_timeout` | duration string | `>= 0` |
| `max_total_tokens` | integer | `0` |
| `max_diff_bytes` | integer | `1` |
| `max_prompt_bytes` | integer | `1` |
| `max_file_ctx_bytes` | integer | `1` |
| `max_attempts` | integer | `1` |
| `max_verified` | integer | `0` |

#### `interactive`

| Key | Type | Minimum |
| --- | --- | --- |
| `min_files` | integer | `0` |
| `min_diff_lines` | integer | `0` |

#### `gate`

| Key | Type | Validation |
| --- | --- | --- |
| `timeout_seconds` | integer | `>= 0` |
| `severity` | string | `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`, any case |
| `offer` | boolean | none (`"no"` is a type error) |

`severity` is stored as written; consumers upper-case it. `""` is unset.

#### Settings validation order and messages

After profiles and roles, defaults for the two confidence floors are
applied, then settings are checked in this fixed order (first failure
wins):

1. Integers below their minimum, in the order `limits.max_total_tokens`,
   `limits.max_diff_bytes`, `limits.max_prompt_bytes`,
   `limits.max_file_ctx_bytes`, `limits.max_attempts`,
   `limits.max_verified`, `interactive.min_files`,
   `interactive.min_diff_lines`, `gate.timeout_seconds`:
   `<key> must be an integer >= <min> (got <value>)`.
2. Negative durations, `limits.deadline` then `limits.request_timeout`:
   `<key> cannot be negative`.
3. `gate.severity`: `gate.severity must be INFO, LOW, MEDIUM, HIGH, or
   CRITICAL (got "<value>")`.

Integer fields reject non-integers (`1.5`), non-integer lexemes (`1.0`,
`1e3`), and non-numbers as type errors during the structural decode.

#### Duration strings

A duration is a JSON string in Go `time.ParseDuration` syntax, parsed by
the shared helper `parseGoDuration` (this module owns it; the CLI area
uses it for flags):

- Grammar: optional sign `+` or `-`, then one or more `<number><unit>`
  groups, where `<number>` is digits with an optional fraction (`1`,
  `1.5`, `.5`, `1.`; at least one digit overall) and `<unit>` is `ns`,
  `us`, `µs` (U+00B5), `μs` (U+03BC), `ms`, `s`, `m`, `h`. The bare string
  `0` (optionally signed) is also valid. A missing unit (`"10"`) is
  invalid. Results that overflow a signed 64-bit nanosecond count are
  invalid.
- A non-string value: error `duration must be a string such as "90s" (got
  <raw JSON>)`.
- An unparseable string: error `invalid duration "<value>"`.
- A negative result is rejected by settings validation (`-1s`), but
  `-0s` is zero and accepted.
- Represent the value as integer milliseconds or a `bigint` of
  nanoseconds; Go keeps nanoseconds. Sub-millisecond precision only
  matters for equality with Go in tests.

### 2.5 Role resolution

`resolveRole(cfg, name, ctx)` expands a role into a `ResolvedRole`:

1. If `roles[name]` is absent or its profile is empty: error `role "<name>"
   is not configured`.
2. `resolveProfile(name, profileName, selection)`:
   - Unknown profile: `role <name> references unknown inference profile
     "<profile>"` (unreachable after load validation except via author
     routes).
   - Fields: `profile` (name), `baseURL` = effective endpoint,
     `explicitEndpoint` = profile set `endpoint`, `model`, `protocol`,
     `maxOutputTokens`, `sessionHeader`, `pin` and `authorRoutes` from the
     selection, and the attached stored-credential store.
   - Credential from `resolveCredential` (2.6). An error is wrapped as
     `role <name>: <cause>`.

Only the credential comes from outside the config. In particular these
environment variables have NO effect: `ROAST_<ROLE>_BASE_URL`,
`ROAST_<ROLE>_PROTOCOL`, `ROAST_<ROLE>_MODEL`,
`ROAST_<ROLE>_MAX_OUTPUT_TOKENS`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
and any author-model variable.

`ResolvedRole.apiKey` is secret: it must never be copied into run
metadata, logs, debug output, or error messages.

### 2.6 Credential resolution

`<ROLE>` below is `name.toUpperCase()`; the role variable is
`ROAST_<ROLE>_API_KEY`. An environment variable counts only when its value
is non-empty.

`resolveCredential(roleName, profile, role)`:

1. Role variable `ROAST_<ROLE>_API_KEY` set -> use it,
   source `{kind: 'role_env', env: 'ROAST_<ROLE>_API_KEY'}`.
2. Profile `api_key_env` named:
   1. That variable set -> use it, source `{kind: 'profile_env', env}`.
   2. Else, `ambientCredential(role.protocol, role.baseURL, stored)`.
      If it returns a key, use it with the ambient source. If it errors,
      return the error. If it returns no key, return no key with source
      `{kind: 'profile_env', env: <api_key_env>}` (no `withheld`).
3. Otherwise return `ambientCredential(role.protocol, role.baseURL,
   stored)`.

`ambientCredential(protocol, endpoint, stored)`:

1. `provider = providerAt(endpoint, protocol)` (2.7). If found:
   1. `env[provider.keyEnv]` set -> use it, source
      `{kind: 'provider_env', env: provider.keyEnv}`.
   2. `storedCredential(stored, protocol, endpoint)`: if it errors,
      return the error; if it returns a key, use it.
2. Return no key with source `{kind: 'none', withheld:
   withheldKey(protocol)}`.

`storedCredential(stored, protocol, endpoint)`: if `providerAt` finds no
provider, or no store is attached, return none. Else
`stored.lookup(provider.name)`; an error is returned as is; an empty key
is none; else source `{kind: 'stored', provider: provider.name, scope}`.
The registry alone decides the provider, so a custom endpoint never
receives a stored key.

`withheldKey(protocol)`: candidates, in order, are the standard key
variable of the provider at `defaultBaseURL(protocol)` (`OPENAI_API_KEY`
for `responses`/`chat` and any unknown protocol, `ANTHROPIC_API_KEY` for
`anthropic`), then every registry provider's `keyEnv` in registry order
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`). Return the
first one that is set, else `""`. Because it is called only after no key
was sent, any variable it names was withheld.

Resulting precedence (for the default store):

1. `ROAST_<ROLE>_API_KEY`
2. the profile's `api_key_env`
3. the built-in provider's standard variable (only on that provider's
   endpoint with a protocol it accepts there)
4. the provider's project-scope stored credential (same condition)
5. the provider's user-scope stored credential (same condition)

Steps 4 and 5 are inside the store (`lookup` returns project before
user); see the trust-and-credentials area.

Stored-credential interface (implemented by the credentials module, in
the trust-and-credentials area):

```ts
export interface StoredCredentials {
    // '' key when none is stored. Rejects (throws) when a credentials
    // file cannot be used; it never skips a bad file.
    lookup(provider:string):{key:string, scope:'project'|'user'|''}
}
```

The store is read lazily: a broken credentials file fails resolution only
when a role actually reaches step 4 (no environment credential first).
The CLI attaches `credentials.newStore('.')` to every config it loads
(`withStoredCredentials`); any new code path that resolves roles from a
loaded config must attach it too.

`CredentialSource`:

```ts
type CredentialKind =
    'role_env'|'profile_env'|'provider_env'|'stored'|'none'
interface CredentialSource {
    kind:CredentialKind
    env?:string       // variable read, for env kinds
    provider?:string  // stored: provider name
    scope?:string     // stored: 'project' or 'user'
    withheld?:string  // none: a set provider key that was not sent
}
```

Its human-readable form (`describeSource`), never containing a secret:

| Kind | Text |
| --- | --- |
| `role_env` | `<env> (role override)` |
| `profile_env` | `<env> (profile api_key_env)` |
| `provider_env` | `<env> (ambient provider key)` |
| `stored` | `stored <scope> credential for <provider>` |
| `none`, withheld | see below |
| `none` | `none` |

The withheld form is `none; <withheld> is set but is sent only to its
provider's default endpoint`.

`credentialEnvNames(cfg)`: every non-empty `api_key_env` across all
profiles (duplicates allowed), so run-record capture can always redact
them (record area).

### 2.7 Built-in providers

Registry, in this order (order matters for `withheldKey` and listings):

1. `openai`
   - endpoint `https://api.openai.com/v1`
   - protocols `responses`, `chat` (first = the one starter profiles use)
   - keyEnv `OPENAI_API_KEY`
   - keyPage `https://platform.openai.com/api-keys`
   - login `paste`
2. `anthropic`
   - endpoint `https://api.anthropic.com/v1`
   - protocols `anthropic`
   - keyEnv `ANTHROPIC_API_KEY`
   - keyPage `https://console.anthropic.com/settings/keys`
   - login `paste`
3. `openrouter`
   - endpoint `https://openrouter.ai/api/v1`
   - protocols `chat`, `responses`
   - keyEnv `OPENROUTER_API_KEY`
   - keyPage `https://openrouter.ai/settings/keys`
   - login `browser`

Login methods: `paste` opens the key page and reads a pasted key;
`browser` runs a browser key exchange (OpenRouter PKCE, login area).

Invariant: no two entries share an (endpoint, protocol) pair, so
`providerAt` finds at most one.

- `builtinProviders()`: copies of the registry (callers cannot mutate
  it).
- `lookupProvider(name)`: the provider with exactly this name
  (case-sensitive), or undefined.
- `providerAt(endpoint, protocol)`: the first provider that accepts
  `protocol` and whose endpoint `sameEndpoint`s `endpoint`, or undefined.
- `defaultBaseURL(protocol)`: `https://api.anthropic.com/v1` for
  `anthropic`, otherwise `https://api.openai.com/v1` (including unknown
  protocols). OpenRouter is never a protocol's implicit default. A
  profile that omits `endpoint` uses this.

`sameEndpoint(a, b)`: trim both and parse as URLs; if either fails to
parse or has an empty host, false. Otherwise equal when scheme matches
case-insensitively, host (including port) matches case-insensitively,
paths match after stripping trailing `/` characters, raw query strings
match exactly, and userinfo matches exactly.

Examples (`providerAt`): `https://api.openai.com/v1/` + `chat` ->
openai; `HTTPS://API.OPENAI.COM/v1` + `responses` -> openai;
`https://api.openai.com/v1` + `anthropic` -> none;
`https://api.anthropic.com/v1` + `chat` -> none; OpenRouter + `responses`
-> openrouter; OpenRouter + `anthropic` -> none; `http://api.openai.com/v1`
-> none; `https://api.openai.com/v2` -> none; `""` -> none.

Consumers: trust standardness (trust area: a profile on a built-in
provider's endpoint, with an accepted protocol and the standard key
variable, needs no approval), ambient credentials (2.6), the `init`
starter (doctor/init area), `login`/`logout` provider lookup and
`providersNeedingLogin` (login area), and the credentials file's provider
validation. Adding a provider means adding a registry row only.

### 2.8 Prompt paths

`promptPath(cfg, p)`: `""` stays `""`; an absolute path is returned as
is; if the config has no recorded `dir` (not loaded from a file) the path
is returned as is; otherwise `path.join(cfg.dir, p)` (normalized). So the
same file is read wherever in the repository Roast runs. The trust
projection hashes the raw string, so approvals survive worktree moves.

### 2.9 Endpoint overrides (`--<role>-base-url`, `--<role>-protocol`)

`overrideEndpoint(roleName, role, baseURL?, protocol?)` applies the
overrides, then re-binds the credential. `undefined` means the flag was
not given (an explicitly given empty string is still an override). It
fails only when a stored credential the role now needs cannot be read.
The CLI calls it only when at least one of the two flags was given, then
applies `--<role>-model` and `--<role>-max-output-tokens` directly.

`applyEndpointOverrides(role, baseURL?, protocol?)` returns
`crossedProvider`:

1. `crossed = false`.
2. If `protocol` given: `previous = defaultBaseURL(role.protocol)`;
   `role.protocol = protocol`; `next = defaultBaseURL(protocol)`. If
   `next !== previous`:
   - if `!role.explicitEndpoint`: `role.baseURL = next`, `crossed = true`;
   - else if `sameEndpoint(role.baseURL, previous)`: `role.baseURL =
     next`, `crossed = true` (`explicitEndpoint` stays true);
   - else the explicit custom endpoint stays.
3. If `baseURL` given: `role.baseURL = baseURL`, `explicitEndpoint =
   true`, `crossed = false`.

`rebindCredential(roleName, role, crossed)`:

1. `role_env`: keep the credential.
2. `profile_env` and not `crossed`: keep it (even when its key is empty).
   A profile credential follows an explicit endpoint override.
3. Otherwise: if `ROAST_<ROLE>_API_KEY` is set, use it (`role_env`).
   Else `ambientCredential(role.protocol, role.baseURL, stored)`; an
   error becomes `role <name>: <cause>`.

Consequences (pinned by tests):

Each item reads "start; override -> endpoint, key". "Implicit" means
the profile sets no `endpoint`; "profile key" is the `api_key_env` value.

1. implicit, `api_key_env` set; protocol `anthropic` -> Anthropic
   default, `ANTHROPIC_API_KEY`.
2. explicit `https://api.openai.com/v1/`, `api_key_env`; protocol
   `anthropic` -> Anthropic default, `ANTHROPIC_API_KEY`.
3. explicit custom endpoint, `api_key_env`; protocol `anthropic` ->
   unchanged endpoint, profile key.
4. implicit, `api_key_env`; protocol `chat` -> OpenAI default, profile
   key.
5. implicit, `api_key_env`; protocol `anthropic` and a base URL -> the
   chosen URL, profile key.
6. OpenRouter chat with `OPENROUTER_API_KEY`; base URL -> chosen URL, no
   key.
7. OpenRouter chat; protocol `responses` -> OpenRouter,
   `OPENROUTER_API_KEY`.
8. OpenRouter chat; protocol `anthropic` -> OpenRouter, no key.
9. implicit with `OPENAI_API_KEY`; base URL -> chosen URL, no key.
10. `anthropic` protocol, only an anthropic stored key; custom base URL
    -> no key.
11. implicit `anthropic`, only an anthropic stored key; protocol
    `responses` -> OpenAI default, no key.
12. explicit Anthropic default, only an anthropic stored key; protocol
    `chat` -> OpenAI default, no key.
13. implicit `anthropic`, stored keys for every provider; protocol
    `responses` -> the project-scope OpenAI stored key.
14. OpenRouter chat, unset `api_key_env` value, `OPENROUTER_API_KEY` set;
    protocol `responses` -> same key before and after.

Initial resolution (`resolveCredential`) and re-binding must agree: both
reach the provider variable and the stored key only through
`ambientCredential`, so a role picks the same credential with or without
a same-provider protocol override.

### 2.10 Model families and finder flip

`inferFamily(model)`: provider-neutral family, or `""`.

1. `m = model.trim().toLowerCase()`; empty -> `""`.
2. If `m` contains `/`: split at the first `/`. If the prefix is one of
   `anthropic`, `openai`, `google`, `gemini`, `mistral`, `xai`, `cohere`,
   `deepseek`, return `canonicalFamily(prefix)`. Otherwise `m` = the part
   after the first `/`.
3. Strip a trailing `:api`, then a trailing `[1m]` (in that order, each
   at most once).
4. Match, first rule wins:
   - `anthropic`, or prefix `claude-` -> `anthropic`
   - `openai`, or prefix `gpt-`, `codex-`, `chatgpt-`, `o1`, `o3`, `o4`
     -> `openai`
   - `google`, `gemini`, or prefix `gemini-` -> `google`
   - `mistral`, or prefix `mistral-`, `codestral-` -> `mistral`
   - `xai`, or prefix `grok-` -> `xai`
   - `cohere`, or prefix `command-` -> `cohere`
   - `deepseek`, or prefix `deepseek-` -> `deepseek`
   - else `""`.

`canonicalFamily(f)`: `gemini` -> `google`, else `f`.

Examples: `anthropic/claude-sonnet` -> anthropic; `gpt-5-codex` -> openai;
`codex-mini-latest` -> openai; `openai/gpt-6.1-terra` -> openai;
`google/gemini-2.5-pro` -> google; `grok-4` -> xai;
`meta-llama/llama-4:free` -> `""`.

`resolveFinderFlip(cfg, finder, authorModel, ctx)` returns
`{role, note?, warn?}` (the CLI prints them; wording in the CLI area may be
equivalent):

1. `authorKey = authorModel.trim().toLowerCase()`; empty -> return the
   finder unchanged.
2. `authorFamily = inferFamily(authorModel)`.
3. If `finder.pin`: keep the finder; if `authorFamily !== ''` and
   `inferFamily(finder.model) === authorFamily`, warn "author-model <a>
   shares the finder family <f>, but the finder is pinned; generation
   independence is reduced".
4. `target = finder.authorRoutes[authorKey]`, else (when `authorFamily`
   is non-empty) `finder.authorRoutes[authorFamily]`.
5. No target: keep the finder. If `authorFamily === ''` warn "could not
   determine a model family for author-model "<a>" and no exact author
   route is configured; keeping finder <model>"; else if the finder's
   family equals `authorFamily` warn "author-model <a> shares the finder
   family <f> and no author route is configured; generation independence
   is reduced".
6. Target found: `resolved = resolveProfile('finder', target, {})` (full
   credential resolution under the `finder` role variable; `pin` false,
   no routes). An error is returned.
7. `targetFamily = inferFamily(resolved.model)`. If (`authorFamily` is
   non-empty and (`targetFamily` is empty or equals `authorFamily`)) or
   `resolved.model` equals `authorModel` case-insensitively: keep the
   original finder, warn "author-model <a> shares the finder family <f>
   and profile "<target>" uses non-independent model "<m>"; keeping
   finder <model>".
8. Else use `resolved`, with note "author-model <a> matched an exact
   route; using finder profile <target> (<model>)" when `authorFamily` is
   empty, or "author-model <a> maps to family <f>; using finder profile
   <target> (<model>)".

An author-route profile follows the same credential rules (2.6): a route
to a custom endpoint without `api_key_env` gets no ambient key.

### 2.11 Role validation before any model call

`isPlaceholderModel(model)`: after trimming, length > 2, starts with `<`
and ends with `>` (the starter uses `<finder-model>` and
`<verifier-model>`; defined with the starter in the doctor/init area, used
here).

`validateRole(name, role)`, first failure wins:

1. `role.model.trim() === ''`: `<name> model is not configured (set
   inference_profiles.<profile>.model or --<name>-model)`.
2. Placeholder model: `<name> model <model> is a placeholder: set
   inference_profiles.<profile>.model in the project config to a model
   ID, or pass --<name>-model`.
3. `role.apiKey.trim() === ''`, with `provider = providerAt(role.baseURL,
   role.protocol)`:
   - built-in and source `profile_env`: `<name> API key is not configured
     (run `npx roast login <provider>`, or set <env>, named by
     inference_profiles.<profile>.api_key_env, or <roleVar>)`
   - built-in: `<name> API key is not configured (run `npx roast login
     <provider>`, or set <keyEnv> or <roleVar>)`
   - source `profile_env`: `<name> API key is not configured (set <env>,
     named by inference_profiles.<profile>.api_key_env, or <roleVar>)`
   - `withheld` set: `<name> API key is not configured: <withheld> is not
     sent to <baseURL> because it is not that provider's default endpoint
     (set inference_profiles.<profile>.api_key_env or <roleVar>)`
   - else: `<name> API key is not configured (set
     inference_profiles.<profile>.api_key_env or <roleVar>)`
4. `validateEndpoint(name, role.baseURL, role.protocol,
   role.maxOutputTokens)` (2.4 endpoint rule, with field = role name).
   This is where a flag-supplied protocol, endpoint, or output limit is
   validated.

The CLI turns these into usage errors before any request (CLI area);
`doctor` reports them per role (doctor area).

### 2.12 Unported Go helpers

`DescribeCredential`, `IsLoopbackHost` (localhost or a loopback IP,
trailing `.` ignored), and `InferenceProfile.DescribeEndpoint` have no
non-test callers at the baseline. They are not ported (deliberate change
23 in `spec.md`); `doctor` uses `describeSource` instead.

## 3. TypeScript module design

All modules live under `src/config/`; tests under `test/config/`. Config
data keeps the JSON key spelling (snake_case) so the zod schema's inferred
type is the config type; runtime role objects use camelCase.

### Parsing pipeline

`decode(text)` is staged so the Go error order (2.3) holds:

1. `parseJsonc(text)` (`src/config/jsonc.ts`): `jsonc-parser`'s
   `parseTree` with `allowTrailingComma: true` (the `init` starter writes
   a trailing comma) and comments allowed. Any parse error, including
   `EndOfFileExpected` for trailing content, is fatal. Convert the tree
   into plain values whose objects have a null prototype, assigning keys
   with `Object.defineProperty` so a key named `__proto__` (a legal
   profile name in Go) is an ordinary key; a duplicate key keeps the last
   value (same as Go). Keys are kept as written and matched exactly, so
   `"Version"` is an unknown field. A `visit` pass (jsonc-parser's
   visitor) records the raw token text of every number; a number whose
   lexeme is not a plain integer (`1.0`, `1e3`) is flagged by path, and
   the schema step reports a type error if that path is an integer
   field.
2. `checkVersion(value)`: not a plain object -> type error; `version`
   absent or `null` -> required; not an integer -> type error; not 1 ->
   unsupported.
3. `rejectLiteralCredentials(value)`.
4. `nullsAsUnset(value)`: Go parity for `null` (2.3). In fixed-shape
   objects a `null` property is deleted. In the map-shaped objects a
   `null` value becomes the zero value: an `inference_profiles` or `roles`
   entry becomes `{}`, an `author_routes` entry becomes `""`. A `null`
   element of `review.excludes` becomes `""`.
5. `rejectLoneSurrogates(value)`: any key or string value containing a
   lone surrogate is an error, so the trust hash is always defined.
   Then `ConfigSchema.safeParse(value)`: strict structure and types. Zod
   issues map to messages `<dotted.path>: <reason>`, with unknown keys
   reported as `unknown field "<key>"` at their path. Wording need only be
   equivalent to Go's.
6. `normalize(raw, dir)`: profile defaults and checks (2.4), role checks,
   confidence-floor defaults, then `validateSettings`. These run as plain
   functions rather than zod refinements so their order and messages are
   explicit and so the JSON Schema generator never sees them.

### `src/config/schema.ts`

The zod (v4) schema is the single source of truth for shape, types, and
the editor schema. Every field carries `.meta({description})` with the
description text currently in `roast.schema.json` (defaults included).

```ts
import {z} from 'zod'

export const Duration = z.string()
    .refine(isGoDuration, 'invalid duration')
    .meta({
        pattern: '^([0-9]+(\\.[0-9]+)?(ns|us|µs|ms|s|m|h))+$|^0$',
        description: 'A Go duration such as "90s" or "10m".'
    })

export const InferenceProfile = z.strictObject({
    endpoint: z.string().optional(),       // format: uri in meta
    api_key_env: z.string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    model: z.string().optional(),
    protocol: z.enum(['responses', 'chat', 'anthropic']).optional(),
    max_output_tokens: z.int().optional(),
    session_header: z.string().optional(),
})
// ...Role, Review, Prompts, Limits, Interactive, Gate likewise
export const ConfigSchema = z.strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    inference_profiles: z.record(z.string(), InferenceProfile).optional(),
    roles: z.strictObject({
        finder: Role.optional(),
        verifier: Role.optional(),
    }).optional(),
    // review, prompts, limits, interactive, gate
})
export type RawConfig = z.infer<typeof ConfigSchema>
```

Schema-vs-runtime rules:

- Where Go accepts an empty string as "unset" but the editor schema shows
  a constraint (`api_key_env` pattern, `protocol` enum), the zod check
  must accept `""` too (for example `.or(z.literal(''))`) while the
  generated JSON Schema keeps the constraint. Use zod 4's
  `toJSONSchema` `override` hook, or metadata, for every place where the
  editor schema is intentionally stricter than or different from the
  runtime check. Each such place is listed in a comment next to the
  field. They are: `protocol` and `api_key_env` (`""` accepted),
  `gate.severity` (runtime accepts any letter case, schema shows the
  upper-case enum), `review.confidence_floor` and
  `quick_confidence_floor` (schema shows `minimum: 0`, `maximum: 1`;
  runtime checks the same range in `normalize`), `max_output_tokens`
  (schema `minimum: 1`,
  runtime accepts `0` as default and rejects negatives in `normalize`),
  `session_header` (schema `maxLength: 64` only), and the integer
  minimums (schema `minimum`, runtime checks in `validateSettings` so
  the messages and order match 2.4).
- Roles under `roles` other than `finder`/`verifier` produce the specific
  message `roles.<name> is not a role (finder or verifier)`, not a
  generic unknown-key message.

### Schema generation

`scripts/gen-schema.ts` (bundled with esbuild like the tests, then run by
Node) builds the editor schema and writes `roast.schema.json` (2-space
indent, trailing newline):

```ts
const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://github.com/nichoth/roast/roast.schema.json',
    title: 'Roast project config (.roast.json)',
    description: 'Every non-secret Roast setting. ...',
    ...z.toJSONSchema(ConfigSchema, {
        target: 'draft-7', io: 'input', override: editorOverrides
    })
}
```

The module exports `renderProjectSchema():string` (in
`src/config/schema.ts`), which returns the full file text; the packaging
area's build calls it to generate `roast.schema.json`, and
`scripts/gen-schema.ts` is a thin wrapper around it. npm script
`build:schema` runs it. The test `test/config/schema.ts`
generates the schema in memory and asserts it deep-equals the committed
file (parsed JSON, not text), failing with "run npm run build:schema".
This replaces Go's reflection-based drift test. The file stays in
`package.json` `files`, and the starter's `$schema` value stays
`./node_modules/@substrate-system/roast/roast.schema.json`.

### `src/config/load.ts`

```ts
export const PROJECT_CONFIG_NAME = '.roast.json'
export const CURRENT_VERSION = 1

export interface ProjectConfig extends NormalizedConfig {
    readonly dir:string            // '' when not loaded from a file
    readonly stored?:StoredCredentials
}
export function findConfig(start:string, stop:string):string
export function loadConfig(path:string):ProjectConfig
export function decode(text:string):RawConfig
export function normalize(raw:RawConfig, dir:string):ProjectConfig
export function withStoredCredentials(
    cfg:ProjectConfig,
    store:StoredCredentials
):ProjectConfig
export function promptPath(cfg:ProjectConfig, p:string):string
export function credentialEnvNames(cfg:ProjectConfig):string[]
export function snapshotEnabled(cfg:ProjectConfig):boolean
export function gateOffers(cfg:ProjectConfig):boolean
```

`NormalizedConfig` is `RawConfig` with `inference_profiles` and `roles`
always present (possibly empty), every profile's `protocol` and
`max_output_tokens` filled, `author_routes` keys normalized, and both
confidence floors filled. Optional numbers stay `number|undefined` so an
explicit `0` differs from unset; `limits.deadline` and
`limits.request_timeout` are stored parsed (`GoDuration`, below).

Errors are thrown as `ConfigError` (a plain `Error` subclass); the CLI
wraps them as usage errors. Filesystem calls are synchronous (`node:fs`),
which keeps `loadConfig` and `resolveRole` synchronous.

### `src/config/duration.ts`

```ts
export type GoDuration = bigint            // nanoseconds
export function parseGoDuration(s:string):GoDuration  // throws
export function isGoDuration(s:string):boolean
export function toMillis(d:GoDuration):number
```

Shared with the CLI area for `--deadline` and `--request-timeout`.

### `src/config/provider.ts`

```ts
export type Protocol = 'chat'|'responses'|'anthropic'
export type LoginMethod = 'paste'|'browser'
export interface BuiltinProvider {
    readonly name:string
    readonly endpoint:string
    readonly protocols:readonly Protocol[]
    readonly keyEnv:string
    readonly keyPage:string
    readonly login:LoginMethod
}
export function builtinProviders():BuiltinProvider[]
export function lookupProvider(name:string):BuiltinProvider|undefined
export function providerAt(
    endpoint:string,
    protocol:string
):BuiltinProvider|undefined
export function defaultBaseURL(protocol:string):string
export function sameEndpoint(a:string, b:string):boolean
```

URL parsing uses the WHATWG `URL` class. Only the empty-host case is
pinned to Go; other odd hosts (spaces, IDNA) follow WHATWG. A value whose text
after the scheme does not start with `//` plus a non-empty authority (for
example `https:///v1` or `https:v1`) is treated as having an empty host
(WHATWG would otherwise repair it), matching Go. Endpoint strings are
stored and sent
exactly as written; parsing is only for checks and comparison.

### `src/config/credential.ts`

```ts
export type Env = Readonly<Record<string, string|undefined>>
export interface StoredCredentials {
    lookup(provider:string):{key:string, scope:string}
}
export type CredentialKind =
    'role_env'|'profile_env'|'provider_env'|'stored'|'none'
export interface CredentialSource { /* 2.6 */ }
export function describeSource(s:CredentialSource):string
export function roleKeyVar(role:string):string   // ROAST_<ROLE>_API_KEY
export function ambientCredential(
    protocol:string,
    endpoint:string,
    stored:StoredCredentials|undefined,
    env:Env
):{key:string, source:CredentialSource}
export function overrideEndpoint(
    roleName:string,
    role:ResolvedRole,
    overrides:{baseURL?:string, protocol?:string},
    env:Env
):ResolvedRole
```

`env` is passed explicitly everywhere (never read from `process.env`
inside this area) so the in-process CLI seam can inject it.
`rebindCredential` and `applyEndpointOverrides` are module-private but
exported from an `internal` object for the matrix tests.

### `src/config/role.ts`

```ts
export interface ResolvedRole {
    readonly profile:string
    readonly baseURL:string
    readonly apiKey:string            // secret; never logged or recorded
    readonly model:string
    readonly protocol:string
    readonly maxOutputTokens:number
    readonly sessionHeader:string
    readonly pin:boolean
    readonly authorRoutes:Readonly<Record<string, string>>
    readonly credential:CredentialSource
    readonly explicitEndpoint:boolean
    readonly stored?:StoredCredentials
}
export function resolveRole(
    cfg:ProjectConfig,
    name:'finder'|'verifier',
    env:Env
):ResolvedRole
export function resolveFinderFlip(
    cfg:ProjectConfig,
    finder:ResolvedRole,
    authorModel:string,
    env:Env
):{role:ResolvedRole, note?:string, warn?:string}
export function validateRole(name:string, role:ResolvedRole):void
export function validateEndpoint(
    field:string,
    baseURL:string,
    protocol:string,
    maxOutputTokens:number
):void
```

`ResolvedRole` objects are immutable; overrides return a new object.
`apiKey` must be excluded from any `toJSON`/debug rendering: give
`ResolvedRole` no enumerable path into run metadata, and debug output in
this area logs only the credential source kind and variable name.

### `src/config/family.ts`

```ts
export function inferFamily(model:string):string
export function canonicalFamily(family:string):string
```

### Dependencies

- Uses: `jsonc-parser`, `zod`, `node:fs`, `node:path`,
  `@substrate-system/debug` (namespace `roast:config`).
- Used by: CLI (load, flags, resolution, validation), trust (projection
  uses `providerAt`, the effective endpoint, `promptPath` raw strings),
  credentials (`lookupProvider`), login/logout (`builtinProviders`,
  `lookupProvider`, `providerAt`), doctor (`validateRole`,
  `describeSource`), init starter (`inferFamily`, `lookupProvider`,
  registry protocol order), record (`credentialEnvNames`), gate
  (`findConfig` via `gateConfigPath`, `gate` settings).
- The Git toplevel lookup in `projectConfigPath` comes from the scope
  area's `gitRoot` helper.
- `src/config` must not import the credentials module (the store is
  injected through the `StoredCredentials` interface), mirroring Go.

## 4. Deliberate changes

- Node `>=22.18`, darwin/linux only: no Windows path handling in
  `findConfig` or `promptPath`.
- Debug tracing under `roast:config` (`DEBUG=roast:*`): may log the
  config path found, the profile chosen per role, and the credential
  source kind and variable name; never a key, header, or prompt.
- Validation messages need only be equivalent to Go's, not identical.
- Order of errors among several invalid profiles or roles is document
  order (Go's was arbitrary map order).
- JSON keys match exactly, case-sensitively (deliberate change 7): Go
  accepted `"Version"`; here it is an unknown field. `null` still means
  absent.
- `review.confidence_floor` and `quick_confidence_floor` are validated to
  `0..1` (deliberate change 20); Go did not range-check them.
- `DescribeCredential`, `IsLoopbackHost`, and `DescribeEndpoint` are not
  ported (deliberate change 23).
- Strings containing lone surrogates are rejected, so the trust hash is
  always defined ("Bytes and text" in `spec.md`).
- Endpoint URL parsing is WHATWG; only the empty-host case is pinned to
  Go.

No other change: every field, default, range, and error condition of
`.roast.json` version 1 is kept.

## 5. Test plan

Seams: config loading and validation are observable through the CLI at
low cost (exit code 2, no request reaches the fake server), so the
representative cases run at the CLI seam. The credential and override
matrices (about 100 combinations) and pure functions (`inferFamily`,
`providerAt`, duration parsing) run at the module seam, because each CLI
case would need a full review against the fake server to observe one
`Authorization` header. A handful of credential cases also run at the CLI
seam to prove the wiring (which key reaches which endpoint).

### Discovery (CLI seam unless noted)

- Nearest config wins; nothing above the stop directory is found; a
  config at the stop directory is found (`TestFindWalksUpNoFurtherThanStop`,
  module seam).
- Review in a subdirectory uses the nearest config below the Git
  toplevel (`TestReviewUsesNearestProjectConfigBelowGitToplevel`).
- `--config` overrides discovery
  (`TestConfigFlagOverridesDiscoveredProjectConfig`).
- No config: usage error, no request
  (`TestReviewWithoutProjectConfigNamesRoastInit`); a user-level config
  directory is never read (`TestUserConfigDirectoryIsNotRead`).
- Symlinked working directory vs `realpath` toplevel still stops at the
  toplevel (new; covers the macOS `/private/var` case).

### Parsing and validation

- JSONC comments and trailing commas accepted
  (`TestLoadAcceptsJSONCCommentsAndTrailingCommas`,
  `TestReviewUsesModelsFromJSONCProjectConfig`).
- Rejected: unknown top-level field, unknown profile field (`base_url`),
  missing/zero/future/string version, literal `api_key`, trailing
  document, non-object, YAML (`TestLoadRejectsInvalidProjectConfig`);
  literal `api_key` even beside `api_key_env`
  (`TestLoadRejectsProfileCredentialAmbiguity`); `upload` section
  (`TestLoadRejectsUploadSection`); missing file
  (`TestLoadMissingFileIsAnError`); via the CLI as exit 2 with no request
  (`TestReviewRejectsInvalidProjectConfig`).
- Session header: valid value kept; too long, bad characters, and every
  reserved name in any case rejected (`TestLoadSessionHeader`,
  `TestLoadRejectsInvalidSessionHeader`).
- Limits: `max_diff_bytes: 0`, `max_attempts: 0`, `max_total_tokens: -1`,
  `request_timeout: "later"`, `deadline: "-1s"`, unknown limit rejected
  (`TestInvalidLimitsAreRejected`); limits from config bound the review
  (`TestLimitsInProjectConfigBoundTheReview`,
  `TestMaxDiffBytesInProjectConfigTruncatesTheDiff`,
  `TestMaxPromptBytesInProjectConfigRejectsALargePrompt`); flags win for
  one invocation (`TestFlagsOverrideProjectConfigForOneInvocation`);
  interactive thresholds and `review.snapshot` honored
  (`TestInteractiveThresholdsInProjectConfig`,
  `TestReviewSnapshotSettingInProjectConfig`).
- Gate: `severity: "SEVERE"`, `timeout_seconds: -1`, `offer: "no"`
  rejected (`TestInvalidGateSettingsAreRejected`); settings come from the
  config or default (`TestGateSettingsComeFromTheProjectConfig`,
  `TestGateSettingsDefaultWhenUnset`); `offer: false` stops the offer
  (`TestGateOfferFalseStopsTheGateOffer`).
- New parity cases (module seam): `null` fields act as unset; a profile
  named `__proto__` loads as an ordinary profile; lower-case
  `gate.severity` accepted; author-route keys `" Gemini "` and `google`
  collide as duplicates; `max_output_tokens: 0` becomes 32768 and `-1`
  is rejected.
- Tightenings (module seam): `"Version": 1` and `"Model"` in a profile
  are rejected as unknown fields; a duplicate key keeps the last value;
  `max_attempts: 1.0` and `1e3` are rejected as non-integer lexemes while
  `1` loads; a trailing comma after the last property loads;
  `confidence_floor: 1.5` and `-0.1` are rejected, `0`, `0.5`, `1`
  accepted; a string containing a lone surrogate (written as an escape
  in the JSON) is rejected.
- Duration parser: Go grammar accept/reject table, including `0`, `.5s`,
  `1h30m`, `µs`/`μs`, `+5s`, `-0s`, and rejects `10`, `""`, `1x`.

### Schema

- `renderProjectSchema()` output, parsed, deep-equals the committed
  `roast.schema.json` (replaces `TestSchemaMatchesConfigStruct`).
- Every example config used by tests and the `init` starter validates
  against the generated JSON Schema (new; cheap guard that the editor
  schema is not stricter than intended for real configs).

### Resolution and credentials (module seam, plus CLI wiring)

- Named profiles resolve with defaults; Anthropic defaults for the
  `anthropic` protocol (`TestLoadResolvesNamedProfiles`,
  `TestResolveRoleUsesNativeAnthropicDefaults`).
- Legacy environment overrides are ignored
  (`TestResolveRoleIgnoresLegacyGlobalOverrides`,
  `TestRemovedRoleEnvironmentVariablesAreIgnored`,
  `TestRemovedEnvironmentVariablesHaveNoEffect` at the CLI seam).
- Precedence matrix: protocol x endpoint (unset, default, custom,
  ambient gateway) x `api_key_env` x `*_BASE_URL` set x role key; checks
  endpoint, key, source kind, and `withheld`
  (`TestCredentialAndEndpointPrecedence`).
- `OPENROUTER_API_KEY` only at OpenRouter with chat/responses, withheld
  elsewhere (`TestOpenRouterKeyOnlyAtOpenRouter`).
- Custom endpoint without a named credential gets no ambient key, and
  validation names the withheld variable and the role variable
  (`TestTemplateProfileWithoutCredentialNeverReceivesAmbientKey`).
- Trailing slash on the default endpoint still matches
  (`TestEndpointComparisonIgnoresATrailingSlash`).
- Author-route profiles follow the same credential rule
  (`TestAuthorRouteProfileUsesTheSameCredentialRule`).
- Override table in 2.9 (`TestEndpointFlagOverrides`,
  `TestRebindCredential`, `TestStoredCredentialDoesNotFollowAnOverride`,
  `TestUnsetProfileVariableOnABuiltinEndpointPrefersProviderVariable`).
- Stored credentials: used at a built-in endpoint; ranked below every
  env variable, project before user; never sent to a custom endpoint;
  an unusable store fails resolution only when reached; the source names
  scope and provider, never the key
  (`TestStoredCredentialAtABuiltinEndpoint`,
  `TestStoredCredentialPrecedence`,
  `TestStoredCredentialNeverReachesACustomEndpoint`,
  `TestUnusableStoredCredentialsFailResolution`,
  `TestStoredCredentialSourceNamesScopeNotSecret`).
- No source rendering ever contains a secret
  (`TestCredentialSourceNeverIncludesSecret`).
- Missing credential on a built-in provider suggests login
  (`TestMissingCredentialOnABuiltinProviderSuggestsLogin`); the
  `describeCredential` test is not ported.
- Embedded userinfo in an endpoint fails validation
  (`TestValidateRoleRejectsEmbeddedCredentials`).
- CLI wiring: shell provider key reaches only its default endpoint; not a
  custom endpoint; a named credential and a role key work on a custom
  endpoint (`TestShellProviderKeyGoesOnlyToItsDefaultEndpoint`,
  `TestShellProviderKeyIsNotSentToACustomEndpoint`,
  `TestNamedCredentialAndRoleKeyOnACustomEndpoint`), asserted on the
  `Authorization` header the fake server received.

### Providers and families (module seam)

- `lookupProvider` returns each built-in by exact name only
  (`TestLookupBuiltinProvider`); `providerAt` example table
  (`TestProviderAt`); every registered (endpoint, protocol) pair maps
  back to its provider (`TestProviderAtIsUnique`).
- `inferFamily` table (`TestInferFamily`); finder flip selects a named
  profile, an exact route, refuses a same-family target, and treats slash
  IDs like bare IDs (`TestResolveFinderFlipSelectsNamedProfile`,
  `TestResolveFinderFlipSelectsExactAuthorRoute`,
  `TestResolveFinderFlipRejectsSameFamilyTarget`,
  `TestResolveFinderFlipTreatsSlashIDsLikeBareIDs`); the CLI flag
  selects the flip and the environment does not
  (`TestAuthorModelFlagSelectsTheFinderFlip`,
  `TestAuthorModelEnvironmentDoesNotFlipTheFinder`). Assert on the
  chosen profile and on whether a note or warning exists, not on text.

## 6. Go baseline references

At commit `cd08f10`:

- `internal/config/config.go` -- types, `Find`, `Load`, decoding,
  normalization, settings validation, session header, `ResolveRole`,
  credential resolution, overrides, `InferFamily`, finder flip,
  `ValidateRole`, `validateEndpoint`.
- `internal/config/provider.go` -- built-in provider registry.
- `internal/config/starter.go` -- `IsPlaceholderModel`, `SchemaRef`
  (starter itself is in the doctor/init area).
- `internal/config/trust.go` -- consumer of `ProviderAt` (trust area).
- `internal/cli/config.go` -- `projectConfigPath`, `gateConfigPath`,
  `loadProjectConfig`, `withStoredCredentials`, usage errors.
- `internal/cli/cli.go` -- defaults (lines 156-171), `configInt`,
  `flagOrConfigInt`, `flagOrConfigDuration`, `applyRoleFlags`.
- `internal/cli/gate.go` -- gate defaults.
- `internal/scope/scope.go` -- `GitRoot`.
- `roast.schema.json` -- current editor schema and descriptions.
- Tests: `internal/config/config_test.go`, `credential_test.go`,
  `provider_test.go`, `schema_test.go`, `stored_credential_test.go`;
  `internal/cli/project_config_test.go`, `settings_test.go`.

## 7. Resolved

1. Key case: JSON keys match exactly; `"Version"` is an unknown field
   (deliberate change 7, `spec.md`). `null` still means absent.
2. Integer fields reject non-integer lexemes (`1.0`, `1e3`) by raw token
   text through jsonc-parser's visitor (cross-cutting rule "Config
   numbers", `spec.md`).
3. Duplicate keys: last wins, same as Go `encoding/json`.
4. `confidence_floor` values are validated to 0..1 (deliberate change 20,
   `spec.md`).
5. `DescribeCredential`, `IsLoopbackHost`, `DescribeEndpoint` are not
   ported (deliberate change 23, `spec.md`).
6. WHATWG `URL` is used; only the empty-host case is pinned to Go.
7. jsonc-parser runs with `allowTrailingComma: true`; strings with lone
   surrogates are rejected ("Bytes and text", `spec.md`); the area exports
   `renderProjectSchema():string` for the packaging build.
