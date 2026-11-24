Provenance: `tiiny-model-routing/README.md` @
`2df1bf8d3ffeabfacfebab8a691109405ae9f01a`.
Fetched 2026-11-21T20:15:11.118493Z; 20620 bytes.

# Description notes

## Summary

The article argues for choosing a model separately for each delegated
subtask, using task shape, available capacity, and actual residency.
Its concrete setting is a Tiiny local appliance with a shared NPU pool
and a Hermes delegation backend. A separate controller plans and loads
models for each batch; the backend only selects routes. Reasoning controls
and observable substitutions are part of routing. These are the author's
claims and reported measurements, not results reproduced by this job.
Source: [opening and problem](../sources/README.md#the-problem-with-one-model).

## Core argument and constraint

The same model is a poor allocation for research, mechanical work,
coding, browser use, and drafting. On the appliance this affects whether
the chosen model can answer at all, not just price or speed.

NPU shares draw on one pool; resident shares must sum to at most 100%.
The text calls loading a swap that evicts residents, then describes
combinations and selective eviction later. The useful interpretation is
that loads can displace residents; co-residency is possible within budget.
For example, 27% plus 29% fits at 56%; 47% plus 54% does not at 101%.
The 55% coding candidate cannot share with the 47% generalist (102%).
These figures are device snapshots, not portable model properties.
Source:
[constraint](../sources/README.md#the-constraint-that-decides-everything).

## Five-subtask taxonomy

Source: [problem table](../sources/README.md#the-problem-with-one-model).

| Example subtask | Actual task shape |
| --- | --- |
| Survey vendors and find sources | Long-horizon research |
| Index and classify every client file | Mechanical bulk work |
| Fix a failing integration test | Terminal coding |
| Click signup steps and take screenshots | Browser automation |
| Summarise meeting notes into five bullets | Drafting |

The later routing table separates terminal coding, repository-scale
coding, and hard refactoring/recovery. Its seven rows are illustrative
specialisations, not the same thing as the six backend tier names.
Source: [routing by shape](../sources/README.md#routing-by-task-shape).

| Shape | Model identifier | NPU | Context |
| --- | --- | ---: | ---: |
| Research | `InternScience/Sage-A1.5-Turbo` | 48% | 262144 |
| Indexing | `openai/gpt-oss-20b` | 27% | 131072 |
| Terminal coding | `deepreinforce-ai/Ornith-1.0-35B` | 50% | 131072 |
| Repo coding | `Qwen/Qwen3.6-35B-A3B` | 47% | 262144 |
| Browser use | `Qwen/Qwen3.8-27B` | 52% | 262144 |
| Drafting | `Qwen/Qwen3.5-9B` | 29% | 131072 |
| Hard coding | `Qwen/Qwen3-Coder-Next` | 94% | 131072 |

The backend's `code` tier actually lists the 55% model
`Qwen/Qwen3-Coder-30B-A3B-Instruct-Turbo` first (65536 context), then
Ornith, Qwen3.6, and Coder-Next. `research` also lists
`endless-frontier/BigBang-v1-Turbo` (54%, 131072). `general` uses
Qwen3.6. The model-selection rationale comes from catalogue descriptions;
the article explicitly disclaims benchmark evidence.

## Backend and caller override

Source: [router](../sources/README.md#implementing-the-router) and
[override](../sources/README.md#letting-the-caller-override).

The concrete harness is Hermes: its delegation backend calls `route_task`
once for each goal/context. The example `detect_tier` lowercases the goal,
checks ordered substring signals, and returns `general` on no match.
This is a heuristic despite the prose's distinction between task shape
and keyword matching. The route carries model, provider `custom:tiiny`,
base URL `http://openai.api.tiiny/v1`, request overrides, and a label.

The backend reads residency but never loads a model. Among residents it
prefers the tier's ordered candidates, then the generalist, with a label
such as `code->generalist`. A failed residency read returns the tier's
first choice. A nonresident target reportedly returns a terminal Hermes
404 and can cause fallback to a paid provider. Local work can therefore
appear successful while changing provider.

The separate controller and backend exchange a plan file keyed to goals.
The controller has batch context, a device reservation, and a release
point; the per-task hook lacks those lifecycle boundaries.

A caller can force `tier`, validated against the tier list. Invalid values
must fail rather than silently select `general`. The example of logs whose
real work is drafting illustrates why inferred routing needs an override.

## Reasoning mode

Source:
[reasoning](../sources/README.md#reasoning-mode-is-a-routing-decision-too),
[off](../sources/README.md#off-means-the-cheapest-available-state),
[labels](../sources/README.md#the-label-reports-what-happened), and
[empty](../sources/README.md#the-empty-response-that-looks-like-success).

Per-task `thinking` accepts `auto`, `off`, and `on`. `auto` preserves native
behavior. A toggle goes in `chat_template_kwargs.enable_thinking`, while
`reasoning_effort` is a top-level request field for models with levels.
Other models do not reason. Device flags can disagree with observed
behavior, including a model whose advertised lack of a toggle is wrong.

Capabilities come from `/v1/models` for residents and
`/api/v1/models/online_models` for the full store. For a model without a
working off switch, `off` means its lowest advertised reasoning level;
it does not promise zero reasoning. The indexing model is the main case.

| Reported label | Claimed achieved state |
| --- | --- |
| `[think:off]` | Reasoning switched off |
| `[think:off→low]` | Switch ignored; lowest level selected |
| `[think:on]` | Reasoning switched on |
| `[think:on→high]` | Switch ignored; highest level selected |
| `[think:unsupported]` | Model does not reason |
| `[think:unknown]` | Capability unavailable; no setting applied |

The README says these labels describe achieved state. A capability read
and a sent flag alone do not independently establish that a model obeyed
them; this job did not probe the device.

A small output budget can be exhausted by reasoning, producing HTTP 200
with an empty answer. The router applies an output floor when reasoning
is active, including `off` mapped to a low level. The checker example
shows `max_tokens=4096`; the implementation notes will check the rule.

## Load survival and lifecycle

Source: [load survival](../sources/README.md#making-the-load-survivable).

1. Plan goals and pack the required models into waves under 100%.
2. Reserve the device under an owner/task identity.
3. Load one wave, evict unwanted residents deliberately, and verify it.
4. Delegate that wave; repeat for later waves.
5. Release, restore the required set, verify restoration, and unlock.

The four-command example omits the delegation call itself; it belongs
between load and release. The wave's requested models are protected;
other residents are retained cheapest first while they fit. Otherwise
the device can keep an unwanted generalist and evict the very model
the wave needs, triggering paid fallback.

Capacity fit does not establish safe concurrent generation. The device
reportedly serves one heavy generation stream at a time; two heavy
children can hang while health checks remain healthy. A parent's cloud
stream can run alongside one device child because it uses another
provider.

A watchdog can undo a specialist load. A hold file suppresses reloads;
its check must precede the cold-device check. The text says planning
writes the hold before load. Release verifies restoration rather than
assuming it succeeded. Exact ownership and expiry are deferred to CP3.

### Two agents sharing a device

Source: [two agents](../sources/README.md#two-agents-one-device).

A file lock acquired under `flock` serialises controllers. Its reservation
expires after a crash. A marked shared-status notice informs agents
outside this controller. This job neither creates locks nor edits status
boards; those are mechanisms described by the article.

### Image bonus

Source: [images](../sources/README.md#the-image-bonus).

The same controller selects image models by task: text-accurate logo
work, fine detail, character sheets, or subject cutouts. The README gives
no complete image tier table or implementation contract here.

## Limits and linked documents

Source: [limits](../sources/README.md#the-limits) and
[links](../sources/README.md#where-to-go-next).

- NPU/context figures were read on 2026-11-09 from a 92-model store.
  Device software changes can invalidate the numbers.
- Capability lookup is dynamic, but the prose can still become stale.
  Dynamic lookup also depends on device accessibility and accurate flags.
- Publisher descriptions explain intended specialisation; they are not
  benchmarks establishing model quality.
- Shape inference fails when goal text hides the actual task.
- Routing does not make models interchangeable or fix weak models.

The four next-reading links are `Tiiny/model-catalogue.md`,
`tiiny-model-routing/PATTERN.md`,
`tiiny-model-routing/IMPLEMENTATION.md`, and
`tiiny-model-routing/scripts/route_check.py`.
All are resolved against the one pinned commit, not the moving branch.

## Embedded actions not executed

**None of the following actions was executed.** Source code, endpoints,
and commands were read only. The invocations below preserve the source's
command text and shell variables. Inline code wraps at spaces in this
Markdown file; its rendered text retains those spaces. Source comments
are described separately to keep lines below 80 columns.

From "Making the load survivable":

```text
tiiny_ctl.py plan --owner "$AGENT" --task "what this batch is for" \
  --goal "index every file under the vault and classify each"
tiiny_ctl.py reserve --owner "$AGENT" --task "what this batch is for"
tiiny_ctl.py load --wave 1
tiiny_ctl.py release
```

The source comments assign these four commands: pick/fit/wave, lock,
load/evict/verify, and restore/unlock, respectively.

From "What the reader gets":

- `python3 scripts/route_check.py
  "index every file under the vault and classify each"`
- `python3 scripts/route_check.py --thinking off
  "index every file under the vault"`

Other embedded instructions, also not executed:

- Implement or register a Hermes backend and its `TIER_CHOICES`,
  `detect_tier`, route object, and `SHAPE_SIGNALS` behavior.
- Set a provider, endpoint, model, request overrides, tier, thinking mode,
  reasoning effort, or output-token floor.
- Query either device model endpoint, the local CLI, or the checker.
- Re-read device NPU/context figures or test model toggle behavior.
- Plan or delegate waves; reserve, load, evict, restore, or release models.
- Change watchdog order, write a hold, acquire an expiring lock, or post
  a marked shared-status notice.
- Select or run an image pipeline or follow any linked setup material.

CP1 exit: all requested sections are present with source-heading links;
the complete README was read after CP0 verification.
