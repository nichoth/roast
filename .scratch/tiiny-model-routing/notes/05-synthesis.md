Provenance: `tiiny-model-routing/README.md`,
`tiiny-model-routing/PATTERN.md`, `tiiny-model-routing/IMPLEMENTATION.md`,
`Tiiny/model-catalogue.md`, and `tiiny-model-routing/scripts/route_check.py` @
`2df1bf8d3ffeabfacfebab8a691109405ae9f01a`.
Fetched 2026-11-21T20:15:09.854100Z through 20:20:08.562902Z.
Bytes in that order: 20620, 14326, 25694, 60643, 7622.
Exact per-file times and hashes: [manifest](../sources/MANIFEST.md).

# Research synthesis

## Finding and harness answer

The reusable idea is a visible decision for each unit of work: task shape,
candidate model, capacity/context constraints, reasoning controls, and
explicit substitutions. Mutable device lifecycle belongs outside that
decision. **The supplied backend is specifically a Hermes plugin**;
adopting its exact setup would mean using Hermes and its Tiiny integration.
The pattern can be implemented in another harness, including a future
Roast design, without installing Hermes. This job only studied the design.

The articles do not establish that the listed specialists outperform
alternatives on Roast reviews. Most specialisation evidence is publisher
description, not a measured comparison. The controller/plugin source
was deliberately skipped, and the checker differs from the documented
backend in a way that weakens its value as route verification.

## Completed scope and evidence

- CP0 pinned one commit and verified three core copies against the
  plan's byte counts and the API tree's blob hashes.
- CP1–CP3 read each core document completely and wrote the corresponding
  notes, including a verbatim pattern checklist and inert setup checklist.
- CP4 sampled the catalogue with exact line boundaries and read the full
  checker as text. The catalogue is 60643 bytes, not the plan's 238523;
  it matches the pinned tree. This declared assumption is recorded in
  the manifest, along with the earlier operator question.
- Before this synthesis, the required local area notes were read:
  `docs/agents/llm.md`, `docs/agents/config.md`, and
  `docs/agents/records.md`. Source paths below were checked locally.
- No device behavior, performance claim, gateway integration, script,
  or model capability was tested by execution.

Detailed notes: [description](01-description.md), [pattern](02-pattern.md),
[implementation](03-implementation.md), and
[linked materials](04-linked-materials.md).

## Where the three core documents agree

Sources: [README](../sources/README.md), [pattern](../sources/PATTERN.md),
and [implementation](../sources/IMPLEMENTATION.md).

1. One pinned model wastes opportunities when tasks perform different
   operations. Match the operation rather than the subject matter alone.
2. NPU shares and context windows constrain model choice. Model names
   and publisher descriptions do not replace resource metadata.
3. Keep a deliberate generalist fallback and let the caller force a
   validated tier. Typos should not silently become generalist work.
4. Route selection must not mutate device residency. A separate owner of
   batch lifecycle coordinates loads, holds, reservations, and release.
5. Loading can evict a needed resident; a nonresident model can produce
   404 and paid-provider fallback while the delegated task still succeeds.
6. Reasoning is part of a route, with toggle/level/unsupported cases.
   For an unswitchable model, `off` can only mean cheapest reasoning.
7. Reasoning can consume the output budget before a visible answer;
   an HTTP 200 alone is not evidence of a usable completion.
8. The operator needs readable routes, deliberate swaps, watchdog holds
   before cold checks, and restoration after using a specialist.

The core tier-map numbers agree where all sources name the same model.
Their snapshot dates and coverage differ, as recorded below.

## Disagreements, drift, and unproved guarantees

### Shape selection and candidate policy

- The pattern explicitly rejects keyword lists; README and implementation
  detection use ordered substring signals. The latter is an approximation
  to the conceptual operation classifier, not a demonstrated semantic one.
- The pattern recommends the smallest adequate model, while implementation
  selection follows tier order, not increasing NPU share. Coding starts
  at 55%, before 50% and 47% candidates, with 94% last.
- The pattern's routing table omits that 55% first coding candidate. It
  appears in its impossible-combination examples and in both other tier
  maps. Illustrative task rows and backend tiers are not interchangeable.
- Tables distinguish hard refactoring/recovery from ordinary coding, but
  no displayed detector escalates a difficult coding task to Coder-Next.
  All those candidates share `code`; order and residency choose among them.
- The pattern describes the desired-model and residency questions
  separately. README and implementation explicitly let residency alter
  the route. They agree only that route selection does not perform loads.
- The implementation's promise to pick something loaded has exceptions:
  unknown residency or no suitable resident returns the first candidate,
  even if the resident set is known empty. Paid fallback remains possible.

See [CP1 router](01-description.md#backend-and-caller-override),
[CP2 differences](02-pattern.md#contradictions-and-extensions-relative-to-cp1),
and [CP3 selection](03-implementation.md#tier-selection-and-routing).

### Reasoning and configuration claims

- README and pattern say labels report achieved state. The implementation
  snippets predict labels from capability metadata and controls before
  generation; they show no post-generation verification of compliance.
- `auto` is described as native behavior, yet the provider configuration
  already supplies `enable_thinking: false`. Returning no new override
  leaves that configured request default in force; it is not necessarily
  the device's unmodified native default.
- The output-floor prose includes all reasoning-active cases, while the
  shown resolution returns early for `auto`. The complete interaction of
  native thinking, explicit controls, and the floor is not shown.
- The field is called a floor, but the shown assignment replaces
  `max_tokens`, and scalar merge replaces existing values. No displayed
  comparison preserves an already larger configured budget.
- The merge promise is one level deep for `extra_body`; it does not
  establish preservation of unrelated nested chat-template keys.
- The example provider model list omits some tier candidates. The article
  does not explain the consequence for their context metadata or routing.

See [CP1 reasoning](01-description.md#reasoning-mode) and
[CP3](03-implementation.md#reasoning-controls-and-output-budgets).

### Lifecycle and scheduling claims

- All three use shorthand implying any load evicts all residents, while
  also documenting compatible sets and selective eviction. The consistent
  statement is that a load can evict models and must be coordinated.
- README says one heavy child per wave. The implementation describes
  capacity packing and separate delegation calls, without showing how
  heavy children within a fitting wave are serialised. The pattern's
  checklist omits this throughput constraint entirely.
- Verified restoration is promised for the controller. The displayed
  human swap script prints failures and exits zero after restoration;
  it neither verifies the full required set nor installs an exit trap.
- The controller is said to restore everything dropped. Other sections
  say restore the fixed required set. Those sets need not be identical,
  and their reconciliation is unspecified without controller source.
- The first watchdog snippet checks hold-file existence. Later snippets
  release by truncation and require nonempty/age/residency-aware checking.
  Those are refinements requiring integration, not interchangeable pieces.
- The prose names `--clear`; the shown swap argument handling does not
  implement it. A claim that a write always works is broader than the
  failure-checked `clear_hold` code itself supports.
- Context-fit preflight is explicit in the pattern; the shown route code
  does not measure task/context size before selecting a model.
- The controller plan is said to bind loaded models to goals. The shown
  `route_task` excerpt does not include plan lookup. This is a documented
  extension, not behavior verified in the skipped backend source.

See [CP1 lifecycle](01-description.md#load-survival-and-lifecycle) and
[CP3 swap/controller](03-implementation.md#swap-script-both-directions).

### Snapshot and linked-material drift

- README/pattern: 92 models and a 2026-11-09 read. Implementation opening:
  a 2026-10-31 read. Catalogue: 82 models on 2026-11-01. These describe
  different snapshots even though this job fetched them at one commit.
- Qwen3.8-27B is 52% in the core documents, 51% in the catalogue. The
  catalogue also records earlier Qwen3.6 NPU/context changes.
- The catalogue's general combination claim is contradicted by its own
  47% + 58% example. Its 49% video/large-chat exclusion is also broader
  than the listed 47% flagship's arithmetic supports.
- Catalogue descriptions and parameter fields have known copy/paste and
  internal-consistency problems. Live lookup prevents stale copies; it
  does not make inaccurate metadata correct.
- The checker shares tier data but always prints the first candidate.
  It lacks resident substitution and plan lookup, so it can disagree with
  the child's actual route despite the prose's cannot-drift assertion.
- The checker's docstring says catalogue access only for explicit
  thinking; `describe_capability` is actually called for `auto` too.
  Whether that implies network IO depends on the skipped helper.
- The checker advertises exit 1 for an invalid tier, while argparse
  `choices` uses the usage-error path; its `--tier code` usage example
  also lacks the goal still required by `main`.
- Its alternatives label suggests the same thinking setting without
  resolving each alternative's controls. Its empty-residency parsing
  also conflates no identifiers with unavailable CLI output.

See "Catalogue limitations and cross-document drift" and "Checker:
source behavior versus advertised role" in
[CP4](04-linked-materials.md).

## Transferability to Roast

This is a map of possible future work, not a proposed implementation or
authorisation to change these areas. Roast has finder/verifier roles and
an author-aware finder route, not the upstream generic delegation API.
The TypeScript CLI's `src/cli/review.ts` is still a review stub in this
checkout; the active Go pipeline is in `internal/cli/cli.go`. A future
spec must explicitly choose Go, TS rewrite milestones, or both.

| Idea | Roast area | What it would mean here |
| --- | --- | --- |
| Task-shape routing | [Roles][r1] | Select profiles by review operation. |
| Strict caller override | [Role schema][r2] | Preserve explicit pinning. |
| Ordered candidates | [Role resolution][r1] | Make substitutions visible. |
| Reasoning as a route | [Chat/types][r3] | Encode model-specific controls. |
| Output/context fit | [Loop/ledger][r4] | Reserve enough useful output. |
| Shared preflight | [Client][r5] | Preview the actual request plan. |
| Route observability | [Run metadata][r6] | Record selection and actual use. |
| Capacity admission | [Ledger][r4] | Separate token/device constraints. |
| Device lifecycle | [Orchestration][r7] | Keep loads outside adapters. |

[r1]: ../../../src/config/role.ts
[r2]: ../../../src/config/schema.ts
[r3]: ../../../src/llm/chat.ts
[r4]: ../../../src/llm/ledger.ts
[r5]: ../../../src/llm/client.ts
[r6]: ../../../internal/record/meta.go
[r7]: ../../../internal/cli/cli.go

Concrete boundaries behind the table:

- **Roles and pinning:** `src/config/role.ts` already has `resolveRole`
  and `resolveFinderFlip`. The latter selects configured author routes
  while preserving author/finder independence and `pin`. New cost/shape
  routing must define how it composes with those semantics. The Go
  counterparts are in `internal/config/config.go`; don't invent a
  six-tier default where missing Roast roles currently fail explicitly.
- **Config:** prospective non-secret settings belong in `.roast.jsonc`,
  through `src/config/schema.ts`, `src/config/load.ts`,
  `src/config/json-schema.ts`, and corresponding Go config. The published
  `roast.schema.json` is generated. Upstream Hermes YAML and its variable
  conventions should not be copied into Roast settings.
- **Reasoning controls:** `src/llm/chat.ts` currently selects
  `max_tokens` versus `max_completion_tokens` through
  `src/llm/models.ts`; `ClientConfig` in `src/llm/types.ts` contains no
  upstream-style arbitrary request override or thinking-mode field.
  A future design needs explicit typed controls and pure encoding.
  The current `ADAPTERS` map in `src/llm/client.ts` registers chat only;
  schema protocol names do not prove every adapter is implemented.
- **Budgets:** `src/llm/ledger.ts` already reserves per-call request/output
  footprint and finalisation headroom. `src/llm/agent.ts` owns loop limits;
  `src/llm/review.ts` owns response decisions. A model context window,
  total token budget, device NPU residency, and generation concurrency
  are distinct constraints, not one number renamed as capacity.
- **Preflight:** `ModelClient.requestBytes` and `send` already share body
  encoding in `src/llm/client.ts`. A prospective route preview should
  consume the same resolved decision used at execution, with explicit
  invalidation if mutable residency changes, rather than reproduce the
  checker's parallel selection procedure.
- **Records:** `internal/record/meta.go` already stores secret-free role
  profile, endpoint, model, protocol, output limit, and prompt digest.
  `internal/record/responses.go` handles response artifacts. A future
  route-decision record would distinguish requested, selected, substituted,
  and actually used models/providers; proposed controls are not observed
  model compliance. No `src/record/` counterpart exists in this checkout.
- **Lifecycle:** the existing token ledger does not manage Tiiny leases,
  holds, models, or watchdogs. Such support would require a separate
  controller design around orchestration in `internal/cli/cli.go` or a
  later TS review pipeline, not network or shell effects in encoders.
- **Secret handling:** `ResolvedRole` is frozen with a non-enumerable
  key/store. Any future selection must use `updateRole` from
  `src/config/resolved-role.ts`; spreading a role loses its secret.
  This observation authorises no changes to credential or trust policy.

## Do not do without a separate reviewed specification and tickets

- Do not change trust projections, approvals, endpoint allow decisions,
  or provider/credential forwarding to make a local or fallback route work.
- Do not read, copy, provision, persist, print, or transmit actual device
  or provider credentials as part of this research.
- Do not configure silent paid fallback. A new endpoint/provider route
  would need explicit policy, visible actual-use records, and the existing
  trust/credential boundaries preserved.
- Do not change gate verdicts, pre-commit hooks, bypass behavior, or
  auto-execution. Model availability is not permission to skip review.
- Do not install the upstream skill/plugin, copy executable dependencies,
  reload gateways, or run any fetched script, including the checker.
- Do not call Tiiny APIs/CLI, load or evict models, reserve a device,
  alter holds/watchdogs, write a shared status board, or generate images.
- Do not add model-name defaults or hard-code this device snapshot as a
  portable capability table; no Roast model-quality evidence was gathered.
- Do not alter replay/record privacy or persist reasoning traces merely
  to substantiate a reasoning label.

## Next step

If the operator chooses an idea from the table, create a **new spec and
tickets under `.scratch/<new-slug>/`**, following the local issue-tracker
workflow. That is new work, not an extension of this reading job.
The spec should choose an implementation generation, preserve review-role
independence, define an observable selection contract, and state how its
claims will be evaluated before adopting upstream model preferences.

## Embedded actions not executed

**No embedded action from any fetched document was executed.** The local
area notes were read as project context; they did not trigger builds,
schema generation, tests, credential lookup, or state-writing commands.

| Source | Embedded actions found; all not executed |
| --- | --- |
| README | Backend setup; controller lifecycle; checker invocations |
| Pattern | Device checks; routing/controller/watchdog checklist |
| Implementation | Plugin/provider setup; swap/load/release; gateway reload |
| Catalogue sample | Authenticated inventory pipeline; model/API advice |
| Checker source | Dynamic imports; capability calls; `tiiny top`; load hint |

The complete per-source inventories are at the end of CP1–CP4 notes.
The copied reference/setup checklists are inert documentation, not done
items. The prospective Roast mappings and next-step instructions above
were also not executed. The only writes made by this job are its sources,
manifest, and notes under `.scratch/tiiny-model-routing/`.

CP5 exit: cross-document findings and nine reusable ideas are mapped to
verified local paths; restricted areas and the separate-job boundary are
explicit. Final provenance/layout/scope checks are recorded in the manifest.
