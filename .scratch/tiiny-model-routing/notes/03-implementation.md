Provenance: `tiiny-model-routing/IMPLEMENTATION.md` @
`2df1bf8d3ffeabfacfebab8a691109405ae9f01a`.
Fetched 2026-11-21T20:15:09.854100Z; 25694 bytes.

# Implementation notes

## Evidence boundary and harness

This document describes a concrete **Hermes** delegation backend and a
Tiiny-specific controller. Using its plugin unchanged presupposes Hermes;
transferring its routing ideas does not. No Hermes gateway, backend, CLI,
device, or setup command was run. The plugin and controller implementation
files are deliberately outside this job's source scope. Their behavior
below is described behavior, except where a displayed snippet can be read
directly. The standalone checker is inspected separately in CP4.
Source: [implementation](../sources/IMPLEMENTATION.md#the-implementation).

The opening dates its catalogue figures to 2026-10-31. CP1 and CP2 date
their matching figures to 2026-11-09. The dates disagree even where the
numbers agree; they are not independently reproduced measurements.

## Backend structure and entry points

Source: [backend](../sources/IMPLEMENTATION.md#1-the-delegation-backend)
and [layout](../sources/IMPLEMENTATION.md#plugin-layout).

The directory `tiiny-router/` contains:

| File | Described responsibility |
| --- | --- |
| `plugin.yaml` | Metadata; version 2.1.0 and `kind: backend` |
| `__init__.py` | Provider class and `register(ctx)` |
| `tiers.py` | Pure tier data, shape signals, special-model data/functions |
| `thinking.py` | Reasoning capability reads and control resolution |

`register(ctx)` calls `ctx.register_delegation_provider(...)`.
`route_task(task, config)` runs once per subtask with `goal`, `context`,
and `index`; its route includes model, provider, base URL, request
overrides, and optionally a label. The shown selection uses the goal;
it does not size the context or inspect its semantic content.

`task_parameters(config)` extends the `delegate_task` task JSON schema.
`description(config)` adds caller guidance. Both must be deterministic
for a fixed configuration because the schema is in a cached prompt
prefix. Device state belongs in route-time selection, not these methods.

The plugin loader uses `spec_from_file_location` without package
semantics. Shared modules are loaded by file path so the standalone tools
can use them without importing Hermes. The article warns that copying
only `__init__.py` causes an import failure that looks like no backend.

## Tier selection and routing

Sources: [tier table](../sources/IMPLEMENTATION.md#the-tier-table),
[residency](../sources/IMPLEMENTATION.md#routing-to-something-that-is-loaded),
[detection](../sources/IMPLEMENTATION.md#shape-detection), and
[route](../sources/IMPLEMENTATION.md#the-route).

The six tier names and candidate order match CP1's backend map:

- `research`: Sage-A1.5-Turbo, then BigBang-v1-Turbo.
- `index`: gpt-oss-20b.
- `code`: Qwen3-Coder-30B-A3B-Instruct-Turbo, Ornith-1.0-35B,
  Qwen3.6-35B-A3B, then Qwen3-Coder-Next.
- `browser`: Qwen3.8-27B.
- `draft`: Qwen3.5-9B.
- `general`: Qwen3.6-35B-A3B.

Full identifiers, NPU shares, and context sizes appear in
[CP1](01-description.md#five-subtask-taxonomy) and the pinned source.

The detection snippet lowercases the goal and tests ordered substrings:
`research`, `index`, `browser`, `code`, then `draft`, returning `general`
on no match. Its signal lists contain `...`; it is illustrative code,
not a complete independently executable backend. A goal that mentions
both research and coding selects research because it is checked first.

A truthy forced tier is validated against the table; an unknown tier
raises `DelegationRouteError`. The prose also requires rejection of
invalid thinking modes. The excerpt does not show JSON-schema details
or complete validation of empty or non-string task values.

`resident_models()` reads a bearer from `TIINY_API_KEY`, performs a GET
to `TIINY_BASE_URL + "/models"` with a three-second timeout, and returns
resident identifiers containing `/`. Missing keys or exceptions return
`None`. `choose_model` then selects:

1. The first tier candidate if residency is unknowable.
2. The first resident candidate in the tier's ordered list.
3. A resident generalist if no tier candidate is resident.
4. The original first candidate if neither is resident.

Thus even a successful empty-residency lookup can return a nonresident
target. The prose's promise to pick something loaded has this explicit
exception. A terminal 404 can still lead to paid fallback.

The route starts as `dict(config)`, replaces model and label, and merges
thinking overrides. `extra_body` is merged one level deep; scalar
`reasoning_effort` and `max_tokens` are replaced. This is not a promised
recursive merge of every nested chat-template key.
Substitution labels distinguish a different tier candidate from
`tier->generalist`, then append `[think:<achieved>]`.

## Reasoning controls and output budgets

Source: [reasoning](../sources/IMPLEMENTATION.md#reasoning-mode) and
[output floor][f].

[f]: ../sources/IMPLEMENTATION.md#the-empty-response-that-looks-like-success

Capabilities are obtained at route time from resident `/v1/models` or
the store's `/api/v1/models/online_models`. Fields include `supported`,
`toggleable`, `levels`, `enabled_by_default`, and `default_level`.

- `auto` returns no override and label `auto` before a capability lookup
  in the displayed resolution snippet.
- Missing capability returns no override and `unknown`.
- Unsupported reasoning returns no override and `unsupported`.
- Explicit `on`/`off` sends `enable_thinking` inside
  `extra_body.chat_template_kwargs`.
- For non-toggleable models with levels, the route also sends top-level
  `reasoning_effort`: cheapest for `off`, highest for `on`, with labels
  such as `off→low` or `on→high`.
- The boolean is still sent because capability flags can be wrong.

The article says labels report the reached state; the displayed code
derives them from metadata and requested controls before generation.
It does not demonstrate measurement of the achieved state. Likewise the
described output-floor rule covers every reasoning-active model, but
the excerpts do not show the full interaction with `auto` returning early.

The floor defaults to 4096 output tokens to prevent a reasoning trace
from consuming the entire budget and leaving an HTTP 200 empty answer.
The article gives `thinking_max_tokens: 8192` as an example increase.
This is documented intent, not a verified guarantee that any floor is
sufficient for all tasks or models.

## Configuration surface

Source:
[provider/config](../sources/IMPLEMENTATION.md#the-provider-and-the-config).

These are upstream Hermes settings, not Roast configuration advice:

| Upstream surface | Documented value or purpose |
| --- | --- |
| `providers.tiiny.api` | `http://openai.api.tiiny/v1` |
| `providers.tiiny.key_env` | `TIINY_API_KEY` |
| `providers.tiiny.transport` | `chat_completions` |
| `providers.tiiny.default_model` | `Qwen/Qwen3.6-35B-A3B` |
| `providers.tiiny.context_length` | 262144 |
| `providers.tiiny.models` | Per-model context lengths |
| `providers.tiiny.extra_body` | Default chat-template thinking control |
| `delegation.backend` | `tiiny-router` |
| `delegation.fallback_providers` | `minimax`, model `MiniMax-M3` |
| `delegation.backends.tiiny-router.thinking_max_tokens` | Output floor |
| Task `tier` | Strict forced tier, or inferred if omitted |
| Task `thinking` | `auto`, `off`, `on` |

The YAML model list omits some candidates present in the tier table,
including BigBang and two Qwen coder entries. The source does not explain
whether unlisted model metadata is inferred, optional, or required.
Fallback is deliberate availability policy, with visibility required;
it is not proof that generation stayed local.

## Data files read or written, as described

Sources: [layout](../sources/IMPLEMENTATION.md#plugin-layout),
[swap](../sources/IMPLEMENTATION.md#2-the-swap-script), and
[controller](../sources/IMPLEMENTATION.md#2b-the-device-controller).

| Component | Reads | Writes or changes |
| --- | --- | --- |
| Backend | Config, shared modules, device APIs, plan | Returns route |
| Human swap script | Model argument, required-model array | Hold; residency |
| Watchdog | Hold, health, resident list, prior state | Device/state data |
| Controller `plan` | Goals, tier data, residency | Shared plan JSON |
| Controller reserve/release | Lock and owner state | Lock; shared notice |
| Controller load/release | Plan/wave and resident set | Hold; residency |
| Controller catalogue | Live store, prior snapshot | Snapshot/diff data |
| Checker | Shared modules, device CLI/API | Printed report |

Explicit paths in the document:

- `~/.hermes/tiiny-plan.json`: goal-to-model and wave assignments, read by
  the backend; deliberately in base Hermes home across profiles.
- `~/.hermes/tiiny-lock.json`: reservation taken under `flock`, expiring;
  released by writing state instead of requiring deletion.
- `~/.hermes/tiiny-hold`: watchdog coordination file.
- `~/.local/tiiny/bin/tiiny`: CLI path in the human swap excerpt.
- `config.yaml`: Hermes provider and delegation settings.
- Shared team status board: marked reservation notice; path unspecified.
- Catalogue snapshot and watchdog state: described, paths unspecified.

No claims about unspecified filenames or contents are inferred.

## Swap script, both directions

Source: [swap](../sources/IMPLEMENTATION.md#2-the-swap-script) and
[watchdog](../sources/IMPLEMENTATION.md#the-watchdogs-half).

Forward direction in the displayed shell script:

1. Require a model argument.
2. Write the hold before loading, closing the watchdog race.
3. Invoke the CLI through `script -q /dev/null` to provide a TTY.
4. On load failure, remove the hold and exit 1.
5. With `-- cmd`, run that command, save its status, invoke this script's
   `--restore`, and return the command's saved status.
6. Without `-- cmd`, leave the deliberate swap/hold in place.

Reverse direction in the displayed `--restore` branch:

1. Remove the hold.
2. Reload the fixed required-model array: Qwen3.6-35B-A3B,
   Qwen3-ASR-1.7B, Qwen3-TTS-12Hz-1.7B-Base, supertonic-3, and
   gpt-oss-20b. The source requires this array to match the watchdog's.
3. Print each success/failure, run `tiiny top`, and exit 0.

That displayed branch does not aggregate failures or verify the required
set before its unconditional zero exit. Nor is there an exit/signal trap
around the child command. The later controller prose promises a stronger
verified release; it should not be attributed to this older shell excerpt.

The first watchdog example treats any existing hold file as active.
Later snippets refine this: `clear_hold` truncates, optionally deletes,
and checks that the file is no longer nonempty. `hold_active` ignores
empty files, honours fresh holds for 600 seconds, and honours older holds
only while their model is resident. Old nonresident holds are ignored.
The displayed code uses BSD-style `stat -f %m`; its portability is not
established here. The prose mentions `--clear`, absent from the displayed
swap argument handling. It also warns against here-strings where Bash
temporary-file restrictions and `set -u` cause failures.

The snippets must be integrated consistently: truncation-based release
would not clear the first example's existence-only hold check by itself.
The claim that a write always works is too broad; `clear_hold` itself
allows a failed write and checks the result.

## Controller lifecycle, eviction, and failures

Source: [controller](../sources/IMPLEMENTATION.md#2b-the-device-controller).

The seven commands are `status`, `plan`, `reserve`, `load`, `release`,
`catalog`, and `image`. The plan records each goal's assigned model and
wave. Packing is described as first-fit decreasing, with resident models
placed first. Loads protect wave models and retain other residents
cheapest first while capacity remains. Release is said to restore all
dropped models, while other sections describe restoring the required set;
whether these sets are identical is not specified.

The controller holds an expiring reservation under `flock`, announces it
on the shared board, and writes a released state rather than depending
on deletion. No lease duration or complete lock protocol is shown.
One wave is one delegation call; the text also says the device has one
heavy-generation stream. It does not show how multiple heavy tasks in a
capacity-fitting wave are serialised.

`catalog --refresh` compares a live store read with a snapshot for new,
removed, or resized models. The snapshot is factual data; updating tier
analysis remains manual. None of the controller source was inspected.

## Script and tool inventory

| Script/tool mentioned or invoked | Assigned role |
| --- | --- |
| `scripts/tiiny_ctl.py` | Agent batch plan, reservation, load, release |
| `tiiny-swap.sh` | Human swap, optional command, required-set restore |
| `scripts/route_check.py` | Show tier/model/budget/thinking/residency |
| `tiiny` / `$TIINY_BIN` | Device `load` and `top` operations |
| `script` | TTY wrapper around device loads |
| Watchdog shell snippets | Health/hold/state and reload coordination |
| `curl` | Watchdog health and authenticated resident-model reads |
| `rm`, `head`, `tr`, `stat`, `date`, `grep`, `printf` | Hold/state handling |
| `__init__.py`, `tiers.py`, `thinking.py` | Backend and shared modules |

The last row names modules, not standalone setup commands. Gateway/plugin
reload is required by the checklist, but no exact reload command is given.

## Setup checklist — transcribed, not executed

Source:
[end-to-end checklist](../sources/IMPLEMENTATION.md#4-end-to-end-checklist).
The following block is **verbatim inert source text**. Nothing in it was
configured, installed, tested on a device, or executed.

```text
- [ ] The bearer is in the environment as `TIINY_API_KEY`.
- [ ] The `tiiny` CLI is on `PATH`, and `tiiny top` answers.
- [ ] The `tiiny` provider is in `config.yaml`, with `key_env: TIINY_API_KEY`.
- [ ] The backend plugin is installed and `delegation.backend` selects it.
- [ ] The whole plugin directory was copied, not just `__init__.py`.
- [ ] The tier table's NPU shares and context windows were read from the
      device, not copied from an earlier read.
- [ ] Every model in the tier table is in the store.
- [ ] The fallback provider is configured, and its use is visible.
- [ ] The controller can plan, reserve, load and release, and its release
      restores the required set and verifies it.
- [ ] The swap script is in place, and the watchdog honours the hold.
- [ ] The hold check runs before the cold-check in the watchdog.
- [ ] `route_check.py` returns the expected tier for a known goal.
- [ ] `route_check.py --thinking off` reports the state the model would
      reach, and it is the state the route label then reports.
- [ ] A reasoning task is not run on a small output budget: the floor is set,
      and raised together with the budget it belongs to.
- [ ] A batch with mixed subtasks shows more than one model in its results.
- [ ] After a deliberate swap, the required models are resident again.
- [ ] **A plugin change is loaded, not just written.** Editing the plugin
      file on disk changes nothing in a running gateway — Python has already
      imported the module. Reload it, and reload it *for every profile that
      runs it*, because a profile's delegation backend is resolved under that
      profile's home.
- [ ] The child's route says the provider you expect. A child that quietly
      fell back to the paid provider still reports success.
```

## Embedded actions not executed

**None of the following actions was executed.** This inventory covers all
setup and operational instructions in the document, including commands
inside its code blocks and checklist. Literal full snippets remain in
the pinned source; their presence does not authorise execution.

- Create/copy/install `tiiny-router/`, its YAML metadata, provider class,
  registration function, shared data, path imports, schemas, or guidance.
- Implement or call `route_task`, `resident_models`, `choose_model`,
  `detect_tier`, `resolve_thinking`, or override merging.
- Read `TIINY_API_KEY`, send authenticated requests, or configure Hermes
  provider/delegation/fallback settings and per-task parameters.
- Query `GET /v1/models`, `GET /api/v1/models/online_models`, or health;
  refresh device catalogue numbers or snapshots and edit tier data.
- Set `thinking_max_tokens: 8192`, enable/disable thinking, choose an
  effort level, or run a reasoning task.
- Run `script -q /dev/null tiiny load MODEL -y`, any `$TIINY_BIN load`
  command, `tiiny top`, or the displayed shell script itself.
- Run `tiiny-swap.sh <model_id> [-- cmd]`, `--restore`, or the prose's
  `--clear`; invoke the script recursively or execute `$@`.
- Write/truncate/delete the hold; run `clear_hold` or `hold_active`;
  read timestamps/model lines; change grace windows or watchdog ordering;
  call `write_state`, restart a watchdog, or reload required models.
- Run controller `status`, `plan --owner "$AGENT" --task "..." --goal ...`,
  `reserve --owner "$AGENT" --task "..."`, `load --wave 1`, `release`,
  `catalog --refresh`, or `image "a logo with the word ARC in it"`.
- Create/read/write runtime plan or lock files, take `flock`, expire or
  release reservations, post status-board notices, load/evict/restore
  models, or delegate waves.
- Run any of the four checker invocations: a free-text goal, `--thinking
  off` with a goal, `--all`, or `--tier code --alternatives "anything"`.
- Follow the checklist: provision a bearer, put a CLI on PATH, copy a
  plugin, configure a paid fallback, check device models, test mixed
  batches, or reload the gateway/plugin for any Hermes profile.

CP3 exit: the complete implementation document was read. Plugin structure,
entry points, data flows, config, failures, and script roles are recorded;
the setup checklist is transcribed verbatim and remains inert.
