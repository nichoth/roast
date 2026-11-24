# Pinned source manifest

Repository: `garciacionet-alt/AI_Articles`.

Commit C1 (resolved once from GitHub's `commits/main` API):
`2df1bf8d3ffeabfacfebab8a691109405ae9f01a`.

The commit date reported by the API is 2026-11-20T23:01:43Z.
The recursive tree at C1 reported `truncated: false`.
Only this repository's `api.github.com` and `raw.githubusercontent.com`
URLs were fetched. No redirects, clones, installs, or device calls were
used. Downloads are inert, non-executable workspace copies.

## Core sources: CP0 verified

All three byte counts match both the plan and the pinned API tree.
Their locally computed Git blob SHA-1 hashes match the API tree too.
The titles identify the description, pattern, and implementation documents.

Each row references C1 and the timestamps and titles defined below.

| Repository path | Commit | Bytes | Fetch | Title |
| --- | --- | ---: | --- | --- |
| `tiiny-model-routing/README.md` | C1 | 20620 | T1 | H1 |
| `tiiny-model-routing/PATTERN.md` | C1 | 14326 | T2 | H2 |
| `tiiny-model-routing/IMPLEMENTATION.md` | C1 | 25694 | T3 | H3 |

- T1: 2026-11-21T20:15:11.118493Z.
- T2: 2026-11-21T20:15:10.266747Z.
- T3: 2026-11-21T20:15:09.854100Z.
- H1: `# Routing Work to the Right Model`.
- H2: `## The pattern`.
- H3: `## The implementation`.

The fetch timestamps are the copies' filesystem modification times,
recorded immediately after successful downloads. Verification occurred at
2026-11-21T20:15:17.893140Z.

| Local copy | Git blob SHA-1 |
| --- | --- |
| `README.md` | `830fe6c72617c862a72b95e986f77aa3e2b84bd1` |
| `PATTERN.md` | `8f423af79c8f841320c432a87a6dc8437db6ccea` |
| `IMPLEMENTATION.md` | `7dc071e933c397e3ccf5f50c94f0d934b8c4a507` |

## Linked sources: CP4 verified

The same pinned API tree reports:

| Repository path | Commit | Bytes | Fetch | Title |
| --- | --- | ---: | --- | --- |
| `Tiiny/model-catalogue.md` | C1 | 60643 | T4 | H4 |
| `tiiny-model-routing/scripts/route_check.py` | C1 | 7622 | T5 | H5 |

- T4: 2026-11-21T20:20:07.387399Z.
- T5: 2026-11-21T20:20:08.562902Z.
- H4: `# Tiiny Model Store — every model and what it is actually good at`.
- H5: `#!/usr/bin/env python3`.

| Local copy | Git blob SHA-1 |
| --- | --- |
| `model-catalogue.md` | `c7423eadbb306320e18561be68ffc988e1cd7024` |
| `route_check.py` | `7ae1044f2415145decbe0169d049ffcaa5d63126` |

Both downloaded sizes and locally computed Git blob hashes match C1's
API tree. Both local copies have mode 0644, including the checker whose
upstream tree mode is 100755. No executable permission was copied.

Ruling: the catalogue differs from the plan's 238523 bytes. The strict
CP0 stop-on-mismatch gate names the three core documents, which passed.
CP4 asks for sampling rather than a fixed catalogue-size verification.
After asking the operator and allowing time for a response, proceed
with an explicitly stated assumption to sample the current pinned
catalogue. Cost if wrong: the sample describes a different catalogue
edition than the plan anticipated; the full copy and drift remain
available for review. No commit or source contents were changed.

## Execution record

- CP0: complete. Three core copies verified before CP1 notes began.
- CP1: complete; `notes/01-description.md` written after full source read.
- CP2: complete; `notes/02-pattern.md` includes the source checklist.
- CP3: complete; `notes/03-implementation.md` includes the inert checklist.
- CP4: complete; `notes/04-linked-materials.md` records sampling and drift.
- CP5: complete; `notes/05-synthesis.md` maps nine ideas to local paths.
- Final verification: passed; details below.
- The requested `plan.m` was interpreted as the existing `plan.md`.
- No separate specification exists; this plan is the job specification.
- Checkpoint dependency: each note consumes the pinned sources and the
  preceding note. CP5 also consumes local Roast area documentation.
- This is research, so no development worktree, application tests, code
  review, or development-branch integration is required. All job writes
  remain in this directory, as the plan explicitly requires.
- Initial `git status --short` was empty. Initially this directory
  contained only `plan.md`; the plan itself was left unchanged.
- No embedded source actions were executed.

## Final verification

Completed on 2026-11-21, with the last detailed audit at 20:26:51 UTC.

- All five copies match the pinned API tree's byte counts and Git blob
  SHA-1 values. The three core sizes also match the plan exactly.
- All five fetched copies lack executable permission. The Python source
  was read as text; no fetched module or command was executed.
- All five notes begin with pinned provenance and include their action
  inventory. CP4 records inclusive catalogue sample boundaries.
- The pattern reference checklist and implementation setup checklist
  match their source text verbatim. README command text matches after
  removing source comments and normalising Markdown line wrapping.
- Relative Markdown link targets and linked heading anchors resolve.
- Every authored note and manifest line is below 80 columns, with no
  trailing whitespace. Verbatim fetched sources retain their own layout.
- The directory contains exactly the planned 12 files: unchanged plan,
  manifest, five source copies, and five notes. No extra scripts, state,
  caches, or hidden files were created in it.
- `git status --short --untracked-files=all` reports exactly 11 additions,
  all under `.scratch/tiiny-model-routing/`; no tracked file was modified.
  `git diff --check` passes. Root `ls -a` shows no `.roast/` directory.
- No application tests/builds were needed for this document-only job.
  Verification inspected artifacts and repository scope without importing
  fetched Python or executing device, setup, provider, or gateway actions.

The final report is `notes/05-synthesis.md`; its last section summarises
embedded actions per source and links the detailed CP1–CP4 inventories.
