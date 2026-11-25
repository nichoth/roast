# Security model

Roast reviews source code by sending selected repository material to inference
services. This document describes the boundaries operators should understand;
it is not a promise that a model or provider will handle untrusted input safely.

## Trusted configuration

Every non-secret setting comes from the project config, `.roast.json`, which
is committed with the code; credentials come from environment variables or
from stored credentials outside the repository, and the project config may
name a credential variable but never hold a credential. Roast is installed as a project dependency, so the repository's
lockfile already decides which Roast binary runs and its npm scripts can
already run code with the user's environment. Refusing a repository-local
config file would therefore protect nothing. What still needs protecting is
the developer's credentials and code: a cloned repository must not be able to
silently send a provider key, or the code under review, somewhere the
developer has not agreed to.

Roast therefore trusts a project config per clone (ADR-0001). The
security-relevant projection of a config is, for every profile selected by a
role or an author route, its resolved endpoint, protocol, and credential
variable name, plus every prompt-override path. Prompt overrides are included
because they name local files whose contents are sent to the configured
endpoints. A config whose selected profiles all use a built-in provider's
endpoint (OpenAI, Anthropic, or OpenRouter) with a protocol that provider
accepts and either no credential variable or that provider's standard key
variable, and which sets no prompt overrides, needs no approval. OpenRouter
with any other credential variable still needs approval. Any other config must be
approved before Roast sends code or credentials anywhere it names.

An approval is a hash of the projection only. Editing a model, a threshold, a
limit, or a gate setting keeps the approval; changing an endpoint, protocol,
credential variable, or prompt-override path requires approval again.
Approvals are stored in `roast/trust.json` inside the Git common directory,
so linked worktrees share them and `git clone` never copies them: a
repository cannot ship its own approval. There is no `untrust` command;
deleting the trust record withdraws every approval for the clone.

`npx roast trust` prints, for each role and author route, the profile,
endpoint, protocol, and credential variable name, plus any prompt-override
paths, then asks a `[y/N]` question and records the approval only on `y`.
`--yes` records without asking, which is how CI approves explicitly. Control
characters in every printed value are escaped, so configuration text cannot
rewrite what the user is asked to approve.

When `npx roast review` finds an unapproved config and both stdin and stderr
are terminals, it shows the same summary on stderr and asks inline; only `y`
records the approval and lets the review continue. Otherwise it exits with a
usage error naming `npx roast trust`. In both cases no network request is made
before approval. The pre-commit gate treats an unapproved config like any
other operational failure: it warns and allows the commit. `npx roast doctor`
reports the project config path, whether approval is required, and whether it
is granted, and does not probe an endpoint this clone has not approved. There
is no environment-variable bypass for trust.

## Configuration templates

Roast no longer installs configuration templates from a URL. A team shares its
configuration by committing `.roast.json`, which every clone then approves
under the per-clone trust described above. An organization that wants a
common configuration can publish a starter file for teams to copy into their
repositories; once copied, it is an ordinary project config and is approved,
reviewed, and changed like any other committed file. `npx roast init` can
write profiles for built-in providers or an interactively selected custom
endpoint. A starter needs no approval only when its selected profiles and
prompt overrides meet the conditions above. When approval is needed,
interactive init offers it; declining leaves the config unapproved.

## Credentials and endpoints

Each inference profile binds a model, endpoint, protocol, and credential
source as one unit. Credentials are the only settings that come from outside
the project config: from the environment, or from a stored credential
(ADR-0002).

- A role's credential is the first of:
  1. `ROAST_FINDER_API_KEY` or `ROAST_VERIFIER_API_KEY`;
  2. the variable named by the profile's `api_key_env`;
  3. the provider's standard variable: `OPENAI_API_KEY`,
     `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`;
  4. the provider's project-scope stored credential;
  5. the provider's user-scope stored credential.

  The last three apply only when the role's endpoint is that built-in
  provider's endpoint and it accepts the role's protocol there.
- A stored credential is matched to a role only by that endpoint and
  protocol, never by anything the project config names, so a profile on a
  custom endpoint never receives one, and neither does a role an override
  moved off its provider's endpoint.
- The project-scope credentials file is
  `<git-common-dir>/roast/credentials.json`, inside `.git`, so it is never
  committed or cloned. The user-scope file is
  `$XDG_CONFIG_HOME/roast/credentials.json` (or
  `~/.config/roast/credentials.json`). Both are written with mode 0600 in a
  0700 directory. On Unix, a credentials file that group or others can read
  stops resolution with an error instead of being skipped.
- `npx roast login <provider>` stores a credential in the project scope, or
  the user scope with `--global`. For Anthropic and OpenAI the user pastes a
  key, which Roast checks with one authenticated request to the provider's
  built-in endpoint before storing it. For OpenRouter, Roast runs
  OpenRouter's PKCE browser exchange on a loopback callback and receives a
  newly minted key labeled `roast`; the label carries no project or
  directory name. Login never prints the key. `npx roast logout` deletes a
  stored credential but does not revoke it at the provider.
- Roast does not honor `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`; endpoints
  come only from the project config or command-line flags.
- When a protocol override (`--<role>-protocol`) moves a role from one
  provider's endpoint to another's, the profile's credential does not follow
  it.
- An endpoint override (`--<role>-base-url`) carries the role key or the
  profile's own credential to the endpoint it names. It carries a provider key
  from the shell, or a stored credential, only when the endpoint it names is
  that provider's built-in endpoint.

A provider key in the user's shell is therefore never sent implicitly to a
profile's custom endpoint, such as a gateway. Such an endpoint needs a role
key or a variable named by `api_key_env`. The name is not restricted: a config
may set `endpoint: https://models.example.org/v1` with
`api_key_env: OPENAI_API_KEY`, and that key is then sent to that endpoint.
This is why such a config needs per-clone approval (see Trusted configuration)
and why the approval summary lists every selected profile's credential
variable. `npx roast doctor` reports which source each role used, and names a
provider key it withheld.

## Network disclosure

A review sends its prompt, selected diff or repository manifest, file content,
tool schemas, and local tool results to the configured finder endpoint.
When verification runs, candidate findings and the code needed to adjudicate
them are sent to the configured verifier endpoint. `npx roast doctor` makes
two small inference requests to each configured role (a fixed probe prompt,
one tool call and its result, then a submission) in addition to querying its
model-listing endpoint,
and skips these probes for a config this clone has not approved. Roast makes
no other network requests: it has no telemetry, update check, or run upload,
apart from what `npx roast login` sends to a built-in provider when the user
runs it (a key check, or OpenRouter's key exchange).

Each inference request carries only the credential, base URL, and headers from
Roast's resolved configuration. Roast ignores the provider SDKs' ambient
defaults, such as `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`,
`ANTHROPIC_BASE_URL`, Anthropic profile files, `OPENAI_BASE_URL`,
`OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, and `OPENAI_CUSTOM_HEADERS`;
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY` apply only as
inputs to Roast's own credential resolution. A profile's `session_header` only adds one more header
carrying the per-conversation session ID; it cannot name a credential or
framing header, or one Roast or the provider SDK sets.

Roast does not infer trust from a model name. An OpenAI-compatible gateway,
hosted provider, and local server are all treated as the operator-configured
destination. Operators are responsible for checking those services' retention,
training, and access-control policies before reviewing sensitive repositories.

## Local sensitive data

Once run record initialization succeeds, a non-empty review can retain the
reviewed input, prompts, arguments, raw provider responses (including partial
streams from failed attempts), findings, report, and metadata. Early failures,
such as an invalid mode or oversized finder prompt, leave no run record; later
failures can leave evidence. Snapshot capture can be disabled with
`review.snapshot: false` or fail; checkout requires a saved snapshot that
remains available. These artifacts may contain proprietary source code,
secrets in reviewed content, or sensitive model output. Run records
live under `.roast/runs/` at the Git toplevel, which ignores itself through a
`.gitignore` containing `*`, so they are not committed by accident. Protect
that directory and the repository's `refs/roast/snapshots/*` with the same
controls as the repository itself, and prune them according to local policy.

On Unix, Roast creates managed run directories with owner-only (`0700`)
permissions and artifacts, monthly records, and bundles with `0600` permissions.
Existing managed directories and files are tightened when written or reused.
New bundle entries also use `0600`; cached bundles retain their original bytes
and digest, so older archive entries may still carry their original permissions.
Roast does not change permissions on an existing `.roast/` directory or its
ancestors, and Unix permission bits do not establish Windows ACL isolation.

Roast excludes resolved authentication material from dedicated metadata and
does not record HTTP authentication headers. It does not comprehensively
redact recorded content: reviewed input, prompts, arguments, tool results, or
provider responses may contain or echo credentials. Keep credentials out of
command-line values and handle these artifacts accordingly.

## Untrusted repository and model input

Repository paths supplied by a model are confined beneath the reviewed tree;
absolute paths, traversal, unsafe Git revision spellings, escaping symlinks,
and paths inside `.git` are rejected. A staged review pins the index for
reads; failure to pin it stops the review. Other scopes normally read a
pinned worktree, including non-ignored untracked files. Pinning is separate
from persistent snapshot capture: `review.snapshot: false` disables capture,
not pinning. If worktree pinning fails, Roast warns and reads the live
working tree instead. Live reads block `.git`, ignored paths, and denylisted
untracked files. Concurrent edits can affect live reads, and these restrictions
do not guarantee that readable content is free of credentials or other
sensitive data.

Model output is schema-validated. Findings without a source quote grounded in
the reviewed corpus are dropped, and a separately configured verifier can
check surviving claims. Confirmed and insufficient-context findings remain
reported; grounded refutations are dropped. Verification may be skipped or
leave findings undecided because of limits or failures. These checks reduce
accidental fabrication; they do not make model output trusted executable input.

## Git hooks

On the first interactive review in a repository, Roast asks whether to install
its pre-commit gate. The answer is stored in that repository's local Git config,
and a decline is not prompted again. Non-interactive runs never install a hook
without consent. Roast does not overwrite foreign hooks: compatible shell hooks
receive a delimited invocation block, while incompatible hooks require a manual
step.

Gate dispatch requires this repository's local `roast.gate` opt-in, even when
`core.hooksPath` points to a shared directory. An inherited dispatcher is not
consent. Disabling a repository with a custom hooks path records a local decline
and preserves the dispatcher and foreign hooks for other repositories. Existing
Roast-owned dispatchers are refreshed to enforce this check when encountered;
foreign scripts are not rewritten.

The hook runs only `node_modules/.bin/roast` at the Git toplevel, never a
`roast` found on `PATH`, so a commit uses the version the project's lockfile
pins. The gate reviews staged content and fails open on operational errors,
including a missing binary and an unapproved project config. Use
`npx roast gate status`, `npx roast gate enable`, and
`npx roast gate disable` to inspect or change enrollment. `ROAST_SKIP=1`
bypasses one commit.

## Vulnerability reports

See [the security policy](../SECURITY.md) for supported versions and private
reporting instructions.
