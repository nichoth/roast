# 03 -- Trust and stored credentials

Area spec for the TypeScript rewrite. Read `00-decisions.md` first; this
file does not repeat it. Parity baseline: Go commit `cd08f10`.

## 1. Purpose

This area decides whether a **project config** may be used to send code and
credentials anywhere, and supplies **stored credentials** to role
resolution.

- **Trust.** A project config's security-relevant contents (the endpoints,
  protocols, and credential variable names of every profile a role or an
  author route selects, plus prompt-override paths) form its *trust
  projection*. A config whose projection stays on **built-in providers**
  with their standard key variables and sets no prompt overrides needs no
  approval. Any other config is a candidate **trusted project config** only
  after the user approves its projection for this clone. Approvals live in
  `<git-common-dir>/roast/trust.json`, so linked worktrees share them and
  `git clone` never copies them (ADR-0001, hashing per ADR-0003).
- **Stored credentials.** A **credential** for a built-in provider may be
  kept in a credentials file scoped to the project
  (`<git-common-dir>/roast/credentials.json`) or to the user
  (`$XDG_CONFIG_HOME/roast/credentials.json`, else
  `~/.config/roast/credentials.json`). Config's role resolution consults
  them through a narrow `StoredCredentials` interface, below every
  environment variable, and only for a role on that provider's built-in
  endpoint (ADR-0002).

Out of scope here, specified elsewhere: the full credential resolution
order and `CredentialSource` (config area), `login` / `logout` flows (they
call `saveCredential` / `deleteCredential` / the path helpers defined
here), `doctor` (references below), text escaping (`textsafe`), the gate.

## 2. Behavior contract

### 2.1 Built-in provider registry (consumed, not owned)

Owned by the config area; restated because trust and credentials depend on
it exactly.

```
name        endpoint                      protocols        key variable
openai      https://api.openai.com/v1     responses, chat  OPENAI_API_KEY
anthropic   https://api.anthropic.com/v1  anthropic        ANTHROPIC_API_KEY
openrouter  https://openrouter.ai/api/v1  chat, responses  OPENROUTER_API_KEY
```

Protocols are listed in registry order (the first is the starter's).

- `lookupProvider(name)`: exact, case-sensitive name match.
- `providerAt(endpoint, protocol)`: the provider that accepts `protocol`
  and whose endpoint is the same endpoint as `endpoint`. At most one
  matches.
- `sameEndpoint(a, b)`: trim both, parse as URLs; false if either fails to
  parse or has an empty host. Equal when scheme (case-insensitive), host
  (case-insensitive, including port), path with trailing `/` removed,
  raw query string, and userinfo all match. So `https://api.openai.com/v1/`
  is the OpenAI endpoint.
- A profile's endpoint is its `endpoint` field verbatim when set, else the
  protocol default: `https://api.anthropic.com/v1` for `anthropic`,
  `https://api.openai.com/v1` for every other protocol. OpenRouter is never
  an implicit default.
- A profile's protocol after `config.load` defaults to `responses` when
  omitted. The projection always sees the defaulted protocol.
- Author-route family keys are normalized by `config.load` (trimmed,
  lowercased, canonical family). The projection sees normalized keys.

### 2.2 Trust projection

`trustProjection(cfg)` produces:

```ts
interface TrustedProfile {
    selector:string      // "roles.finder" or
                         // "roles.finder.author_routes.<family>"
    profile:string       // profile name
    endpoint:string      // resolved endpoint string (2.1), not normalized
    protocol:string      // defaulted protocol
    credentialEnv:string // see below; "" when none
}
interface PromptOverride {
    name:string          // "prompts.finder_code" | "prompts.finder_prose"
                         // | "prompts.verifier"
    path:string          // raw string from the config, unresolved
}
interface TrustProjection {
    profiles:TrustedProfile[]
    promptOverrides:PromptOverride[]
}
```

Order and contents:

1. For each role name in `cfg.roles`, sorted ascending (in practice
   `finder`, then `verifier`; `config.load` rejects any other role name):
   1. the role's `profile`, selector `roles.<role>`;
   2. then each author route, families sorted ascending, selector
      `roles.<role>.author_routes.<family>`.
   A selected profile name not present in `inference_profiles` is skipped
   (unreachable after `config.load`, which rejects unknown references).
   Duplicates are kept: the same profile selected twice appears twice.
   Profiles no role or route selects are not in the projection.
2. `credentialEnv` of a profile: its `api_key_env` when non-empty; else,
   when `providerAt(endpoint, protocol)` finds a provider, that provider's
   key variable; else `""`. The role override variable
   (`ROAST_<ROLE>_API_KEY`) is never part of the projection.
3. Prompt overrides in fixed order `finder_code`, `finder_prose`,
   `verifier`; included only when the raw config string is non-empty. The
   path is the raw string from `.roast.json` (not resolved against the
   config directory), so approvals survive moving the worktree.

The projection is computed from the loaded config only. Command-line role
overrides (`--<role>-base-url`, `--<role>-protocol`, ...) are not part of
it: they are the operator's own choice on the command line, not the
repository's.

### 2.3 Which configs need approval

`requiresApproval(projection)` is true when:

- `promptOverrides` is non-empty, or
- any profile is not *standard*. A profile is standard when
  `providerAt(endpoint, protocol)` finds a provider `P` and
  `credentialEnv === P.keyEnv`.

Consequences (pinned by tests, 5.1): an implicit endpoint with its
protocol's provider is standard; a trailing slash on a built-in endpoint is
standard; OpenRouter with no `api_key_env` is standard (its `credentialEnv`
becomes `OPENROUTER_API_KEY`); any other key variable on a built-in
endpoint (`MY_KEY`, another provider's key) needs approval; a protocol the
provider does not accept at that endpoint (Anthropic endpoint with `chat`,
OpenAI endpoint with `anthropic`) needs approval; any custom endpoint needs
approval, with or without a key variable.

### 2.4 Trust hash v2 (deliberate change)

The approval hash identifies the projection's security-relevant values.
Selectors and profile names are excluded: which approved destination a
role uses, or what a profile is called, does not change where code and
credentials go.

**Hash document.** Build this JSON value from the projection:

```json
{
  "destinations": [
    {"credential_env": "<string>", "endpoint": "<string>",
     "protocol": "<string>"}
  ],
  "prompts": [
    {"name": "<string>", "path": "<string>"}
  ]
}
```

- `destinations`: one entry per profile in the projection, with
  `endpoint`, `protocol`, `credential_env` copied verbatim (no URL
  normalization, no trimming). Remove exact duplicates (all three fields
  equal). Sort ascending by `endpoint`, then `protocol`, then
  `credential_env`, comparing each string by UTF-16 code units (the
  JavaScript `<` operator on strings; the same order RFC 8785 uses for
  keys). Always an array; `[]` when empty.
- `prompts`: one entry per prompt override, in the projection's fixed
  order (`prompts.finder_code`, `prompts.finder_prose`,
  `prompts.verifier`), `name` including the `prompts.` prefix, `path`
  verbatim. Not deduplicated, not sorted. Always an array; `[]` when empty.
- No other members. No version field inside the document.

**Canonicalization.** Serialize the document as RFC 8785 (JCS) canonical
JSON. Because the document contains only objects, arrays, and strings,
JCS reduces to: object members sorted by key in UTF-16 code-unit order; no
whitespace anywhere; arrays in the order given above; strings serialized
exactly as ECMAScript `JSON.stringify` serializes a string (escape `"`,
`\`, and U+0000..U+001F using `\b \t \n \f \r` or `\u00xx` lowercase hex;
everything else, including `/` and non-ASCII, emitted literally). Key
order for the two object kinds is therefore
`credential_env, endpoint, protocol` and `name, path`, and the top level
is `destinations, prompts`. Implement it in-house (about 20 lines); no new
dependency.

**Digest.** SHA-256 over the UTF-8 bytes of the canonical string. The
stored and compared form is the string `sha256:` followed by the 64
lowercase hex digits of the digest.

**Known-answer vectors** (frozen; use as unit-test fixtures):

1. One custom destination and one prompt override.
   Canonical:
   `{"destinations":[{"credential_env":"GATEWAY_KEY","endpoint":"https://gateway.example/v1","protocol":"chat"}],"prompts":[{"name":"prompts.finder_code","path":"finder-prompt.md"}]}`
   Hash:
   `sha256:2b18773b1f654fbbd02019247674005c4035f3972cfc8552655a09bb2ac57d27`
2. Two destinations (sorted), no prompts.
   Canonical:
   `{"destinations":[{"credential_env":"OPENAI_API_KEY","endpoint":"https://api.openai.com/v1","protocol":"responses"},{"credential_env":"","endpoint":"https://gw.example/v1","protocol":"chat"}],"prompts":[]}`
   Hash:
   `sha256:7ac3826edbb00b7b8294e6117b0fa3c70fd4e994de107bf41a23324761252d5c`

(Lines above exceed 80 columns because the vectors must be exact.)

Properties that follow and must hold:

- Editing a model, a threshold, a limit, a gate setting, a profile name,
  or which role points at an already-listed destination keeps the hash.
- Changing any endpoint, protocol, credential variable, or prompt-override
  path (including the routed profile's) changes the hash.
- JSON key order and whitespace in `.roast.json` never affect the hash.

### 2.5 State directory and trust record location

- `stateDir(dir)`: run `git rev-parse --path-format=absolute
  --git-common-dir` with working directory `dir`; trim the output; result
  is `<output>/roast`. If git fails (not a repository), the error message
  is `not inside a git repository`.
- `trustPath(dir)` is `<stateDir(dir)>/trust.json`; on failure the error is
  `trust: not inside a git repository`.
- Linked worktrees resolve to the main repository's common dir, so they
  share one record.
- Every trust operation from the CLI passes the Git toplevel of the
  process working directory (`git rev-parse --show-toplevel`), not the
  directory of a `--config` file.

### 2.6 Trust record file (`trust.json`)

Version 2 shape, written by the TypeScript implementation:

```json
{
  "version": 2,
  "approved": [
    "sha256:2b18773b1f654fbbd02019247674005c4035f3972cfc8552655a09bb2ac57d27"
  ]
}
```

- Serialized with 2-space indentation, member order `version`, `approved`,
  and a trailing newline (`JSON.stringify(rec, null, 2) + "\n"`).
- `approved` lists hashes in the order they were approved; no duplicates.
- There is no `untrust` command. Deleting the file withdraws every approval
  for the clone.

**Reading** (`readTrustRecord(path)`) yields one of:

| file state | result |
|---|---|
| absent (`ENOENT`) | `{kind:'current', approved:[]}` |
| JSON object, `version` is the number `2` | `{kind:'current', approved}` |
| JSON object, `version` is the number `1` | `{kind:'legacy'}` |
| anything else | error |

- For version 2: `approved` missing or `null` reads as `[]`; otherwise it
  must be an array of strings, else error. Unknown top-level members are
  ignored on read (Go parity) and dropped on the next write.
- For version 1 (written by the Go implementation): nothing else in the
  file is read or validated. Its hashes are never compared: the Go hash
  serialization is not reproduced (ADR-0003).
- Errors: unreadable file -> `read trust record: <cause>`; invalid JSON or
  a non-object or wrongly typed `approved` -> `read trust record <path>:
  <cause>`; `version` missing or any value other than 1 or 2 -> `trust
  record <path> has unsupported version <v>`. Errors are never treated as
  "not approved"; they propagate (2.8).

**Approved check** (`isApproved(dir, hash)`) returns `'approved'`,
`'not-approved'`, or `'legacy'` (record is version 1), or throws.

**Approving** (`approve(dir, hash)`):

1. Read the record.
2. Version 2 with `hash` already present: return without writing.
3. Version 2 otherwise: append `hash`, write.
4. Version 1 (legacy): replace the whole file with a version 2 record
   whose `approved` is `[hash]`. Legacy content is discarded, not
   migrated.
5. Absent: write a version 2 record `[hash]`.
6. A read error (malformed, unsupported version) aborts approval; the file
   is left untouched and the error propagates (Go parity: the user removes
   or fixes the file).

**Write procedure** (shared atomic write, 2.12): create the parent
directory with `mkdir -p` mode `0o755` (subject to umask; an existing
directory's mode is not changed), write a temp file `trust-<random>.json`
in that directory opened with mode `0o600` and exclusive create, close,
rename over `trust.json`, and remove the temp file on any failure. The
resulting `trust.json` has mode `0o600`. Error prefix on any step:
`write trust record: <cause>`.

### 2.7 `roast trust` command

```
roast trust [--config <path>] [--yes]
```

- No positional arguments (extra args are a usage error, exit 2).
- `--config <path>`: project config file; default is the nearest
  `.roast.json` between the working directory and the Git toplevel
  (config area's `loadProjectConfig`). Help text:
  `project config file (default: nearest .roast.json)`.
- `--yes`: record approval without asking; stdin is never read.
- Short help: `Approve the project config's endpoints and credentials`.

Steps, in order:

1. Resolve the Git toplevel of the working directory. Failure -> usage
   error `not inside a git repository` (exit 2).
2. Load the project config (missing config -> the config area's usage
   error naming `npx roast init`; invalid config -> usage error; both
   exit 2).
3. Compute the projection and print the trust summary (2.9) to **stdout**.
4. If `!requiresApproval`: print `Only default provider endpoints and key
   variables are used; no approval is needed.` to stdout, exit 0. Nothing
   is written; no state directory is created.
5. If not `--yes`: ask `Trust this project config? [y/N] ` on **stdout**
   and read one answer from stdin (2.10). Anything but consent -> usage
   error `not approved; nothing recorded` (exit 2), nothing written. A
   stdin read error other than EOF -> that error (exit 4).
6. `approve(toplevel, hash)`. Failure -> that error (exit 4).
7. Print `Approved for this clone.` to stdout, exit 0.

The command prompts even when the hash is already approved (approval is
idempotent). It does not check whether stdin is a terminal: with
non-terminal stdin it reads whatever is there, and EOF is a decline.

### 2.8 `requireTrust` during `review`

`requireTrust(dir, cfg, io)` runs inside `review` (including the default
bare `roast` command) after the config is loaded, both roles are resolved
(which may read stored credentials), role flag overrides and the finder
flip are applied and validated, and the Git toplevel is found; and before
the review scope is built and before any network request.
`dir` is the Git toplevel of the working directory.

1. Compute the projection. If `!requiresApproval` -> continue (nothing
   read or written).
2. `isApproved(dir, hash)`:
   - throws -> the review fails with that error. It is not a usage error,
     so the exit code is 4 (Go parity: `ExitPartial`).
   - `'approved'` -> continue.
   - `'not-approved'` or `'legacy'` -> step 3.
3. If stdin and stderr are not both terminals (`interactiveTerminals`,
   2.11): fail with a usage error (exit 2), never reading stdin.
   - not-approved message: `the project config names endpoints, credential
     variables, or prompt files that are not approved for this clone;
     review and approve them with `npx roast trust``
   - legacy message (deliberate change): states that this clone's
     approvals were recorded by an older Roast and are no longer
     accepted, and names `npx roast trust` to approve again. Wording is
     free; it must name `npx roast trust`.
4. On terminals: for `'legacy'`, first print one line to stderr saying the
   existing approvals came from an older Roast. Then print the trust
   summary (2.9) to **stderr**, ask `Trust this project config? [y/N] `
   on stderr, read one answer from stdin.
   - Declined -> usage error `project config not approved; nothing
     recorded and nothing sent` (exit 2), nothing written.
   - stdin read error other than EOF -> that error (exit 4).
   - Consent -> `approve(dir, hash)` (rewrites a legacy file as version
     2); failure -> that error (exit 4); then print `Approved for this
     clone.` to stderr and continue the review.

Untrusted is never `ExitFindings` (1), so the pre-commit gate, which
blocks only on exit 1, warns and allows the commit (gate area).

There is no environment-variable bypass of trust. CI approves with
`npx roast trust --yes`.

### 2.9 Trust summary format

Shared by `roast trust` (stdout) and the inline prompt (stderr). Every
interpolated value passes through `textsafe.line` (escapes C0 controls
including newline and tab, DEL, C1 controls, invalid UTF-8; textsafe
area), so config text cannot add lines or terminal escapes.

```
This project config sends code and credentials to:
  <selector>: profile <profile>
    endpoint:   <endpoint>
    protocol:   <protocol>
    credential: <credentialEnv or "(none named)">
  ...one 4-line block per projection profile, in projection order...
and replaces prompts with these files:
  <name>: <path>
  ...one line per prompt override...
```

The `and replaces prompts ...` header and its lines appear only when there
are prompt overrides. The summary is printed even when no approval is
needed (`roast trust`, 2.7 step 3).

### 2.10 Yes/no answer parsing

`promptNoDefault(out, reader, question)`: write `<question> [y/N] ` (no
newline), read one line up to `\n` from the shared line reader
(`00-decisions.md`: one reader per process run across prompts). EOF
without a newline still yields the partial line. Trim whitespace,
lowercase; consent only for `y` or `yes`. Empty input, EOF, `n`, `no`,
`yy`, `sure` -> decline.

### 2.11 Terminal detection

`interactiveTerminals(stdin, stderr)` is a module-level swappable function
(tests replace it). Default: true only when both streams are real TTYs
(`isTTY === true` on a `tty.ReadStream` / `tty.WriteStream`); any
non-file stream (string-backed test stream, pipe) is false.

### 2.12 Stored credential files

**Paths.**

- `projectCredentialsPath(dir)`: `<stateDir(dir)>/credentials.json`.
  Error: `project credentials: not inside a git repository`.
- `userCredentialsPath(env)`: if `env.XDG_CONFIG_HOME` is non-empty,
  `<XDG_CONFIG_HOME>/roast/credentials.json` (used as given, even if
  relative); else if `env.HOME` is non-empty,
  `<HOME>/.config/roast/credentials.json`; else error
  `user credentials: $HOME is not defined`. Read `HOME` from the injected
  environment, not `os.homedir()` (which falls back to the passwd entry
  and would defeat test isolation).

**File shape (version 1, unchanged from Go):**

```json
{
  "version": 1,
  "providers": {
    "anthropic": {
      "key": "sk-ant-...",
      "stored_at": "2026-11-14T12:00:00Z"
    },
    "openai": {
      "key": "sk-...",
      "stored_at": "2026-11-14T12:00:00.123Z"
    }
  }
}
```

- Written with 2-space indentation, top-level order `version`,
  `providers`; provider names sorted ascending; entry order `key`,
  `stored_at`; trailing newline. An empty store writes `"providers": {}`.
- `stored_at` is written in UTC as RFC 3339 with `Z`, fractional seconds
  present only when non-zero and with trailing zeros trimmed (Go's
  `RFC3339Nano` form). JavaScript `Date` has millisecond precision, so at
  most three fractional digits are produced; an existing entry's
  `stored_at` string is preserved verbatim when the file is rewritten for
  another provider.

**Loading** (`loadCredentials(path)` -> `Map<provider, Entry>`):

1. Open the file. `ENOENT` -> empty map (a missing file holds no
   credentials). Other open error -> `read credentials: <cause>`.
2. `fstat` the open descriptor (follows symlinks, like Go). If
   `mode & 0o077 !== 0` (any group or other bit, not only read) -> error
   `credentials file <path> is readable by other users (mode <perm>); run
   `chmod 600 <path>``. Never skipped, never auto-fixed.
3. Read the contents and decode. Decode errors are reported as
   `credentials file <path>: <cause>`. Decoding rejects:
   - not JSON, or trailing data after the top-level value;
   - any unknown member at the top level or inside an entry;
   - `version` missing or not the integer 1
     (`unsupported version <v> (want 1)`);
   - a provider name that `lookupProvider` does not know
     (`unknown provider "<name>"`);
   - an entry whose `key` is missing, not a string, or empty after
     trimming whitespace (`provider "<name>" has an empty key`);
   - `stored_at` present but not an RFC 3339 timestamp string.
   Accepted: `providers` missing or `null` (empty map); `stored_at`
   missing or `null` (treated as Go's zero time, written back as
   `0001-01-01T00:00:00Z` if the file is rewritten).
4. Load errors are not cached (2.13).

**Saving** (`saveCredential(path, provider, key, storedAt)`):

1. `provider` unknown -> `save credential: unknown provider "<name>"`.
2. `key.trim() === ""` -> `save credential: empty key`.
3. Load the existing file (2.12 Loading); any error aborts (so an
   over-permissive or malformed file blocks saving).
4. Set `providers[provider] = {key, stored_at: storedAt in UTC}`, replacing
   any previous entry. The key is stored as given (not trimmed).
5. Write atomically (below).

**Deleting** (`deleteCredential(path, provider)`): load (errors abort); if
the provider has no entry, or the file is missing, do nothing (no write);
else remove it and write atomically. The file remains with the other
providers, or with an empty `providers` object.

**Atomic write** for credentials:

1. `mkdir -p` the parent with mode `0o700`.
2. `chmod` the parent to `0o700` even if it already existed (tightens a
   `0o755` `.git/roast` created by the trust record, or a loose
   `~/.config/roast`).
3. Create `credentials-<random>.json` in the parent with exclusive create
   and mode `0o600`, write the bytes, close.
4. Rename over `credentials.json`. Remove the temp file on any failure.
5. Afterwards the directory holds only `credentials.json` (plus whatever
   else was there before, such as `trust.json`); no temp file survives.
6. Error prefix: `write credentials: <cause>`.

No `fsync` (Go parity).

### 2.13 Credential store (the `StoredCredentials` implementation)

Config consumes stored credentials only through:

```ts
type CredentialScope = 'project'|'user'
interface StoredCredentials {
    // Returns null when neither scope holds a key for provider.
    // Rejects when a credentials file it reaches cannot be used;
    // never skips a bad file.
    lookup(provider:string):Promise<{key:string, scope:CredentialScope}|null>
}
```

`CredentialStore(dir, env)` implements it:

- Lookup order: project scope, then user scope. The first scope whose map
  has the provider wins, returning its key and scope name.
- Files are read lazily: the project file is read on the first lookup;
  the user file only when a lookup gets past the project scope without a
  match. Each file is read at most once per store after a successful load
  (cache the loaded map, or an in-flight promise, per scope; on failure
  drop the cache entry so the next lookup retries and fails again).
- An error loading the project file rejects the lookup even if the user
  file holds the key.
- `dir === ""`: no project scope. `projectCredentialsPath` failing (not a
  repository): no project scope, cached. `userCredentialsPath` failing (no
  `XDG_CONFIG_HOME` and no `HOME`): no user scope, cached.
- The CLI constructs one store per command run with the working directory
  and injected environment, and attaches it to every config it loads
  (`withStoredCredentials`, config area). Any path that resolves roles from
  a loaded config must attach it, or stored keys are silently unused.

How config uses it (restated from the config area for context): a stored
key is consulted only after `ROAST_<ROLE>_API_KEY`, the profile's
`api_key_env`, and the provider's standard variable; only when
`providerAt(role endpoint, role protocol)` finds a provider; and the
provider name passed to `lookup` comes from that registry match, never
from anything in the project config. A rejected lookup fails role
resolution, which `review` reports as a usage error (exit 2) before any
network request.

### 2.14 Doctor (reference only; doctor area owns it)

- `config-trust` check: pass `no approval required ...` when
  `!requiresApproval`; fail when outside a Git repository, when the record
  cannot be read (`approval required; could not read approvals: <err>`),
  or when not approved (`... endpoint probes skipped; run `npx roast
  trust``); pass when approved. In TS, a `'legacy'` (version 1) record is a
  fail whose detail says `approved by an older Roast` and names
  `npx roast trust`. Doctor never prompts and never approves.
- When not trusted, doctor skips the endpoint and round-trip probes for
  every role (the probes would send credentials to an unapproved
  destination).
- `project-credentials` / `user-credentials` checks: for each scope whose
  path resolves and whose file exists (`lstat`), `loadCredentials`; fail
  with the load error, else pass with `<path> (<sorted providers>)` or
  `<path> (none stored)`. A broken file fails doctor even when environment
  credentials shadow it.

### 2.15 Security invariants enforced here

From `docs/security-model.md`, ADR-0001, ADR-0002:

1. No network request is made for a config that requires approval until
   this clone has approved its exact projection hash (review fails closed;
   doctor skips probes).
2. Approval state lives only under the Git common directory, which `git
   clone` never copies; a repository cannot ship its own approval.
3. Only `y` / `yes` records approval; `--yes` is the only non-interactive
   path. There is no environment-variable bypass.
4. Every value shown for approval is escaped, so config text cannot alter
   what the user is asked to approve.
5. Any change to an endpoint, protocol, credential variable, or
   prompt-override path invalidates the approval; other edits do not.
6. Approvals recorded by the Go implementation are never honored.
7. A malformed or unsupported trust record is an error, never read as
   "approved" or silently replaced.
8. A project config never holds a credential (config area rejects
   `api_key`); stored keys come only from credentials files outside the
   working tree.
9. A stored key is matched to a role only through the built-in provider
   registry (endpoint plus accepted protocol), so a custom endpoint, or a
   role an override moved off its provider's endpoint, never receives one.
10. Stored keys rank below every environment variable.
11. Credentials files are created `0o600` in a `0o700` directory; a file
    with any group/other permission bit stops resolution with an error
    naming `chmod 600`, never skipped.
12. A malformed credentials file (unknown provider or field, wrong
    version, empty key) is an error, never skipped.
13. Stored keys never appear in stdout, stderr, debug output, or run
    records (record area enforces exclusion from metadata; this area never
    logs a key or includes it in an error message).

## 3. TypeScript module design

```
src/config/trust.ts       projection, requiresApproval, hash v2
src/config/canonical.ts   RFC 8785 serializer for string-only documents
src/trust/trust.ts        stateDir, trustPath, record read/approve
src/credentials/credentials.ts
                          paths, load/save/delete, CredentialStore
src/fsutil/atomic.ts      writeFileAtomic (shared with trust; other areas
                          may reuse)
src/cli/trust.ts          `trust` command, requireTrust, summary, prompt
src/cli/prompt.ts         interactiveTerminals, line reader (shared)
```

`src/config/trust.ts` (pure, no I/O):

```ts
export interface TrustedProfile { /* 2.2 */ }
export interface PromptOverride { /* 2.2 */ }
export interface TrustProjection { /* 2.2 */ }
export function trustProjection(cfg:Config):TrustProjection
export function requiresApproval(p:TrustProjection):boolean
export function trustHashDocument(p:TrustProjection):HashDocument
export function trustHash(p:TrustProjection):string  // "sha256:<hex>"
```

`trustHash` uses `node:crypto` `createHash('sha256')`. Depends on the
config area's `Config`, `providerAt`.

`src/config/canonical.ts`:

```ts
export type CanonicalValue =
    string|CanonicalValue[]|{[key:string]:CanonicalValue}
export function canonicalJson(value:CanonicalValue):string
```

Throws on a string containing a lone surrogate (RFC 8785 requires
well-formed Unicode). This is a defensive backstop only: config
validation rejects lone surrogates (config area, spec.md cross-cutting
rules), so hashing never sees one.

`src/config/config.ts` (config area) exports the `StoredCredentials`
interface (2.13) so config never imports `src/credentials/` (Go keeps the
same direction: credentials imports config for `lookupProvider`).

`src/trust/trust.ts`:

```ts
export async function stateDir(dir:string, signal?:AbortSignal)
    :Promise<string>
export async function trustPath(dir:string, signal?:AbortSignal)
    :Promise<string>
export type TrustRecord =
    {kind:'current', approved:string[]}|{kind:'legacy'}
export async function readTrustRecord(path:string):Promise<TrustRecord>
export type ApprovalState = 'approved'|'not-approved'|'legacy'
export async function isApproved(dir:string, hash:string)
    :Promise<ApprovalState>
export async function approve(dir:string, hash:string):Promise<void>
```

Git runs through `execFile('git', [...], {cwd:dir})` (Git area helper).

`src/credentials/credentials.ts`:

```ts
export const CREDENTIALS_FILE = 'credentials.json'
export type CredentialScope = 'project'|'user'
export interface Entry { key:string, storedAt:string }
export async function projectCredentialsPath(dir:string):Promise<string>
export function userCredentialsPath(
    env:Record<string, string|undefined>):string
export async function loadCredentials(path:string)
    :Promise<Map<string, Entry>>
export async function saveCredential(path:string, provider:string,
    key:string, storedAt:Date):Promise<void>
export async function deleteCredential(path:string, provider:string)
    :Promise<void>
export class CredentialStore implements StoredCredentials {
    constructor(dir:string, env:Record<string, string|undefined>)
    lookup(provider:string)
        :Promise<{key:string, scope:CredentialScope}|null>
}
```

`storedAt` is kept as the original string so rewrites preserve it. The
decoder is a `zod` strict schema plus the provider/key/version checks of
2.12. Depends on `src/config` (`lookupProvider`), `src/trust`
(`stateDir`), `src/fsutil/atomic.ts`.

`src/fsutil/atomic.ts`:

```ts
export async function writeFileAtomic(path:string, data:string, opts:{
    tempPrefix:string     // 'trust-' | 'credentials-'
    dirMode:number        // 0o755 | 0o700
    chmodDir:boolean      // false for trust, true for credentials
    errorPrefix:string    // 'write trust record' | 'write credentials'
}):Promise<void>
```

Temp name: `<tempPrefix><random hex>.json`, opened with flags `wx` and
mode `0o600`.

`src/cli/trust.ts`:

```ts
export async function requireTrust(dir:string, cfg:Config,
    io:CliIo):Promise<void>        // throws UsageError or Error
export function writeTrustSummary(out:Writable,
    p:TrustProjection):void
export async function promptNoDefault(out:Writable,
    lines:LineReader, question:string):Promise<boolean>
export function trustCommand(...):CommandModule  // yargs
```

`CliIo` is the in-process `run(argv, io)` bundle (stdin, stdout, stderr,
env, cwd, shared line reader). `UsageError` maps to exit 2; other errors
to exit 4 (cli area). Debug namespace `roast:trust` and
`roast:credentials`: may log paths, scope names, provider names, record
versions, and hashes; never a key.

## 4. Deliberate changes

- **Trust hash v2** (decision 4, ADR-0003): SHA-256 over RFC 8785
  canonical JSON of the hash document in 2.4, `trust.json` `version: 2`.
  A version-1 record is never an approval: review fails as untrusted
  (exit 2, message says approved by an older Roast, names
  `npx roast trust`; on terminals the normal inline trust prompt is
  offered, as for any untrusted config); approving
  rewrites the file as version 2 with only the new hash. Differences from
  the Go hash document beyond the algorithm: empty arrays serialize as
  `[]` (Go wrote `null`), destination sort uses UTF-16 code units per
  field instead of bytes of NUL-joined fields. The stored form stays
  `sha256:<lowercase hex>`, and the test vectors in 2.4 are frozen.
- **Credentials keys are case-sensitive** (deliberate change 7): Go
  matched `credentials.json` field names case-insensitively
  (`{"Version":1,"Providers":...}` loaded); TS matches exactly, so such a
  file is rejected as an unknown member. Files Roast wrote are unaffected.
- **Windows dropped** (decision 2): the Go `runtime.GOOS != "windows"`
  guard on the permission check disappears; the check always runs.
- **Debug tracing** (decision 5): `roast:trust`, `roast:credentials`; no
  keys.

## 5. Test plan

Seams: CLI in-process (`run(argv, io)` with a `node:http` fake inference
server and swappable `fetch`) unless noted. Every CLI test runs in a temp
Git repository and isolates `HOME` and `XDG_CONFIG_HOME` in the injected
env. Assert exit codes, files, and requests received; never exact text,
except that a message names `npx roast trust` (behavioral contract).

### 5.1 Projection and approval need (unit, `src/config/trust.ts`)

- Table of single-profile configs and whether they need approval: OpenAI
  responses/chat with standard or no key var; implicit endpoint; implicit
  protocol; trailing slash; Anthropic; OpenRouter chat/responses with
  standard or no key; custom key var on each provider; another provider's
  key var; mismatched protocol; gateway with and without key var
  (TestStandardProfilesNeedNoApproval).
- Projection order: roles sorted, author routes sorted after their role;
  unselected profiles excluded; prompt overrides in fixed order (new).

### 5.2 Hash v2 (unit)

- Known-answer vectors 1 and 2 from 2.4 (new).
- Duplicate destinations collapse; destination order independent of role
  order; profile renames and selector changes keep the hash (new).
- `canonicalJson` matches RFC 8785 on key ordering and string escaping,
  including a non-ASCII key and a control character (new).
- Destinations sort field by field in UTF-16 code unit order (a case with
  an astral character versus a BMP character above U+E000); empty lists
  hash as `[]` (new).
- `canonicalJson` throws on a lone surrogate; the config area rejects one
  before hashing (new).

### 5.3 Trust record (unit, `src/trust/trust.ts`, temp Git repo)

- Absent file: not approved; approve writes version 2 with one hash, mode
  `0o600` (new).
- Approve twice: one entry (new).
- Version 1 file: `isApproved` returns `'legacy'`; approve replaces it
  with version 2 `[hash]` (new).
- Malformed JSON, `version: 3`, missing version, non-array `approved`:
  `isApproved` and `approve` both throw; file unchanged (new).
- Linked worktree resolves the same path (covered at CLI below).

### 5.4 Review and the trust command (CLI)

- Built-in-only config with author route reviews with no trust state
  written (TestDefaultEndpointConfigNeedsNoApproval).
- Untrusted config: exit neither 0 nor 1, message names `npx roast trust`,
  zero requests (TestUntrustedConfigFailsClosedBeforeAnyRequest).
- Summary names every profile, endpoint, protocol, credential var, prompt
  path, and asks `[y/N]` (TestTrustSummaryNamesEverySecurityRelevantValue;
  assert presence of config values only).
- Control characters in profile names, route families, and prompt paths
  never reach stdout raw; no config value starts its own line
  (TestTrustSummaryEscapesControlCharacters).
- `trust` records only on `y`/`Y`/`yes`/`y` without newline; `""`, `\n`,
  `n`, `no`, `yy`, `sure` exit non-zero, record nothing, and the next
  review still fails closed (TestTrustRecordsApprovalOnlyOnYes).
- `trust --yes` never reads stdin and enables the review
  (TestTrustYesRecordsWithoutReadingStdin).
- Model, threshold, limit, and gate edits keep approval
  (TestNonSecurityEditsKeepApproval).
- Endpoint, routed endpoint, protocol, credential var, and prompt path
  edits require re-approval, and re-approval works
  (TestSecurityEditsRequireApprovalAgain).
- Approval in the main worktree is honored in a linked worktree, and not
  before (TestApprovalIsSharedWithLinkedWorktrees).
- Inline prompt on simulated terminals: `y` approves, summary on stderr,
  record written, later non-terminal review passes
  (TestInlineTrustPromptApprovesOnYes).
- Inline decline (`""`, `\n`, `n`, `no`, `yy`): asks `[y/N]`, no requests,
  no record (TestInlineTrustPromptDeclinedSendsNothing).
- Non-terminal review checks for terminals, never reads stdin, never
  prompts, names `npx roast trust`
  (TestNonTerminalReviewFailsClosedWithoutPrompting).
- Default terminal detection rejects non-TTY streams
  (TestDefaultTerminalDetectionRejectsNonFiles; unit).
- Legacy record: review exits 2 with zero requests; `trust --yes` then
  makes it pass and the file is version 2; on simulated terminals `y`
  approves inline (new).
- Malformed record: review exits 4 with zero requests (new, Go parity;
  resolved in spec.md "Kept as Go does").

### 5.5 Credentials (unit, `src/credentials/credentials.ts`)

- Project path is `<git-common-dir>/roast/credentials.json`
  (TestProjectPathIsInsideTheGitCommonDir).
- User path follows `XDG_CONFIG_HOME`, else `HOME/.config`
  (TestUserPathFollowsXDGConfigHome).
- Save writes `0o600` in `0o700`, replaces atomically, leaves only the
  file, round-trips keys and `stored_at`
  (TestSaveWritesAPrivateFileAndReplacesItAtomically).
- Save tightens an existing `0o755` directory
  (TestSaveTightensAnExistingDirectory).
- Delete removes one provider; deleting from a missing file is a no-op
  (TestDeleteRemovesOneProvider).
- Missing file loads empty (TestLoadMissingFileIsEmpty).
- Rejects unknown provider, unknown entry field, unknown top-level field,
  missing version, wrong version, empty key, non-JSON
  (TestLoadRejectsMalformedFiles).
- Member names match exactly: `{"Version":1,...}` and `"Providers"` or
  `"Key"` spellings are rejected as unknown members (new, deliberate
  change 7).
- Rejects modes `0o640`, `0o604`, `0o644`
  (TestLoadRejectsAFileOthersCanRead); add `0o620` (any group/other bit).
- Store prefers project over user scope
  (TestStorePrefersProjectScopeOverUserScope).
- Outside a repository only user scope is used
  (TestStoreOutsideARepositoryUsesOnlyUserScope).
- A bad file rejects the lookup (TestStoreReportsABadFile).

### 5.6 Stored credentials through review and doctor (CLI)

- Project stored key reaches the fake Anthropic endpoint
  (TestReviewSendsAProjectStoredKey).
- Env beats project beats user (TestEnvironmentBeatsProjectBeatsUserStoredKeys).
- Stored key never reaches a custom endpoint
  (TestStoredKeyNeverReachesACustomEndpoint).
- Stored key does not follow an endpoint override
  (TestStoredKeyDoesNotFollowAnEndpointOverride).
- An over-permissive file in either scope fails the review with zero
  requests (TestACredentialsFileOthersCanReadFailsTheReview).
- No copy of the stored key in stdout, stderr, or any run-record file
  (TestReviewLeavesNoCopyOfAStoredKey).
- Doctor reports a stored credential and its scope; fails a broken file;
  reports a usable file; still runs other checks with a broken file
  (TestDoctorReportsAStoredCredentialAndItsScope,
  TestDoctorFailsABrokenCredentialsFile,
  TestDoctorReportsAUsableCredentialsFile,
  TestDoctorRunsItsOtherChecksWithABrokenCredentialsFile; doctor area).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/config/trust.go` -- projection, `RequiresApproval`, v1 `Hash`.
- `internal/config/provider.go` -- registry, `LookupProvider`,
  `ProviderAt`.
- `internal/config/config.go` -- `StoredCredentials`, `sameEndpoint`,
  `DefaultBaseURL`, `normalizeProfile`, `resolveCredential`,
  `ambientCredential`, `storedCredential`.
- `internal/trust/trust.go` -- `StateDir`, `Path`, record read/approve.
- `internal/cli/trust.go` -- `requireTrust`, `writeTrustSummary`,
  `promptNoDefault`, `trust` command.
- `internal/cli/prompt.go` -- `interactiveTerminals`.
- `internal/cli/config.go` -- `loadProjectConfig`,
  `withStoredCredentials`.
- `internal/cli/cli.go` -- `requireTrust` call site in review, exit codes.
- `internal/cli/doctor.go` -- `doctorTrustCheck`,
  `doctorStoredCredentialChecks`.
- `internal/credentials/credentials.go` -- paths, load/save/delete,
  `Store`.
- Tests: `internal/config/trust_test.go`, `internal/cli/trust_test.go`,
  `internal/cli/trust_prompt_test.go`,
  `internal/credentials/credentials_test.go`,
  `internal/cli/stored_credentials_test.go`.
- Docs: `docs/adr/0001-trusted-project-config.md`,
  `docs/adr/0002-stored-credentials.md`, `docs/adr/0003-trust-hash-v2.md`,
  `docs/security-model.md`.

## 7. Resolved

1. A Go-era (version 1) record gets the normal inline trust prompt on a
   terminal (spec.md, deliberate change 4 and ADR-0003).
2. The stored hash format stays `sha256:<lowercase hex>` (spec.md, ADR-0003).
3. Destinations sort field by field in UTF-16 code unit order and empty
   lists hash as `[]`; the test vectors are frozen (spec.md, ADR-0003).
4. Config validation rejects lone surrogates, so hashing never sees one
   (spec.md, cross-cutting rules, "Bytes and text").
5. `credentials.json` keys match exactly, case-sensitive (spec.md,
   deliberate change 7).
6. A malformed trust record exits 4, Go parity (spec.md, "Kept as Go does").
