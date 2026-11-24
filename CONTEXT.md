# Roast

An adversarial, cross-model code reviewer installed as a project dependency
via npm. One model proposes defects in a Git diff and a second model checks
each one before it reaches the report.

## Language

### Review

**Finder**:
The role whose model reads the diff and proposes candidate findings.
_Avoid_: reviewer, author model

**Verifier**:
The role whose model re-reads the cited code and confirms or refutes each
candidate finding.
_Avoid_: checker, judge

**Role**:
One of the two review positions, finder or verifier, each bound to one
inference profile.

**Inference profile**:
A named, complete unit of model, endpoint, protocol, output limit and
credential source.
_Avoid_: provider, backend

**Run record**:
The stored evidence of one review, kept inside the project that was reviewed.
_Avoid_: log, history

**Gate**:
The pre-commit hook that runs a quick review of staged content and fails open.
_Avoid_: pre-commit check, hook

### Configuration

**Project config**:
The `.roast.json` file (JSONC) nearest the working directory, searched upward
no further than the Git toplevel. It is the single home for every non-secret
setting.
_Avoid_: repo config, local config, rc file

**Trusted project config**:
A project config whose security-relevant contents (non-default endpoints,
credential variable names, prompt-override files) the user has explicitly
approved for this clone. Roast does not send code or credentials anywhere a
project config names until it is trusted.
_Avoid_: allowed config, whitelisted config

**Credential**:
An API key. Credentials are the only settings that come from outside the
project config: from environment variables, or from a stored credential. A
project config may name the variable but never hold the value.
_Avoid_: secret, token

**Built-in provider**:
A provider Roast knows by name (OpenAI, Anthropic, OpenRouter): its
endpoint, the protocols it accepts there, its standard key variable, and
how to log in.
A profile on a built-in provider's endpoint with its standard key variable
needs no trust approval.
_Avoid_: default provider, known provider

**Stored credential**:
A built-in provider's key kept in a credentials file, scoped to the project
(inside the Git directory) or to the user. It ranks below every environment
variable and is sent only to that provider's own endpoint (ADR-0002).
_Avoid_: saved key, cached token
