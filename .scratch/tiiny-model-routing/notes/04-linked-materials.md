Provenance: `Tiiny/model-catalogue.md` and
`tiiny-model-routing/scripts/route_check.py` @
`2df1bf8d3ffeabfacfebab8a691109405ae9f01a`.
Catalogue fetched 2026-11-21T20:20:07.387399Z; 60643 bytes.
Checker fetched 2026-11-21T20:20:08.562902Z; 7622 bytes.

# Linked-material notes

## Scope, drift, and sampling boundaries

The catalogue is **60643 bytes**, not the plan's 238523. It matches the
current pinned API tree and Git blob hash. The core CP0 copies match all
three strict planned sizes. After asking about the catalogue difference
and allowing time for a reply, the research proceeded with a stated
assumption: sample the pinned current catalogue and record its drift.
There was no change to the commit, core documents, or read-only frame.

The full catalogue was downloaded for provenance, but not read whole.
Headings were scanned across the file. Content samples use these exact
inclusive line ranges in the saved copy:

| Lines | Sample |
| --- | --- |
| 1–108 | Purpose, evidence limits, shared-NPU constraint |
| 115–135 | General-purpose entry and start of next entry |
| 164–185 | Terminal coding and adjacent variants |
| 206–225 | Research models; beginning of Sage entry |
| 286–303 | Text-only reasoning models |
| 372–389 | Image base model and start of adapter entry |
| 504–520 | OCR model and start of next entry |
| 547–564 | General and domain-specific speech recognition |
| 605–624 | Voice cloning and voice-design entries |
| 638–651 | New lightweight TTS tier and start of Kokoro entry |
| 711–728 | Music generation and editing |
| 781–824 | Video and 3D sections |
| 825–846 | Embedding variants |
| 882–901 | Text rerankers and start of multimodal entry |
| 918–1100 | Recommendations, metadata problems, counts, method, links |

Some ranges deliberately end mid-entry. Claims here use only the visible
part, not an assumed completion. An action-focused search additionally
located fenced commands and occurrences of CLI, script, API, load, run,
and setup language across the file. It found one fenced command block,
within the already sampled method section. This is not a full content
audit of every unsampled model paragraph.

The checker was read in full as inert source text, not imported, executed,
compiled, or given `--help`.

## Catalogue structure and what its entries claim

Sources: [opening](../sources/model-catalogue.md),
[specialties](../sources/model-catalogue.md#how-the-specialties-actually-work),
and [method](../sources/model-catalogue.md#method-and-provenance).

The document calls itself a research addendum to the factual inventory in
`thezolon/tiiny-api-notes`, adding judgements about specialisation. It
claims an 82-model device read on **2026-11-01**, with zero NPU/context
discrepancies against that day's live catalogue. It expressly says it did
not run or benchmark all models. Descriptions derive from device `desc`
fields, publisher model cards, and the author's interpretation; publisher
claims and opinions are not independent on-device measurements.

There is no alphabetical record index. Category headings group models;
entries begin with a bold full identifier, NPU share, sometimes context
or recommendation rank, then descriptive prose, use cases, and caveats.
An end summary maps category names to counts and a suggested best pick.
The device's own `type` vocabulary differs from the prose's categories.

The eleven category counts are: vision chat 17, text chat 11, images 14,
TTS 8, embeddings 8, rerankers 6, STT 6, music 5, OCR 4, 3D 2, video 1.
They sum to 82. Architecture, post-training, agent-versus-chat focus, and
Turbo distillation are the author's four interpretive axes. General
claims that MoE runs like a small model or Turbo loses accuracy are
presented without per-model measurements here.

## Representative entries across categories

These are sampled **source claims**, not recommendations independently
validated by this research job. Model identifiers retain source spelling.

| Category/model | Sampled distinction |
| --- | --- |
| Vision: `Qwen/Qwen3.6-35B-A3B` | 47%, 256K; repo agent, multimodal |
| Coding: `deepreinforce-ai/Ornith-1.0-35B` | 50%, 128K; terminal agent |
| Research: `endless-frontier/BigBang-v1-Turbo` | 54%, 128K; research |
| Reasoning: `openai/gpt-oss-20b` | 27%, 128K; low/medium/high levels |
| Image: `Tongyi-MAI/Z-Image-Turbo` | 26%; text rendering and size caveats |
| OCR: `zai-org/GLM-OCR` | 4%, 64K; formulas, tables, schema output |
| STT: `Qwen/Qwen3-ASR-1.7B` | 7%; noisy audio and songs |
| TTS: `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 5%; reference audio plus transcript |
| TTS: `hexgrad/Kokoro-82M` | 0%; preset voices, no reference sample |
| Music: `tencent/SongGeneration-v2-large` | 28%; separate vocals/backing |
| Video: `lightx2v/MiniMax-H3-Turbo` | 49%; short clips plus audio |
| 3D: `microsoft/TRELLIS.2-4B` | 6%; textured mesh/material generation |
| Embeddings: `Qwen/Qwen3-Embedding-0.6B` | 2%; local-index default opinion |
| Reranking: `Qwen/Qwen3-Reranker-0.6B` | 2%; retrieval second stage |

The TTS base contract reportedly requires `ref_audio` and `ref_text`;
a preset `voice: "alloy"` is incompatible. The image sample distinguishes
accepted explicit sizes from failing Hermes landscape/portrait presets.
The catalogue labels its embedding default as opinion and its 3D
community comparison as unverified on this device. Those qualifiers
matter more than its superlatives.

## Catalogue limitations and cross-document drift

Sources: "Known problems with the catalogue" and "The constraint that
decides everything: NPU is one shared pool" in the
[catalogue](../sources/model-catalogue.md), plus its
[method](../sources/model-catalogue.md#method-and-provenance).

- Catalogue snapshot: 82 models on 2026-11-01. README/pattern: 92 on
  2026-11-09. Implementation opening: 2026-10-31. Same pinned repository
  commit does not mean all documents describe the same device snapshot.
- Catalogue gives Qwen3.8-27B 51%; the core routing tables use 52%.
- The catalogue says Qwen3.6 moved from 55%/128K on 2026-10-27 to
  47%/256K on 2026-11-01, illustrating why copied values drift.
- An image adapter carries another adapter's description; Paddle records
  contradict their own parameter fields; some Turbo/size-to-NPU ratios
  are counterintuitive. Publisher/device metadata needs validation.
- Twenty-nine models reportedly have no app mapping. A catalogue entry
  does not prove a complete integration or usable API contract.
- The phrase "Everything below 60% can be combined" is too broad:
  the same section shows 47% plus 58% failing at 105%.
- The video paragraph says 49% cannot share with a large chat model,
  but the listed 47% flagship would sum to 96%. Capacity arithmetic alone
  does not support that blanket claim; generation limits may differ.
- The method disclaims benchmarks, while the image sample cites earlier
  Tiiny timing/size observations. Reported observations and exhaustive
  benchmarking should remain separate evidence classes.

## Checker: source behavior versus advertised role

Source: [full checker](../sources/route_check.py).

The advertised role is preflight output consumed by an operator/manager
before delegation: tier, model, NPU, context, reasoning controls, and
residency. There is no machine-readable output format, batch dispatcher,
reservation, or model-loading operation in `main`.

At module import time `_load` dynamically executes `tiers.py` and
`thinking.py`, searching the script's grandparent under `plugin/` then
`examples/tiiny-router/`. Those dependencies are intentionally not
fetched in this job. Running this saved copy would not be a safe way to
learn its arguments; it would attempt dependency execution first.

The parser exposes a goal, `--tier`, `--all`, `--image`, `--alternatives`,
and `--thinking auto|on|off`. `--all` prints all candidates and returns.
`--image` calls the shared special-model selector and prints its metadata.
Both branches return before the explicit resident-model CLI call.

For a normal goal, the code infers or forces the tier, then always
selects `TIER_CHOICES[tier][0]`. It prints capability text through
`thinking.describe_capability(model)` and, for explicit on/off, resolves
overrides and prints the prospective fields. It does not make a model
generation request, so its `sent:` text describes settings it would send.

The residency helper locates `tiiny`, with a home-directory fallback,
runs `tiiny top` through `subprocess.run` with a 30-second timeout,
and parses pipe-delimited full model identifiers. It does not check
the subprocess return code. No parsed identifiers, exceptions, or no
binary all become unknown; an empty device is not distinguished from
unavailable output. The final line reports loaded, unknown, or not loaded.
The not-loaded report embeds a suggested controller load command.

Important discrepancies from the prose:

1. It shares tier data and detection but **does not implement the backend's
   resident-candidate substitution**. It also does not read the controller
   plan. Its printed first choice can differ from the child's route.
2. The docstring claims catalogue reads only for an explicit thinking
   request. `describe_capability` is called even for `auto`; whether that
   function uses a live request/cache cannot be established without the
   skipped `thinking.py` source.
3. The docstring advertises exit 1 for an unknown tier. Parser `choices`
   rejects unknown values through argparse's usage-error path (exit 2).
   No explicit exit-1 return appears in the displayed source.
4. The usage example `--tier code` omits a goal, but `main` still requires
   one unless `--all` or `--image` is supplied.
5. `--alternatives` prints "same thinking setting" without resolving
   each alternate's capabilities. Different controls are possible.
6. Sharing data does not prove the checker and backend cannot drift:
   the selection procedures already differ in this pinned material.

These findings come from static reading, not executing the checker or
its dependencies. The helper's actual network behavior remains unverified.

## Deliberate skips

- `tiiny-model-routing/skill/SKILL.md`: agent-directed setup/instructions;
  outside the default read-only document scope.
- `tiiny-model-routing/scripts/tiiny_ctl.py`: device-mutating controller;
  record documented behavior without fetching or running it.
- `tiiny-model-routing/scripts/tiiny-swap.sh`: device-mutating shell script;
  the implementation document's displayed excerpt is sufficient for scope.
- `tiiny-model-routing/examples/tiiny-router/*`: backend modules are an
  implementation audit beyond the declared article/checker reading job.
- Catalogue links to `thezolon/tiiny-api-notes`, provider model cards,
  `api-call-logging.md`, and the Tiiny README were not followed. The first
  two exceed the permitted repository/network frame; the latter two are
  outside CP4's explicitly listed materials. No links were recursively
  fetched, and no corrections were posted to GitHub or Discord.

## Embedded actions not executed

**None of these actions was executed.** Catalogue coverage is the stated
samples plus action-focused scan; the checker was read in full.

Catalogue actions:

- Query `GET /api/v1/models/online_models` using a device bearer; compare
  the count, NPU shares, context, and `desc` fields with the snapshot.
- Run the method's `curl` pipeline into `python3 -c`, using `$TIINY_KEY`
  and `http://tiinyhost.local`; its entire block remains inert.
- Run community `tools/model_list.py` or `api_snapshot.py` and regenerate
  an inventory, fetch provider model cards, or change local model choices.
- Load/swap adapters or models, try recommended image sizes, use square
  or explicit size instead of failing presets, supply reference audio and
  transcript, test one's own 3D assets, or apply any "Reach for it" advice.
- Report metadata bugs, open an issue, contact Zolon/Tiiny, post on
  Discord, or follow related-document links.

Checker actions:

- All six docstring usage commands remain unexecuted: free-text goal,
  `--tier code`, `--all`, `--image`, `--thinking off`, `--thinking on`.
- `--alternatives` and every other argument combination remain unrun.
- No dynamic import, `spec.loader.exec_module`, shared detector,
  special-model selector, capability read, thinking resolver, or `main`
  was invoked. No device bearer was read.
- No `tiiny top` subprocess was started and no model was generated.
- The printed suggestion `tiiny_ctl.py load --model {model}` was recorded
  as an embedded action, not followed. Its support cannot be checked
  against the deliberately skipped controller source.

CP4 exit: both copies match the pinned tree; catalogue sample boundaries,
evidence limits, checker differences, and deliberate skips are explicit.
