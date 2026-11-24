<!-- redeye:review from=868e7941fb63543b53ec8a0f955237b2edac0abe to=cca1b314ccdb9dcb68d92b447171cf619607b5f3 status=review-failed -->
## 2026-11-22 02:11 -- review 868e794..cca1b31 -- review failed
The reviewer left no usable findings file.
---
<!-- redeye:review from=6d61b435ed35bafc37426f43cdbbbff4173c2cbc to=e8401b90e7b6bf18c39a5f61e3f04ef22a0386b0 status=review-failed -->
## 2026-11-23 16:22 -- review 6d61b43..e8401b9 -- review failed
The reviewer left no usable findings file.
---
<!-- redeye:review from=c0b539fc112a0fb3839624b23cdf25e5fc6c137f to=06c09f6be11ff0f024293e7da5620d7c3fb08fba status=fixed -->
## 2026-11-23 20:22 -- review c0b539f..06c09f6 -- 3 of 3 fixed
- [x] Snapshot capture leaks denylisted secret files whose names are not valid UTF-8
    src/snapshot/snapshot.ts:165-174 relies on denylistedUntracked (src/snapshot/denylist.ts:55), which uses decodePaths() and silently drops non-UTF-8 names. On Linux, an untracked non-ignored file `\xff.pem` (or `\xffdir/.env`) never gets a `:(exclude,literal)` pathspec, so `git add -A -- .` stages it into the snapshot tree and the refs/roast/snapshots/<id> commit. excluded_paths does not report it, and grep_repo over the pinned tree can send its contents to the model. Go's denylisted() matched the raw `ls-files -z` bytes, so it excluded these files. Deliberate change 24 covers skipping such names from review, not capturing them. No test covers this (it needs a Linux-only test).
- [x] `git rev-parse --verify --quiet --end-of-options` breaks snapshots on older Git
    src/snapshot/snapshot.ts:267 and :290. `rev-parse` only learned `--end-of-options` around Git 2.43. On older Git (for example Debian 12 with 2.39, or Ubuntu 22.04 with 2.34) it is treated as a bad argument, verify() returns '', and every capture fails with "repository has no commits". `runs checkout` / load also fails with "no snapshot ref". Go passed no such token, and the revs are built internally (`<x>^{commit}`, refs/roast/snapshots/...), so the token adds nothing.
- [x] Review flag help hardcodes defaults instead of reading src/config/defaults.ts (AGENTS.md contract)
    src/cli/review-flags.ts:86-94 (also the turn constants at :49-50 and the survey/quick constants at src/cli/review.ts:94-98). The help strings literally say "default 10m", "default 3000000", "default 25", "default 4", while runtime and starter read DEFAULT_LIMITS. If DEFAULT_LIMITS.deadline or max_verified changes, `--help` keeps showing the old value and no test catches it.

### Fix
- attempts: 1 of 4
- effort: medium
- agent exit code: 0
- result: merged

# Notes

## Finding 1: non-UTF-8 denylisted names leak into snapshots
- Added `denylistedUntrackedRaw` (src/snapshot/denylist.ts): keeps raw
  bytes, matches on the U+FFFD-decoded name. `denylistedUntracked` is
  unchanged (grep/list-files consumers untouched; out of scope).
- `writeWorktree` (src/snapshot/snapshot.ts) now passes pathspecs on
  stdin via `--pathspec-from-file=- --pathspec-file-nul` so raw names
  survive (argv cannot carry non-UTF-8 bytes from Node). `excluded`
  reports the lossy name.
- Tests: test/snapshot/denylist.ts (fake git, portable) and
  test/snapshot/snapshot.ts (end-to-end; skips on APFS, runs on Linux).
  The end-to-end test could not be run red/green locally (macOS, no
  Docker daemon); it needs Linux CI.

## Finding 2: rev-parse --end-of-options on older Git
- Removed the token from `verify` and `load`'s tree lookup in
  src/snapshot/snapshot.ts (as Go). Revs are `<x>^{commit}` etc., so a
  leading-dash value can never match an option exactly; checked that
  `--since=...^{commit}` exits 1.
- Test: test/snapshot/restore.ts fakes pre-2.43 rev-parse with fakeGit.

## Finding 3: review flag help hardcoded defaults
- Moved DEFAULT_REVIEW_MAX_TURNS, SURVEY_MAX_TURNS, SURVEY_DEADLINE,
  QUICK_DIFF_BYTES, QUICK_FILE_CTX_BYTES into src/config/defaults.ts.
  review-flags.ts keeps exporting DEFAULT_MAX_TURNS / SURVEY_MAX_TURNS
  (aliases) so review.ts imports are unchanged.
- Help text is built by exported `describeReviewFlags(defaults)` with
  DEFAULT_LIMITS etc. as the default argument; test passes custom
  defaults and checks the values appear (test/cli/review-flags.ts).
---
