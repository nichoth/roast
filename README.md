# Roast

An adversarial, cross-model code reviewer. Install as a project dependency.

A finder model proposes defects in a Git diff, each with a
code quote and a concrete fix. An independent verifier model then re-reads the
cited code and confirms or refutes every claim before it reaches the report.
The two roles can use different providers, endpoints, and wire protocols.

In interactive mode, the models can navigate the local checkout
via read-only file, grep, and listing tools.

<details><summary><h2>Contents</h2></summary>

<!-- toc -->

- [Fork](#fork)
- [Quick start](#quick-start)
  * [1. Install](#1-install)
  * [2. Create the project config](#2-create-the-project-config)
  * [3. Login](#3-login)
  * [4. Review](#4-review)
- [Install the agent skill](#install-the-agent-skill)
- [Configure](#configure)
  * [Project config](#project-config)
  * [Credentials](#credentials)
  * [Login and logout](#login-and-logout)
  * [OpenRouter](#openrouter)
  * [Command-line overrides](#command-line-overrides)
  * [Author routes](#author-routes)
  * [Other settings](#other-settings)
  * [Network](#network)
- [Trust](#trust)
- [Use](#use)
- [Resource limits](#resource-limits)
- [Exit codes](#exit-codes)
- [Run records](#run-records)
- [Pre-commit gate](#pre-commit-gate)
- [Contributing](#contributing)
- [License](#license)

<!-- tocstop -->

</details>

## Fork

This is a fork of
[bluesky-social/roast](https://github.com/bluesky-social/roast).
The fork adds `npm` ecosystem.


## Quick start

Roast runs in a Git repository with a `package.json`. It needs Node 22.18
or later on macOS or Linux. Windows is not supported.

The [agent skill](#install-the-agent-skill) is optional.
Install it if you want a coding agent, such as Claude Code,
to run reviews for you.

### 1. Install

```sh
npm i -D @substrate-system/roast
```

`npx roast --version` prints the installed version, commit, and build
date.

### 2. Create the project config

```sh
npx roast init
```

This writes `.roast.json` in the current directory and adds `/.roast/` to
`.gitignore`. Command `init` picks each role's provider from its
model ID:

- a bare Claude model ID (`claude-opus-5-5`) uses Anthropic's Messages API
- a bare OpenAI model ID (including Codex, `gpt-6.1-terra`) uses OpenAI's
  Responses API
- a slash-form ID, `<vendor>/<model>` with an optional `:<variant>`
  (`anthropic/claude-opus-5-5`, `meta-llama/llama-4:free`), uses
  [OpenRouter](#openrouter).

Either model can fill either role. It's recommended to use models from different 
providers for each roles. For a model no built-in provider serves,
edit `.roast.json` by hand (see [Project config](#project-config)).
Without the flags, `init` writes placeholder model IDs,
and a review refuses to run until you replace them in `.roast.json`.

In the terminal, `init` then offers to log in to each provider
that has no credential yet (see [Login and logout](#login-and-logout)).

Flag `--no-login` skips the login process.


#### `init` Example

Claude as the finder and Codex as the verifier:

```sh
npx roast init --finder-model 'claude-opus-5-5' \
  --verifier-model 'gpt-6.1-terra'
```

`init` refuses to overwrite an existing `.roast.json`.


### 3. Login

If you skipped the login process during `init`, log in now:

```sh
npx roast login
```

With no argument, `login` reads `.roast.json` and logs in to each built-in
provider that has no credentials yet. For Anthropic and OpenAI,
it opens the provider's API-keys page. Create a key and paste it into the
hidden prompt. For OpenRouter, it opens OpenRouter in your browser and
receives a new key when you approve. The key is stored for this project
inside `.git`, so it is never committed, and every later review, including
the [pre-commit gate](#pre-commit-gate), finds it.

Environment variables still work and take precedence over a stored key,
which suits CI:

```sh
export OPENAI_API_KEY='...'      # platform.openai.com/api-keys
export ANTHROPIC_API_KEY='...'   # console.anthropic.com/settings/keys
export OPENROUTER_API_KEY='...'  # openrouter.ai/settings/keys
```

To see which models an OpenAI key can use:

```sh
curl -s https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY" | jq -r '.data[].id'
```

### 4. Review

```sh
npx roast doctor
npx roast review --task 'add retry handling'
```

`npx roast doctor` checks the config, credentials, and both endpoints with a
small probe.

`npx roast review` reviews your changes and prints a report.

A review needs an API key for the provider of each role's model, either
stored with `npx roast login <provider>` or set in that provider's variable:
`ANTHROPIC_API_KEY` for Anthropic's endpoint, `OPENAI_API_KEY` for OpenAI's,
and `OPENROUTER_API_KEY` for OpenRouter's.

With both roles on Anthropic's endpoint, one Anthropic key is enough.
Flags `--quick` and `--no-verify` skip the verifier, so they need only the
finder's key. To give a role its own key,
set `ROAST_FINDER_API_KEY` or `ROAST_VERIFIER_API_KEY`. If a key is missing,
the review exits with an error, naming `npx roast login <provider>`, before
it calls any model. See [Credentials](#credentials) for the full lookup
order.

The starter config only uses the built-in endpoints and key variables, so it
needs no approval. If you change a profile's endpoint or credential variable,
see [Trust](#trust).


## Install the agent skill

The agent skill is a `SKILL.md` file that teaches a coding agent, such as
Claude Code, how to use Roast. Agents that support Agent Skills load it from a
skills directory. It tells the agent when a change deserves a review, which
`npx roast review` invocations to run, and how to read the exit codes. It
also says to check each finding against the cited code before acting on it.
And it tells the agent never to approve a project config itself, but to leave
the `npx roast trust` decision to you. The skill ships inside the Roast
package, so the installed copy matches the version you run.

```sh
npx roast skill install
npx roast skill status
```

By default this installs the bundled skill into the project, at the Git
toplevel: `.agents/skills/roast`, and also `.claude/skills/roast` when Claude
Code is detected or the project already has a `.claude/` directory. Commit
those directories to share the skill with your team. `--global` installs into
the user-level directories instead: `~/.agents/skills/roast`,
`$CLAUDE_CONFIG_DIR/skills/roast` (default `~/.claude/skills/roast`) when
Claude Code is detected, and `$XDG_CONFIG_HOME/polytoken/skills/roast`
(default `~/.config/polytoken/skills/roast`) when Polytoken is detected.
`--dir` limits either command to one parent skills directory. `--force`
overwrites installed files that differ from the bundled skill.

`npx roast skill status` reports whether each installed copy matches the
installed Roast version.

---

## Configure

### Project config

Every setting except credentials lives in `.roast.json` (JSONC: comments and
trailing commas are allowed). Roast looks for it in the working directory and
then in each parent directory, stopping at the Git toplevel; the first one
found wins, and files are never merged. `--config <path>` names a different
file. When there is no project config, Roast exits with an error telling you
to run `npx roast init`. There are no built-in default models.

```jsonc
{
  "$schema": "./node_modules/@substrate-system/roast/roast.schema.json",
  "version": 1,

  "inference_profiles": {
    "openai": {
      "endpoint": "https://api.openai.com/v1",
      "protocol": "responses",
      "api_key_env": "OPENAI_API_KEY",
      "model": "finder-model"
    },
    "anthropic": {
      "endpoint": "https://api.anthropic.com/v1",
      "protocol": "anthropic",
      "api_key_env": "ANTHROPIC_API_KEY",
      "model": "verifier-model",
      "max_output_tokens": 32768
    }
  },

  "roles": {
    "finder": {"profile": "openai"},
    "verifier": {"profile": "anthropic"}
  }
}
```

`version: 1` is required and unknown fields are rejected. `$schema` points
your editor at the JSON Schema shipped in the package, for completion and
validation.

A profile is a complete unit: `model`, `endpoint`, `protocol`, output-token
limit (`max_output_tokens`, default 32,768), and credential variable
(`api_key_env`). Roast never infers a protocol or credential from a model
name. Protocols are `responses` and `chat` (OpenAI-compatible, default
endpoint `https://api.openai.com/v1`) and `anthropic` (native Messages, which
authenticates with `x-api-key`, default endpoint
`https://api.anthropic.com/v1`). A profile can point at a hosted provider, a
gateway, or a local server that implements its protocol:

```jsonc
"inference_profiles": {
  "gateway": {
    "endpoint": "https://models.example.com/v1",
    "protocol": "chat",
    "api_key_env": "GATEWAY_API_KEY",
    "model": "gateway-model"
  }
}
```

A config that names an endpoint other than a built-in provider's must be
approved once per clone; see [Trust](#trust).

### Credentials

A project config may name a credential variable but never hold a credential;
a literal `api_key` field is rejected. Roast has three built-in providers,
each with a built-in endpoint and a standard key variable:

| Provider | Endpoint | Protocols | Key variable |
| --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `responses`, `chat` | `OPENAI_API_KEY` |
| `anthropic` | `https://api.anthropic.com/v1` | `anthropic` | `ANTHROPIC_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `chat`, `responses` | `OPENROUTER_API_KEY` |

A role's credential is the first of:

1. `ROAST_FINDER_API_KEY` or `ROAST_VERIFIER_API_KEY`;
2. the variable named by the profile's `api_key_env`;
3. the provider's standard key variable;
4. the provider's key stored for this project by `npx roast login`;
5. the provider's key stored for your user by `npx roast login --global`.

Steps 3 to 5 apply only when the profile uses a built-in provider's endpoint
with a protocol that provider accepts there. A provider key in your shell,
or a stored key, is never sent to a gateway or any other custom endpoint,
and never follows a role that an override moved off its provider's
endpoint. A stored key is matched to a role only by that endpoint and
protocol, never by anything `.roast.json` names. A custom endpoint needs
`api_key_env` or a role key (`ROAST_FINDER_API_KEY` or
`ROAST_VERIFIER_API_KEY`). `npx roast doctor` reports which source each role
used, including a stored key and its scope, and names a provider key it
withheld.

### Login and logout

`npx roast login` gets a key for a built-in provider and stores it, so
reviews and the pre-commit gate find it without an environment variable.

```sh
npx roast login                       # every provider .roast.json needs
npx roast login anthropic             # one provider: anthropic, openai,
                                      # or openrouter
npx roast login openrouter --global   # store for your user, not the project
npx roast login openrouter --no-browser
npx roast logout anthropic            # remove one stored key
npx roast logout --global             # remove every user-scope key
```

With no argument, `login` logs in to each built-in provider that the roles
in `.roast.json` use and that has no credential yet; it does nothing when
every role already has one. With a provider argument, it always runs and
replaces any key stored for that provider in the chosen scope. Login needs
an interactive terminal.

- **Anthropic and OpenAI** have no browser sign-in that third-party tools may
  use. Roast opens the provider's API-keys page; you create a key and paste
  it into a prompt that does not echo. Roast checks the key with one small
  authenticated request and stores it only if the provider accepts it. A
  rejected key asks again, up to three tries.
- **OpenRouter** uses its browser login for third-party tools. Roast opens
  OpenRouter, you approve, and OpenRouter returns a new key labeled `roast`
  directly to Roast; nothing is copied by hand. With `--no-browser` (or on
  Linux without a display), Roast prints the URL instead and asks for the
  code the page shows.

Roast always prints the URL it opens, so a missing browser does not block
login. Login prints only the provider and scope it stored, never the key.

Keys are stored in one of two scopes:

- **Project** (the default): `.git/roast/credentials.json`, in the Git common
  directory. It is never committed or copied by `git clone`, and linked
  worktrees share it. Outside a Git repository, use `--global`.
- **User** (`--global`): `$XDG_CONFIG_HOME/roast/credentials.json`, or
  `~/.config/roast/credentials.json` when `XDG_CONFIG_HOME` is unset.

Both files are written with mode 0600 in a 0700 directory. On Unix, Roast
refuses a credentials file that group or others can read and says to
`chmod 600` it. `npx roast doctor` reports a credentials file that is too
open or does not parse.

`npx roast logout [provider]` removes the stored key for one provider, or
for every provider with no argument, from the project scope, or the user
scope with `--global`. It does not revoke the key at the provider; revoke it
on the provider's key page, which `logout` names.

### OpenRouter

[OpenRouter](https://openrouter.ai) serves many vendors' models through one
account and one bill. Give `init` OpenRouter's slash-form model IDs:

```sh
npx roast init --finder-model 'anthropic/claude-opus-5-5' \
  --verifier-model 'openai/gpt-6.1-terra'
```

A bare ID (`claude-opus-5-5`) goes to that vendor's own API; a slash-form ID
(`<vendor>/<model>`, optionally `:<variant>`) goes to OpenRouter. When one
role is on OpenRouter and the other model is omitted, the placeholder role
goes on OpenRouter too. The starter profile looks like this:

```jsonc
"openrouter": {
  "endpoint": "https://openrouter.ai/api/v1",
  "protocol": "chat",
  "api_key_env": "OPENROUTER_API_KEY",
  "model": "anthropic/claude-opus-5-5"
}
```

Run `npx roast login openrouter`, or set `OPENROUTER_API_KEY`. A profile on
OpenRouter's endpoint with protocol `chat` or `responses` and either no
`api_key_env` or `OPENROUTER_API_KEY` needs no [trust](#trust) approval, the
same as OpenAI and Anthropic. `OPENROUTER_API_KEY` is read only for
OpenRouter's endpoint.

### Command-line overrides

`npx roast review` accepts per-role overrides: `--finder-model`,
`--finder-protocol`, `--finder-base-url`, `--finder-max-output-tokens`, and
the same four for the verifier. Flags take precedence over the project config,
which takes precedence over built-in defaults. An endpoint override carries
the role key or the profile's own credential to the endpoint it names, but a
provider key from the shell, or a stored key, only to that provider's
built-in endpoint.

### Author routes

When the invoking agent passes `--author-model`, the finder can switch to
another profile by exact model name or model family, so a model is not
reviewing its own work. Here `primary` and `independent` are profiles defined
under `inference_profiles`:

```jsonc
"roles": {
  "finder": {
    "profile": "primary",
    "author_routes": {
      "openai": "independent",
      "exact-author-model": "independent"
    }
  },
  "verifier": {"profile": "independent"}
}
```

`roles.finder.pin: true` keeps the configured finder anyway, with a warning.

### Other settings

| Key | Default | Effect |
| --- | --- | --- |
| `review.excludes` | none | Git pathspecs excluded from every review, in addition to `--exclude`. |
| `review.confidence_floor` | `0.6` | Findings below this finder confidence (0-1) are dropped before verification and listed under `dropped_findings`. `0` selects the default. |
| `review.quick_confidence_floor` | `0.8` | The same floor for `--quick` reviews, which skip verification. |
| `review.snapshot` | `true` | `false` skips Git snapshot capture, so a run cannot be checked out later. |
| `interactive.min_files`, `interactive.min_diff_lines` | `4`, `80` | Below both sizes, an `--interactive` review uses a single structured finder call. `0` disables the threshold. |
| `roles.finder.pin` | `false` | Ignore `author_routes` even when the author shares the finder's model family. |
| `inference_profiles.<name>.session_header` | none | Also send the per-conversation session ID under this header name, for gateways that key sessions on their own header (for example `x-opencode-session`). It must be a valid header name and cannot name a credential or framing header, or one Roast or the provider SDK sets. |
| `prompts.finder_code`, `prompts.finder_prose`, `prompts.verifier` | built in | Paths to prompt overrides; a relative path is relative to the directory holding `.roast.json`. |

The `limits` and `gate` sections are described under
[Resource limits](#resource-limits) and [Pre-commit gate](#pre-commit-gate).
`npx roast init` writes them as commented-out defaults.

Runs record the profile name and resolved non-secret settings, never API keys.
The invocation argv is recorded, so keep secrets out of command-line values.

### Network

Roast uses Node's built-in `fetch` and bundles no proxy library. Behind
a proxy, set `NODE_USE_ENV_PROXY=1` so Node honors `HTTPS_PROXY`,
`HTTP_PROXY`, and `NO_PROXY`; without it those variables are ignored,
and `npx roast doctor` warns when `HTTPS_PROXY` is set alone. For a
private or corporate certificate authority, point
`NODE_EXTRA_CA_CERTS` at a PEM file holding its certificate:

```sh
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://proxy.example.com:8080
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corporate-ca.pem
npx roast review
```

## Trust

Because `.roast.json` is committed, a repository you clone could point a
profile at an evil endpoint, or name your provider key as its
credential. Roast therefore **asks you to approve the security-relevant parts**
**of a project config once per clone**, before it sends code or credentials
anywhere the config names.

A config needs no approval when every selected profile uses a built-in
provider's endpoint (OpenAI, Anthropic, or OpenRouter) with a protocol that
provider accepts and either no `api_key_env` or that provider's standard key
variable, and it sets no prompt overrides.

```sh
npx roast trust         # show the summary and ask [y/N]
npx roast trust --yes   # approve without asking, for example in CI
```

`npx roast trust` prints the profile, endpoint, protocol, and credential
variable for each role and author route, plus any prompt-override paths, and
records the approval only when you answer `y`. When `npx roast review` finds an
unapproved config in a terminal, it shows the same summary and asks inline;
without a terminal it exits with code 2 and a message naming
`npx roast trust`. No request is made before approval.

An approval covers only the security-relevant parts, so editing a model, a
threshold, a limit, or a gate setting does not ask again; changing an
endpoint, protocol, credential variable, or prompt-override path does.
Approvals are stored in the Git common directory, so linked worktrees share
them and `git clone` never copies them. To withdraw every approval for a
clone, delete `.git/roast/trust.json`. `npx roast doctor` reports whether the
config needs approval and whether it has it. There is no environment variable
that bypasses trust. The [security model](docs/security-model.md) explains the
design.

## Use

Run Roast inside a Git repository:

```sh
npx roast review --task 'add retry handling'   # review the current changes
npx roast review --staged --max-severity HIGH  # staged changes; exit 1 on HIGH+
npx roast review --interactive                 # let the finder navigate
npx roast review --quick                       # finder only, no verification
npx roast review --scope repo                  # survey the whole repository
npx roast runs                                 # list local runs
npx roast runs show <run-id>
npx roast runs checkout <run-id>
npx roast doctor
```

The default scope is committed changes since the best available main branch,
plus uncommitted and untracked changes. Untracked files that look like secrets
(`.env*`, `*.pem`, `*.key`, SSH keys such as `id_ed25519*`, and similar) are
skipped with a note on stderr. JSON goes to stdout and Markdown to stderr;
`--format` selects one.

`--interactive` gives the finder several turns with the navigation tools.
Small diffs (under 80 lines and 4 files) get a single structured call
instead, and Roast says so; the `interactive` config section changes those
thresholds. `--quick` turns navigation off. `--scope repo` always navigates
and rejects `--quick`.

The finder and verifier must submit schema-validated results through a tool
call. A role that never does gets bounded reminders within its limits; if it
still fails, the run is reported incomplete, never clean.

`npx roast doctor` reports the project config path and its trust state,
validates profiles and credentials, checks each model-listing endpoint, runs a
small two-turn tool loop per configured model (a tool call, its result, and
the final submission, as a review does), and reports Git, gate, and
user-level Agent Skill status. It does not probe the endpoints of a config
this clone has not approved. `--json` gives machine-readable output.

## Resource limits

Defaults are generous enough for slow local models.
Change the `limits` section of `.roast.json` to adjust.
Durations are strings such as `"90s"` or `"10m"`.

| Control | Default | Override |
| --- | ---: | --- |
| Output tokens per model call | 32,768 | Profile `max_output_tokens` or `--{finder,verifier}-max-output-tokens` |
| Timeout per inference request | 10 minutes | `limits.request_timeout` or `--request-timeout`; `0` disables |
| Interactive finder work deadline | 10 minutes | `limits.deadline` or `--deadline`; `0` disables |
| Repository-survey work deadline | 25 minutes | `limits.deadline` or `--deadline`; `0` disables |
| Provider/structured-output attempts | 4 | `limits.max_attempts` or `--max-attempts` |
| Shared finder/verifier token budget | 3,000,000 | `limits.max_total_tokens` or `--max-tokens-total`; `0` disables |
| Findings sent to the verifier | 25 | `limits.max_verified` or `--max-verified`; `0` disables |
| Diff bytes, normal / quick (also caps each file's section) | 1,000,000 / 200,000 | `limits.max_diff_bytes` |
| File-context bytes, normal / quick | 400,000 / 100,000 | `limits.max_file_ctx_bytes` |
| Initial finder prompt bytes | 8,000,000 | `limits.max_prompt_bytes` |

Interactive runs default to 16 finder turns, and surveys of the repository
default to 40 (`--max-turns`). Past roughly 3 MB of conversation, Roast tells
the finder to stop exploring and submit; a work deadline leaves a separate
90-second window for that final submission.

Fixed caps protect memory and artifacts: 16 MiB per captured provider
response; 64 KiB per `git_diff` window and per `read_file`, `grep_repo`, or
`list_files` result; `read_file` lines truncated at 32 KiB, 2,000 lines per
window; `grep_repo` lines truncated at 2 KiB; at most 500 listed paths and 200
matching lines.

Invalid or negative values are usage errors, not silent fallbacks. Resolved
limits are recorded with each run.

## Exit codes

| Code | Meaning | `error_category` |
| ---: | --- | --- |
| 0 | Completed; no explicit severity threshold met | `none` |
| 1 | A finding met the `--max-severity` threshold | `findings` |
| 2 | Invalid invocation or configuration, including an unapproved config | `usage` |
| 3 | Inference authentication failed | `auth` |
| 4 | Operational failure or incomplete result | `endpoint`, `resource_limit`, or `partial` |
| 5 | Cancelled or terminated | `cancelled` |

Without `--max-severity`, a completed review exits 0 even if it has findings.

`--error-format json` writes diagnostics to stderr as JSON without changing
review output:

```json
{ "error_category": "endpoint", "message": "...", "exit_code": 4 }
```

## Run records

Every non-empty review is recorded under `.roast/runs/` at the Git toplevel,
even when you run Roast from a subdirectory. When Roast creates `.roast/` it
writes a `.gitignore` inside it containing `*`, so records are never committed
by accident; `npx roast ignore` (which `init` runs for you) also adds
`/.roast/` to the toplevel `.gitignore` to make the rule visible. A run holds
the secret-free role configuration, argv, exact prompts and reviewed input,
raw provider response bodies (streamed SSE kept byte-for-byte, including
partial streams from failed attempts), usage, results, a Git snapshot, and a
deterministic `bundle.tar.zst` whose manifest lists every artifact's size and
SHA-256. Requests, HTTP headers, and credentials are never recorded. Run
directories are kept until you delete them.

The navigation tools read the snapshot, not the live checkout: the captured
index for `--staged`, otherwise the captured worktree including non-ignored
untracked files. Editing files mid-review changes nothing the models see.

Snapshots are Git refs under `refs/roast/snapshots/`.
`npx roast runs checkout <run-id> [dir]` restores one as a detached linked
worktree, with the reviewed contents on disk and the reviewed index staged, so
`git status` and `git diff` show exactly what was reviewed.
`npx roast runs prune` removes snapshot refs older than 30 days (`--dry-run`
to preview) but never run directories. Setting `review.snapshot` to `false`
skips snapshot capture, so such a run cannot be checked out.

## Pre-commit gate

```sh
npx roast gate enable
npx roast gate status
npx roast gate disable
```

The gate runs a `--quick` review of the staged content on each commit and
blocks only when a finding meets the severity threshold. The hook runs
the locally installed `roast`, not a `roast` on your
`PATH`. (Always uses the project's pinned version.) It fails open: a
missing `node_modules/.bin/roast`, an unapproved config, failed inference,
empty output, or a timeout prints a warning and allows the commit.

The hook runs from the Git toplevel and loads the `.roast.json` there, so
`npx roast gate enable` refuses, and a review does not offer the gate, when
the project config lives only in a subdirectory.

The first interactive review in a repository asks once whether to enable the
gate and records the answer in local Git config; non-interactive runs never
install a hook without that consent. Setting `gate.offer` to `false` skips the
question. With a shared `core.hooksPath`, each repository still needs its own
opt-in, and disabling one leaves the dispatcher in place for the others.

| Setting | Effect |
| --- | --- |
| `gate.timeout_seconds` | Seconds before an unfinished review is stopped and the commit allowed. Default `180`; `0` disables. |
| `gate.severity` | Lowest blocking severity: `INFO`, `LOW`, `MEDIUM`, `HIGH` (default), or `CRITICAL`. |
| `gate.offer` | Whether the first interactive review offers to enable the gate. Default `true`. |
| `ROAST_SKIP` | Environment variable. Any non-empty value (conventionally `1`) skips one commit. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and release
steps, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

Dual-licensed under [MIT](LICENSE-MIT.txt) or
[Apache 2.0](LICENSE-APACHE.txt), at your option. Bundled libraries keep
their own licenses: the build checks each against an allowed set and ships
their notices in `dist/THIRD_PARTY_LICENSES.txt`.
