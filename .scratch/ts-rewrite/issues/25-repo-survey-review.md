# 25: Repo survey review (`scope: repo`)

**Blocked by:** 20
**Touches:** `src/scope/survey.ts` (`buildSurveyRepo`, `manifestQuote`),
`src/scope/build.ts` (dispatch `scope: "repo"`), `src/cli/review.ts`
(survey branches of 2.8 steps 9-13 and 18), `test/scope/survey.ts`,
`test/cli/review-survey.ts`; verify (and add if missing) the survey
branches in `src/prompts/` (`finder_scope_survey`, `renderFinderUser`
with `survey: true`) and `src/review/find.ts` (`submitDescription(true)`)
**Spec:** `spec/04-scope.md` 2.12, 2.12.1, 2.15, section 5 "Repo survey"
and the manifest-quoting row; `spec/01-cli.md` 2.7 items 9-11, 2.8 steps
9, 10, 12, 13, 15, 18, section 5 survey row; `spec/08-finder-prompts.md`
2.13, 2.16, 2.18 (survey description), 2.21; `spec/09-verify-render.md`
2.7 and 2.8 (survey fields and banner); `spec/11-snapshot.md` (`diff_pair`
`head` for survey)
**Status:** done

## What to build

A developer runs `npx roast review --scope repo` to triage the whole
committed tree instead of a diff. Roast lists the files at HEAD (from the
HEAD tree, not the index), applies `--paths`, excludes, and linguist
exclusions, and builds the repository manifest: the HEAD line, per
top-level directory counts, and every tracked file, with hostile names
Go-quoted by `manifestQuote` and an explanation line when any name was
quoted. A dirty working tree adds the documented notes and drops
linguist excludes rather than reading them from the mutable index.

The finder receives the manifest instead of a diff (`input_kind:
"manifest"` in `meta.json`, `input.gz` holds the manifest), the survey
scope framing prompt, and the survey `submit_findings` description. The
survey always runs interactively with the exploration tools; `--max-turns`
defaults to 40 and the deadline to 25m unless set; the small-diff
downgrade never applies. After the finder, the report gets `review_kind:
"survey_triage"`, `completion`, `stop_reason`, and the manifest file
count: a cut-off or incomplete run is `partial` (stop reason from the
result, or `incomplete_no_submission`); otherwise `complete` with
`converged`, and `NO_FINDINGS` becomes `NO_FINDINGS_IN_SAMPLED_AREAS`.

A repository with no tracked files is an empty scope: the `NO_DIFF`
report, exit 0, no run record. `--scope repo` with `--quick`,
`--staged`, `--uncommitted-only`, or `--base` stays the usage error from
ticket 20. With snapshots on (ticket 22 if landed), `diff_pair` is
`head`.

Branch survey scope is not ported (deliberate change 23).

## Acceptance criteria

Module seam (`build` against temp Git repositories):

- [x] The manifest lists tracked files, per-directory counts, and the
  HEAD line; `files` equals the sorted tracked file list.
- [x] Excludes and linguist-generated paths are absent from the listing.
- [x] A file staged but not committed is absent; a committed file
  deleted in the index is present (files reflect HEAD, not the index).
- [x] A dirty tree yields the two documented notes and no linguist
  excludes.
- [x] A bare directory `--paths` value selects its subtree.
- [x] No tracked files -> `isEmpty(scope)` is true.
- [x] Names containing a newline, `<`, or `>` appear quoted with
  `\x3c` / `\x3e` escapes and the explanation line is appended; a
  manifest of plain names has no explanation line.
- [x] Unit: `manifestQuote` matches Go `strconv.Quote` for controls,
  `"`, `\`, and non-printable code points (lowercase hex).

CLI seam (`run(argv, io)`, approved config, fake `chat` server):

- [x] `review --scope repo --no-verify --format json` sends the manifest
  in the finder user prompt, offers the exploration tools, and the fake
  receives two finder requests for a script that reads a file and then
  submits.
- [x] `meta.json` records `scope.survey: true`, `digests.input_kind:
  "manifest"`, and budgets `max_turns: 40` when `--max-turns` is not
  given; `--max-turns 5` is honored.
- [x] A converged clean survey reports `review_kind: "survey_triage"`,
  `completion: "complete"`, `stop_reason: "converged"`, and assessment
  `NO_FINDINGS_IN_SAMPLED_AREAS`.
- [x] A survey cut off by the token budget reports `completion:
  "partial"` with the budget stop reason and exits 4.
- [x] A non-survey review's JSON carries none of the survey fields.
- [x] `--scope repo` in a repository with no commits exits 0 with
  `NO_DIFF` and writes no run directory.

- [x] lint, typecheck, and the TS test suite pass, and the Go build and
  Go tests still pass.
