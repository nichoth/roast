# 18: Run records

**Blocked by:** 16, 17
**Touches:** `src/record/dir.ts` (`STATE_DIR`, `recordDir`, `ensureDir`,
`makeRunDir`, `isValidName`, `openPrivate`, `writePrivate`,
`NoRecordDirError`), `src/record/run-id.ts` (`newRunId`),
`src/record/json.ts` (`goStringify`, `compactJSON`, `rfc3339NanoUTC`,
`rfc3339Local`), `src/record/meta.ts` (`Meta` and sub-types,
`serializeMeta`, `writeMeta`, `readMeta`, `wireProtocol`,
`resolveRunDir`, `reportPath`, `removeRun`, `writeArtifact`,
`readArtifact`, `writeReport`, `captureEnv`, `digest`),
`src/record/responses.ts` (`ResponseRecorder`,
`PROVIDER_RESPONSES_FILE`), `src/record/findings.ts`
(`openFindingSpill`), `src/record/index-file.ts` (`appendRunLine`,
`seenBefore`, `PriorSighting`), `test/record/`, `test/index.ts`
**Spec:** `spec/10-records.md` 2.1-2.11, 2.16, 3, 4, 5 ("Permissions",
"Meta and artifacts", "Provider responses", "Index and prior
sightings", "Run IDs and reports"); `spec.md` "Deliberate changes" 11,
"Cross-cutting rules" (JSON encoding, bytes and text), "Further Notes"
(oldest sighting per month, local index timestamps, UTC `meta.ts`)
**Status:** done

## What to build

The run-record library that `review` (ticket 20) will drive, tested at
the module seam inside temporary Git repositories (never this checkout's
`.roast/`).

`recordDir(cwd)` is `<toplevel>/.roast/runs` from `git rev-parse
--show-toplevel` via the shared git runner (ticket 03), or `""` outside a
repository; there is no environment override. `ensureDir` creates
`.roast` with a `*\n` `.gitignore` only when `.roast` is absent;
`makeRunDir` validates the name and re-tightens `runs/` and the run
directory to `0o700` on every write. Private files open with `0o600`
then `fchmod` so older wide-mode files are tightened.

Run IDs are `YYYYMMDDTHHMMSSZ-<8 hex>` (2.2). Every name used as a run ID
or artifact name must be a valid plain name: `.`, `..`, empty, and names
with `/` are rejected before touching the filesystem (deliberate change
11).

`meta.json` (2.4) is serialized in the documented key order with
omit-when-empty keys dropped and map keys sorted, written atomically, and
read back with legacy `api` reported as the wire protocol. `captureEnv`
records environment variable names only, excluding `*_API_KEY` and the
config's credential variable names. Artifacts are gzip files whose
decompressed bytes equal the input bytes exactly (diff `Buffer`s stay
`Buffer`s so digests match Go). `ResponseRecorder` appends
`provider-responses.jsonl` lines with gap-free sequence numbers, storing
JSON bodies compacted without altering number literals and event-stream
bodies as the raw stream string. `openFindingSpill` appends
`findings.jsonl`. `appendRunLine` writes the monthly
`runs-<local YYYY-MM>.jsonl` index (best effort, never throws), and
`seenBefore` scans recent monthly files for prior sightings (oldest
sighting within a month, newest month wins).

Out of scope: run bundles (19), the `runs` / `runs show` commands (23),
the review write ordering and the CLI-seam end-to-end checks (20, 21),
the snapshot meta block contents (22; the type is declared here).

## Acceptance criteria

- [x] In a temp repo, records resolve to `<toplevel>/.roast/runs` from a
  subdirectory cwd; `ROAST_RECORD_DIR` in `env` is ignored; outside a
  repository `recordDir` returns `""`.
- [x] Creating the first run writes `.roast/.gitignore` containing `*\n`;
  an existing `.roast` is left alone.
- [x] `meta.json`, gzip artifacts, `report.md`,
  `provider-responses.jsonl`, and `findings.jsonl`, whether new or
  pre-existing at `0o644` (including a leftover `.tmp`), end `0o600`; the
  run dir and `runs/` end `0o700`; the toplevel mode is unchanged.
- [x] The monthly index file is `0o600` and is re-tightened from `0o644`
  on the next append.
- [x] `isValidName` rejects `""`, `.`, `..`, and `a/b`; `makeRunDir`,
  `writeArtifact`, `readArtifact`, `readMeta`, and `resolveRunDir` reject
  `..` and `a/b` without filesystem effects; `removeRun('..')` throws and
  `.roast/` is intact.
- [x] `newRunId` returns 25 characters with `-` at index 16, and two
  consecutive IDs differ.
- [x] Meta round-trips through `writeMeta` / `readMeta` and artifacts
  round-trip through gzip, and no API key value appears in any written
  file.
- [x] A meta containing only the legacy `api` field reports it as the
  wire protocol.
- [x] `captureEnv` returns names only and excludes `*_API_KEY` names and
  the configured credential variable names.
- [x] Concurrent `ResponseRecorder` appends produce unique, gap-free
  sequence numbers and one valid JSON object per line.
- [x] An event-stream body is stored as a JSON string equal to the raw
  stream; a JSON body keeps number literals such as `1.0` and
  `12345678901234567890` exactly.
- [x] The digest of a diff containing invalid UTF-8 bytes equals the
  SHA-256 of the raw bytes, and `input.gz` decompresses to those bytes.
- [x] `appendRunLine` writes one parseable line with the documented
  fields, prompt packs, and a `fingerprint` on every finding, to
  `runs-<local YYYY-MM>.jsonl`; repeated calls append; outside a repo it
  writes nothing and does not throw.
- [x] `seenBefore` matches, misses, filters other repos, honors the
  lookback file count, handles an empty dir, scans dropped findings with
  their drop reason, returns the earlier line within one month, and
  prefers the newer month across months.
- [x] Writing a report then reading it through `reportPath` returns the
  same content.
- [x] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
