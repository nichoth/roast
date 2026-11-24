Provenance: `tiiny-model-routing/PATTERN.md` @
`2df1bf8d3ffeabfacfebab8a691109405ae9f01a`.
Fetched 2026-11-21T20:15:10.266747Z; 14326 bytes.

# Pattern notes

## Scope and evidence

The pattern is per-task model selection above delegation. It claims the
mechanism generalises to any provider with a model library; the NPU
figures are Tiiny-specific. Its design rule is to select the smallest
model that can correctly perform the task. Neither the minimum adequate
model nor routing quality is benchmarked in this document.
Source: [opening](../sources/PATTERN.md#the-pattern).

## Failure modes

Source: [failure modes](../sources/PATTERN.md#failure-modes).

- A pinned `delegation.model` sends different kinds of work to one model.
  The result can waste capacity on easy work and miss useful specialists.
- Loading during routing can evict a sibling child's model. A per-task
  hook has no complete batch lifecycle for safe loading and restoration.
- Automatic eviction can keep an irrelevant model and evict one the
  current wave actually needs.
- A 404 for a nonresident model is misdiagnosed as a bad identifier or
  provider configuration. Store membership and residency are distinct.
- A watchdog can undo a deliberate swap. Checking a hold after the
  cold-device test is too late to prevent its reload.
- A goal can describe the input while understating the operation, causing
  wrong inference; a strict caller override provides an escape hatch.
- A task can exceed the specialist's context window and return plausible
  truncated work. Context capacity belongs beside the model identifier.
- Reasoning controls vary by model. A boolean can falsely claim reasoning
  stopped; a small output budget can return an empty answer with HTTP 200.
  Source:
  [reasoning](../sources/PATTERN.md#reasoning-mode-is-part-of-the-route)
  and [checklist](../sources/PATTERN.md#reference-checklist).

These are described and sometimes reported as observed by the author;
none was reproduced on a device in this job.

## Every named tier or task-shape row

Source: [routing table](../sources/PATTERN.md#the-routing-table).

The pattern does not specify the six backend tier identifiers or a
machine-readable predicate for each tier. It names the following nine
rows, reproduced exactly as selection categories. The criteria are the
named operation itself; no confidence threshold or escalation trigger
is supplied. Backend identifiers from the README are kept separate.

1. **Long-running research**:
   `InternScience/Sage-A1.5-Turbo`; 48% NPU, 262144 context.
2. **Long-running research (alternate)**:
   `endless-frontier/BigBang-v1-Turbo`; 54%, 131072.
3. **Bulk indexing and classification**:
   `openai/gpt-oss-20b`; 27%, 131072.
4. **Terminal coding, repository navigation**:
   `deepreinforce-ai/Ornith-1.0-35B`; 50%, 131072.
5. **Repository-scale coding**:
   `Qwen/Qwen3.6-35B-A3B`; 47%, 262144.
6. **Computer use, browser automation**:
   `Qwen/Qwen3.8-27B`; 52%, 262144.
7. **Drafting, summarising**:
   `Qwen/Qwen3.5-9B`; 29%, 131072.
8. **Generalist fallback**:
   `Qwen/Qwen3.6-35B-A3B`; 47%, 262144.
9. **Hard refactoring, recovery from failed runs**:
   `Qwen/Qwen3-Coder-Next`; 94%, 131072.

The generalist criterion is a shape that is not confidently recognised.
The operational categories are evidence gathering, enumeration/labelling,
file editing, browser driving, and prose production. A research task about
code remains research. These are heuristic routing criteria, not measured
guarantees that the selected model will succeed.

The author dates the table to 2026-11-09 and a 92-model store. The
55% coding candidate appears in an impossible-pair example but is absent
from this table; the README's executable-looking tier map lists it first
for `code`. See [CP1](01-description.md#five-subtask-taxonomy).

## Decision procedure as described

Source: [pattern](../sources/PATTERN.md#the-pattern) and its subsections.

There is no single end-to-end numbered algorithm. The following preserves
the stated decisions and the separate preflight/controller duties:

1. Check the shared budget first: which other models must be loaded?
   Models needed together must fit at 100% or less; otherwise use waves.
2. Identify the operation from the task's goal. Route by the operation,
   not incidental topic words.
3. Honour an explicitly forced tier; refuse an unknown one loudly.
4. If the shape is uncertain, deliberately select the generalist.
   Otherwise choose the specialist for the operation, preferring the
   smallest adequate model as the opening design rule.
5. Treat reasoning mode as another per-task route decision. Read current
   capability, choose a supported control, and report the achieved state.
6. Before delegation, verify residency, combined NPU fit, the actual
   route, and context-window fit. These are operator checks, not a
   demonstrated automatic context-sizing algorithm.
7. Let a separate controller handle reservation, deliberate eviction,
   loading, watchdog holds, waves, and restoration. The router itself
   must not load or unload.

The four preflight checks are stated in that order under
[verify before spending](../sources/PATTERN.md#verify-before-you-spend):
resident model, combined fit, intended route, sufficient context.
`tiiny top` is presented as residency ground truth; `tiiny ls` describes
the store and a model's size, not its current load state.

## Reasoning and eviction semantics

Source: [reasoning](../sources/PATTERN.md#reasoning-mode-is-part-of-the-route)
and [swap failure](../sources/PATTERN.md#the-swap-that-evicts-a-sibling).

Reasoning has toggles, levels, and unsupported cases. The provider's flags
can be wrong, and request placement differs among model families. `off`
on an unswitchable model means its cheapest supported reasoning level.
The route should describe the resulting state, and the output budget
must leave room for a visible answer. The checklist assigns `off` to
mechanical work, `on` to novel reasoning, and `auto` to native behavior.

Loading may evict residents. The controller protects the wave's requested
models and keeps the cheapest remaining residents while they fit. It
holds an expiring device lock and a watchdog hold, checks the hold before
the cold check, and restores the required set after use. The document
does not provide a controller implementation or prove locking guarantees.

## Contradictions and extensions relative to CP1

1. **Shape versus implementation heuristic.** This pattern explicitly says
   shape is not a keyword list. The README's `detect_tier` is ordered
   substring matching. The conceptual rule and supplied heuristic differ.
   See [CP1 router](01-description.md#backend-and-caller-override).
2. **Table versus candidate order.** The pattern's table omits the 55%
   first coding candidate from the README's `TIER_CHOICES`. This is a
   documentation-scope mismatch, not proof of a changed runtime table.
   See [CP1 taxonomy](01-description.md#five-subtask-taxonomy).
3. **Residency wording.** The pattern says naming the desired model and
   answering residency are separate, while the README makes residency
   affect route selection. They agree on no device mutation in routing;
   only the README fully describes resident-candidate substitution.
   See [CP1 router](01-description.md#backend-and-caller-override).
4. **Context handling is stronger here.** The pattern explicitly requires
   context-fit preflight and warns about truncation. Neither core source
   read so far demonstrates enforcement based on actual task size.
5. **Generation concurrency is omitted.** CP1's one-heavy-child rule is
   absent from this pattern's checklist. NPU fit alone is not CP1's full
   scheduling contract. See
   [CP1 lifecycle](01-description.md#load-survival-and-lifecycle).
6. **Smallest adequate versus ordered candidates.** The opening rule does
   not specify how to reconcile minimum size with README tier order;
   the first coding candidate is larger than some later candidates.
7. **Swap shorthand.** Both sources sometimes say every load evicts
   whatever was resident, despite also discussing compatible resident
   sets and selective eviction. Preserve the weaker, consistent claim:
   loading can displace residents and must be coordinated.

## Reference checklist, reproduced

Source: [reference checklist](../sources/PATTERN.md#reference-checklist).
This is the source's checklist, not work performed by this research job.
The unchecked items are intentionally not completion markers for Roast.

```text
Before trusting a routing setup:

- [ ] The tier table carries the NPU share and context window for every
      model, read from the device — not from memory, and not from a
      previous read of the same table.
- [ ] Every model in the table exists in the device's store.
- [ ] The NPU shares of the models a batch needs sum to 100% or less, and a
      batch that does not fit is split into waves.
- [ ] The router chooses; a separate controller loads. The plugin never loads
      or unloads a model.
- [ ] The controller decides what to evict before it loads — the device's own
      eviction choice is not batch-aware.
- [ ] The device is locked for the duration, and the lock expires.
- [ ] An unrecognised tier is refused, not silently mapped to the fallback.
- [ ] The generalist fallback is a deliberate choice, not an accident.
- [ ] Reasoning mode is a per-task parameter — 'off' for mechanical work,
      'on' for novel reasoning, 'auto' for the model's native behaviour.
- [ ] The control that is applied matches what the model honours, and the
      route reports the state the model actually reached.
- [ ] A model with no working switch gets its cheapest reasoning level
      rather than a refusal or a false claim.
- [ ] An output floor is set whenever reasoning is in play: a small budget
      spends itself on the trace and returns an empty answer with a 200.
- [ ] Residency is checked with `tiiny top`, not `tiiny ls`.
- [ ] A hold file prevents the watchdog from evicting a deliberate swap.
- [ ] The hold check runs before the cold-check.
- [ ] The required model set is restored after a deliberate swap.
- [ ] A routing checker can show the tier, model, budget and reasoning state
      for a goal before a batch spends tokens on it.
- [ ] Every task's route can be read back from the child's result.
```

## Embedded actions not executed

**None of the following actions was executed.**

- `tiiny load`, `tiiny unload`, `tiiny top`, and `tiiny ls` were only
  read as command names in the document.
- No `/v1/models` query, model generation, or routing checker was run.
- No `delegation.model`, tier, fallback, capability control, output floor,
  or provider setting was configured.
- No routing layer or per-task hook was installed or invoked.
- No model was verified in the store, loaded, unloaded, evicted, restored,
  or scheduled into waves; no context-size preflight was run on a device.
- No device lock, expiry, watchdog hold, hold-order change, or restoration
  was applied. Every imperative item in the reproduced checklist remains
  inert source text, including route readback from a child's result.
- The instruction to re-read NPU shares was recorded, not followed.

CP2 exit: the full pattern was read, every named table row and its
criteria are recorded, the reference checklist is reproduced, and
contradictions/extensions relative to CP1 are explicit.
