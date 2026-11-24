# Area: run records, run bundles, `runs` / `runs show`

## 1. Purpose

A **run record** is the stored evidence of one review, kept inside the
project that was reviewed. This area owns:

- where run records live (`.roast/runs` at the Git toplevel),
- the run ID,
- every file in a run directory and its byte format,
- the monthly JSONL index (`runs-YYYY-MM.jsonl`) and the prior-sighting
  scan over it (`SeenBefore`, used for the "seen previously" note),
- the deterministic run bundle (`bundle.tar.zst`) and its embedded
  manifest, including verification,
- the `runs` (list) and `runs show` commands.

Out of scope here: `runs checkout` and `runs prune` (snapshot area), the
contents of the snapshot fields in `meta.json` (snapshot area fills them;
this file only fixes their JSON shape), the finding shape and fingerprint
(review area), `render.ToJSON` / `render.ToMarkdown` (render area), the
per-response capture cap and streaming capture (llm area), `textsafe.Text`
(text sanitization area), error output formatting and exit-code mapping
(CLI area).

Run records are never sent anywhere. Nothing in a run directory may hold a
credential value: only variable names (`env_names_only`) and digests.

## 2. Behavior contract

### 2.1 Record directory

- `StateDir = ".roast"`. The records directory is
  `<toplevel>/.roast/runs`, where `<toplevel>` is the output of
  `git rev-parse --show-toplevel` run in the process working directory
  (the injected `cwd` in the TS in-process entry), trimmed of surrounding
  whitespace.
- If the `git` command fails (non-zero exit, not a repository, `git`
  missing) or prints an empty string, the records directory is `""`
  ("recording unavailable"). There is no environment override (Go tests
  set `ROAST_RECORD_DIR` only to prove it is ignored).
- The project config's location does not matter: a config in a
  subdirectory still writes records at the toplevel.
- Go resolves the directory afresh (spawning `git`) on every record
  operation. The TS port may resolve it once per command invocation and
  pass it down; behavior is identical because the working directory does
  not change during a command.

Creating the records directory (`ensureDir(dir)`):

1. Let `state = dirname(dir)` (the `.roast` directory).
2. If `lstat(state)` reports "does not exist": `mkdir -p state` with mode
   `0o700`, then write `state/.gitignore` with content `*\n` and mode
   `0o644`. Any failure is an error `create <state>: <err>` /
   `write <ignore>: <err>`. If `.roast` already exists (any type), it is
   left alone and no `.gitignore` is written.
3. `mkdir -p dir` with mode `0o700` (error
   `create record directory <dir>: <err>`).

Modes are creation modes subject to umask, as in Go.

Creating a run directory (`makeRunDir(dir, runID)`):

1. Validate `runID` (see 2.2 "valid name").
2. `ensureDir(dir)`.
3. `mkdir -p <dir>/<runID>` with mode `0o700`
   (error `create run directory <runDir>: <err>`).
4. `chmod 0o700` both `dir` and `runDir`, even if they already existed
   (error `protect run directory <path>: <err>`). The `.roast` directory
   and the toplevel are never chmodded.

Every write in a run directory goes through `makeRunDir` first, so any
record write re-tightens `runs/` and the run directory.

Private files (`openPrivateFile`): open with the requested flags and
creation mode `0o600`, then `fchmod(fd, 0o600)` on the open descriptor so
files left by older versions with wider modes are tightened too. If the
chmod fails the descriptor is closed and the error returned.
`writePrivateFile(path, data)` = open with `O_CREAT|O_WRONLY|O_TRUNC`,
write all bytes, close.

### 2.2 Run ID

Format: `<UTC time as YYYYMMDDTHHMMSSZ>-<8 lowercase hex>`, e.g.
`20260726T193000Z-a3f1c92b`. Always 25 characters, `-` at index 16.

- Time is the current time in UTC, second precision.
- Suffix is 4 bytes from the CSPRNG (`crypto.randomBytes(4)`), hex
  encoded. If the CSPRNG fails, Go falls back to
  `uint32(nowUnixNanos) XOR uint32(pid)` big-endian; the TS port may keep
  that fallback or let the error propagate (Node's `randomBytes` does not
  fail in practice). Two consecutive IDs must differ.
- IDs sort lexically in time order. The same ID names the run directory,
  the snapshot ref (snapshot area), and the `run_id` in all outputs.

"Valid name" (used for run IDs, artifact names, and bundle entry names):
non-empty, equal to its own `basename` (no `/`), and neither `.` nor `..`
(deliberate change 11 in spec.md; Go accepted `..`). Path separators are
rejected, so `removeRun("..")` and `makeRunDir("..")` can never touch
`.roast/` itself.

### 2.3 Run directory layout

`<toplevel>/.roast/runs/<run-id>/` is flat (no subdirectories). Files, in
the order a successful review writes them:

| File | Written | Format |
|---|---|---|
| `meta.json` | init, rewritten at finalize | 2.4 |
| `input.gz` | init | gzip of reviewed input (diff or survey manifest) |
| `finder_system.gz` | init | gzip of finder system prompt |
| `finder_user.gz` | init | gzip of finder user prompt |
| `verifier_system.gz` | init | gzip of verifier system prompt |
| `provider-responses.jsonl` | per model response | 2.7 |
| `findings.jsonl` | per incrementally reported finding | 2.8 |
| `result.json.gz` | finalize | gzip of `render.ToJSON(report)` |
| `report.md` | finalize | `render.ToMarkdown(report, true)`, plain |
| `bundle.tar.zst` | finalize | 2.12 |

Transient files: `meta.json.tmp` (during a meta write) and
`bundle.tar.zst.tmp` (bundle build lock and staging file).

`provider-responses.jsonl` exists only if at least one response was
captured; `findings.jsonl` only if the finder reported at least one
finding through the incremental sink.

#### Write ordering in `review` (the only producer)

1. Early exit with nothing to review returns before a run ID is minted:
   no run directory.
2. Mint the run ID. Snapshot capture happens (snapshot area).
3. Build `meta` (2.4) with `usage` absent and `budgets` holding the
   pre-inference budgets.
4. `initializeRunArtifacts`: write `meta.json` (2.4 atomic write), then the
   four `.gz` artifacts `input`, `finder_system`, `finder_user`,
   `verifier_system` (order among the four does not matter; Go iterates a
   map). Each is written even when its content is the empty string. Any
   failure: remove the whole run directory (`removeRun`), and the review
   fails with `initialize run record: <err>` or
   `initialize run artifact <name>: <err>`.
5. Inference runs. Each captured provider response is appended to
   `provider-responses.jsonl`; each incrementally reported finding is
   appended to `findings.jsonl`.
6. Prior sightings are computed from the JSONL index (2.9) before this
   run is indexed, so a run never sees itself.
7. The report is written to stdout/stderr (render area).
8. `meta.usage` and `meta.budgets` are set to final values.
9. `finalizeRunArtifacts`, in this order, stopping at the first error:
   1. `result.json.gz` -- error `finalize run result: <err>`
   2. `report.md` -- error `finalize run report: <err>`
   3. `meta.json` rewrite -- error `finalize run metadata: <err>`
   4. resolve the run directory via `runDir(runID)` -- error
      `resolve run bundle directory: <err>`
   5. build the bundle -- error `build local run bundle: <err>`
   6. append the JSONL index line (best effort, never fails).
10. Only if finalize succeeded, stderr gets the log line naming the run
    ID and the `report.md` path (CLI area owns the wording).

A finalize error takes precedence over the findings gate and partial
exit codes: it is a plain (non-usage) error, exit 4. If inference fails
after step 4, the run directory is left as it is (meta, inputs, possibly
responses and findings; no result, report, or bundle; no index line).

#### Removing an incomplete run (`removeRun(runID)`)

Validate the ID (error `remove partial run: invalid run id "<id>"`). If
the records directory is `""`, do nothing. Otherwise `rm -rf
<dir>/<runID>`.

### 2.4 `meta.json`

The secret-free replay contract of a run. Serialized as JSON with 2-space
indentation (Go `json.MarshalIndent(meta, "", "  ")`, equivalent to
`JSON.stringify(meta, null, 2)` with the escaping in 2.11) followed by one
`\n`. Object keys appear in the order listed below. Map-typed fields
(`roles`, `budgets`, `usage`) have keys sorted bytewise (Go sorts map keys).

"omit when empty" means the key is absent when the value is `""`, `0`,
`false`, an empty or absent array, or an empty or absent object.

Top level:

| Key | Type | Rule |
|---|---|---|
| `run_id` | string | always |
| `replay_of` | string | omit when empty (never set by `review`) |
| `ts` | string | always; UTC RFC 3339 with nanosecond fraction, see 2.11 |
| `repo` | string | always; absolute Git toplevel of the reviewed repo |
| `invoke_dir` | string | omit when empty (never set by `review`) |
| `argv` | string[] | omit when empty; CLI arguments after the program name |
| `roast` | object | always; `{ "version", "commit" }`, both strings |
| `scope` | object | always; see below |
| `derived` | object | always; see below |
| `roles` | object | always; map role name -> RoleMeta |
| `snapshot` | object | always; see below |
| `digests` | object | always; see below |
| `budgets` | object | omit when empty; see below |
| `usage` | object | omit when empty; map role name -> UsageMeta |
| `env_names_only` | string[] | omit when empty; see 2.5 |
| `caveats` | string[] | omit when empty |

`argv`: Go records `os.Args[1:]`. The TS port records the argv the CLI
entry received (`process.argv.slice(2)` in production; the `run(argv, io)`
argument in-process).

`roast.version` / `roast.commit`: the build identity strings (packaging
area defines them).

`scope` (key order as listed; all strings unless noted):

| Key | Rule |
|---|---|
| `kind` | always; the `--scope` flag value |
| `base` | omit when empty |
| `uncommitted_only` | bool, omit when false |
| `staged_only` | bool, omit when false |
| `include_vendored` | bool, omit when false |
| `paths` | string[], omit when empty |
| `excludes` | string[], omit when empty |
| `base_oid` | omit when empty; scope base OID, else snapshot `base` |
| `merge_base_oid` | omit when empty |
| `head_oid` | omit when empty; scope head OID, else snapshot `head` |
| `survey` | bool, omit when false |
| `staged` | bool, omit when false |
| `files` | string[], omit when empty |

`derived`:

| Key | Rule |
|---|---|
| `mode` | string, always |
| `langs` | string[], omit when empty |
| `quick` | bool, omit when false |
| `interactive` | bool, always |
| `max_turns` | integer, always |
| `confidence_floor` | number, always |
| `do_verify` | bool, always |
| `task` | string, omit when empty |
| `max_severity` | string, omit when empty |
| `max_diff_bytes` | integer, omit when 0 |
| `max_file_ctx_bytes` | integer, omit when 0 |

`roles` has exactly the keys `finder` and `verifier`. RoleMeta:

| Key | Rule |
|---|---|
| `profile` | string, omit when empty |
| `base_url` | string, always |
| `model` | string, always |
| `protocol` | string, always |
| `api` | string, omit when empty; legacy, never written by `review` |
| `max_output_tokens` | integer, always |
| `session_header` | string, omit when empty |
| `prompt_digest` | string, omit when empty; `digest(role system prompt)` |

Readers use `protocol` when non-empty, else the legacy `api` field
("wire protocol").

`snapshot` (filled by the snapshot area):

| Key | Rule |
|---|---|
| `captured` | bool, always |
| `reason` | string, omit when empty |
| `ref`, `commit` | strings, each omitted when empty |
| `index_tree`, `worktree_tree` | strings, each omitted when empty |
| `base_tree`, `head`, `base` | strings, each omitted when empty |
| `diff_pair`, `file_modes` | strings, each omitted when empty |
| `excluded_paths` | string[], omit when empty |

`digests`:

| Key | Rule |
|---|---|
| `input_kind` | `"diff"` or `"manifest"` (survey), always |
| `input` | `digest(reviewed input)`, always |
| `input_bytes` | integer, byte length of the reviewed input, always |
| `system_prompt` | `digest(finder system)`, omit when empty |
| `user_prompt` | `digest(finder user)`, omit when empty |

`digest(x)` = lowercase hex SHA-256 of the bytes of `x`: a string is
encoded as UTF-8, a `Buffer` is hashed as is. The reviewed diff stays a
`Buffer` wherever it is hashed or recorded (spec.md "Bytes and text"), so
`digests.input`, `input_bytes`, and `input.gz` match Go even when the diff
is not valid UTF-8; never decode it to a string first.

`budgets` is a free-form map; `review` writes these keys (values as
listed):

- `deadline_duration`: string, Go `time.Duration.String()` format
  (`"0s"`, `"1m30s"`, `"10m0s"`, `"1h0m0s"`, `"500ms"`)
- `request_timeout`: string, same format
- `max_total_tokens`, `verifier_cap`, `max_turns`, `max_attempts`,
  `max_prompt_bytes`: integers
- `ledger_committed_tokens`: integer, only when the token ledger has a
  positive limit; added after inference (present only in the final write)

The duration formatter is shared with the CLI area (Go-style durations).

`usage` (final write only): keys are role names (`finder`, plus
`verifier` when verification ran). UsageMeta, all integers, always
present, in this order: `uncached_input_tokens`, `cached_input_tokens`,
`cache_write_tokens`, `output_tokens`, `calls`.

`caveats`: human strings from snapshot capture (snapshot area).

#### Writing meta (atomic)

1. Validate `meta.run_id` (error `write meta: invalid run id "<id>"`).
   Records directory `""` -> error
   `resolve record directory: run inside a Git repository`.
2. `makeRunDir`.
3. Serialize. Write `<runDir>/meta.json.tmp` with `writePrivateFile`
   (tightens a pre-existing tmp too). Error `write <tmp>: <err>`.
4. `rename(tmp, meta.json)`. On failure remove the tmp and return
   `publish <path>: <err>`.

#### Reading meta (`readMeta(id)`)

Resolve `runDir(id)` (2.10). Read `meta.json` (error
`run <basename> has no meta.json: <err>`), parse JSON leniently: unknown
keys ignored, missing keys take zero values (error `parse <path>: <err>`).
Returns the meta and the run directory. Used by `runs checkout`
(snapshot area).

### 2.5 `env_names_only` (`captureEnv`)

The names, never the values, of environment variables that:

- start with `ROAST_`, and
- are not `ROAST_FINDER_API_KEY` or `ROAST_VERIFIER_API_KEY`, and
- do not end with `_API_KEY`, and
- are not in the extra list passed by the caller (the config's
  credential variable names, `cfg.CredentialEnvNames()`, config area).

Sorted bytewise. Empty -> key omitted. The environment is the injected
`env` in the TS in-process entry.

### 2.6 Gzip artifacts (`writeArtifact(runID, name, content)`)

- Validate `runID` (error `write artifact: invalid run id "<id>"`) and
  `name` (error `write artifact: invalid name "<name>"`).
- Records directory `""` -> the "resolve record directory" error.
- `makeRunDir`, gzip the UTF-8 bytes of `content`, write
  `<runDir>/<name>.gz` with `writePrivateFile` (overwrite, not atomic).
  Errors: `compress artifact "<name>": ...`, `write <path>: <err>`.
- Go writes a gzip member with no file name, MTIME 0, XFL 0, OS 255.
  Node's `zlib.gzipSync` writes a different OS byte and a different
  deflate stream. Byte identity of `.gz` files with Go is not required;
  parity is on the decompressed bytes. Use `zlib.gzipSync(buf)` with
  default options.

`readArtifact(runDir, name)`: validate name (error
`read artifact: invalid name "<name>"`), open `<name>.gz` (raw open error
returned), gunzip fully (error `read <path>: <err>`), return as UTF-8
string.

`report.md` is written uncompressed with `writePrivateFile` (error
`write <path>: <err>`); empty run ID -> `write report: empty run id`.

### 2.7 `provider-responses.jsonl`

Append-only transcript of native provider response bodies, one JSON
object per line, `\n` terminated. Never request headers or credentials.

Line shape, keys in this order:

```json
{"sequence":1,"role":"finder","protocol":"chat","model":"m",
 "content_type":"application/json","body":{...}}
```

(shown wrapped; on disk it is one line, compact, no spaces).

- `sequence`: integer, per recorder (one recorder per run), starting at 1,
  incremented once per accepted append, under the recorder's lock.
- `role`, `protocol`, `model`: strings as given by the inference client.
- `content_type`: exactly `application/json` or `text/event-stream`.
- `body`:
  - `application/json`: the body must be valid JSON (else error
    `record provider response: body is not valid JSON`); it is embedded
    as JSON, compacted (whitespace outside strings removed) with the
    string escaping in 2.11. Compaction must be textual, not
    parse-and-restringify: number literals, key order, and duplicate keys
    are preserved exactly.
  - `text/event-stream`: the body must be valid UTF-8 (else error
    `record provider response: event stream is not valid UTF-8`); it is
    embedded as one JSON string containing the raw stream losslessly.
  - any other content type: error
    `record provider response: unsupported content type "<ct>"`.
- Invalid or empty run ID -> `record provider response: invalid run id`.
- Records directory `""` -> the "resolve record directory" error.

Each append: `makeRunDir`, open with `O_APPEND|O_CREAT|O_WRONLY` via
`openPrivateFile`, write the line, `fsync`, close. Errors are returned to
the caller (`open <path>: ...`, `append <path>: ...`, `sync <path>: ...`,
`close <path>: ...`); the llm area decides what a capture failure does to
the request. Validation and line serialization happen before the
directory is touched. Concurrent appends (parallel verifier calls) must be
serialized so sequence numbers are unique and lines never interleave.

The 16 MiB cap on a captured body is enforced by the llm area before
`append` is called.

### 2.8 `findings.jsonl` (finding spill)

`openFindingSpill(runID)` returns a sink, or nothing when the records
directory is `""`, the run ID is empty, or `makeRunDir` fails (checked
once, at open). The sink appends one line per reported finding:

```json
{"ts":"<UTC RFC3339 nano>","fingerprint":"<fp>","finding":{...}}
```

- `ts`: arrival time, UTC, RFC 3339 with trimmed nanosecond fraction.
- `fingerprint`: `review.fingerprint(wireFinding.toFinding())` (review
  area).
- `finding`: the wire finding as the model reported it (review area's
  WireFinding JSON shape).

Best effort: serialization, open, or write failures are swallowed. Open
with `O_APPEND|O_CREAT|O_WRONLY` via `openPrivateFile`, one write per
line, no fsync. A re-reported finding appends again; consumers dedup by
fingerprint, last line wins.

### 2.9 Monthly JSONL index

File: `<recordsDir>/runs-<YYYY>-<MM>.jsonl`, year and month in the
**local** time zone at the moment of writing. One line per completed run,
appended after the bundle is built.

`appendRunLine(report, repo, argv)` is strictly best effort: records
directory `""`, `ensureDir` failure, serialization, open, or write
failure -> silently nothing. It calls `ensureDir` only (it does not
chmod `runs/`). The file is opened with `O_APPEND|O_CREAT|O_WRONLY` via
`openPrivateFile` (so it is tightened to `0o600` on every append), the
line plus `\n` is written in one write, no fsync.

Line shape, compact JSON, keys in this order:

| Key | Type | Value |
|---|---|---|
| `ts` | string | local time, RFC 3339 seconds (2.11) |
| `run_id` | string | omitted when empty |
| `repo` | string | absolute repo toplevel |
| `argv` | string[] or null | same as `meta.argv`; `null` when absent |
| `mode` | string | `report.mode` |
| `quick` | bool | |
| `verified` | bool | |
| `assessment` | string | `report.result.assessment` |
| `n_findings` | integer | count of kept findings |
| `n_dropped` | integer | count of dropped findings |
| `n_refuted` | integer | dropped with reason `DropRefutedByVerifier` |
| `files_reviewed` | string[] or null | `report.filesReviewed` |
| `findings` | object[] | kept findings, always an array (possibly `[]`) |
| `dropped_findings` | object[] | dropped findings, always an array |
| `usage` | object or null | role -> UsageMeta keys, sorted |
| `prompt_packs` | string[] or null | `report.promptPacks` |
| `budgets` | object | same map as `meta.budgets`, keys sorted |

`n_refuted` counts dropped findings whose drop reason is the review area
constant `DropRefutedByVerifier`. `budgets` is present in practice for
every run `review` writes. The `ts` example: `2026-11-18T10:04:05-08:00`.

Each element of `findings` / `dropped_findings` is the review area's
Finding JSON object (keys in its declared order: `reasoning`, `severity`,
`confidence`, `cwe`, `description`, `file`, `lines`, `code_quote`,
`fixed_code`, `frontend_category`, then the post-hoc `verdict`,
`_drop_reason`, `id`, `alias` with their omit-when-empty rules) with one
extra key appended last: `"fingerprint": review.fingerprint(finding)`.

Where Go would serialize a nil slice/map as `null` (`argv`,
`files_reviewed`, `prompt_packs`, `usage`), the TS port writes `null` when
the source value is absent and the array/object otherwise.

#### Prior sightings (`seenBefore(repoDir, findings, lookbackFiles)`)

Used by `review` to annotate findings seen in earlier runs.

1. `lookbackFiles <= 0` -> 3. `review` passes 3.
2. `repoDir` is made absolute (`path.resolve`).
3. Records directory `""` -> empty result. No target fingerprints (no
   findings) -> empty result.
4. List the records directory (read failure -> empty result). Keep
   non-directory entries whose name starts with `runs-` and ends with
   `.jsonl`. Sort full paths descending (bytewise) and keep the first
   `lookbackFiles`.
5. Scan each file in that order (newest month first). Stop early once
   every target fingerprint has a sighting.
6. Per file, read lines in file order (oldest first). Lines longer than
   4 MiB end the scan of that file (Go scanner limit). Skip lines that do
   not parse as JSON. Skip lines whose `repo` differs from `repoDir`
   (exact string compare; lines with an empty or missing `repo` are
   therefore skipped too). For each element of `findings` then
   `dropped_findings`: skip empty `fingerprint`; if the fingerprint
   already has a sighting, keep the existing one; if it is a target,
   record `{ runTS: line.ts, dropReason: element._drop_reason ?? "" }`.
7. Return the map fingerprint -> sighting.

Because lines are read oldest first and the first match wins, within one
monthly file the **oldest** sighting wins, while across files the newest
month wins. This keeps Go's behavior; Go's code comment saying the newest
sighting wins is wrong and is not ported. `review` renders each sighting as the
note `seen previously in run <ts>` plus ` (dropped: <reason>)` when the
drop reason is non-empty (render/CLI area own the wording).

### 2.10 Resolving a run (`runDir(id)`, `reportPath(id)`)

1. `id` must be a valid name (2.2), else `invalid run id "<id>"`.
2. Records directory `""` -> `resolve record directory: run inside a Git
   repository`.
3. List the records directory; failure (including "does not exist") ->
   `no run artifacts in <dir>: <err>`.
4. Matches = directory entries (real directories, not symlinks) whose
   name starts with `id`, sorted bytewise.
5. 0 matches -> `no run matches "<id>" under <dir>`; 1 match -> its path;
   more -> `"<id>" is ambiguous: matches <a>, <b>, ...` (comma-space
   joined, sorted).

`reportPath(id)` = `<runDir(id)>/report.md`. A full run ID or any unique
prefix resolves.

All of these are plain errors (exit 4 from `runs show`), not usage errors.

### 2.11 Shared serialization rules

- **String escaping.** Go's `encoding/json` escapes `<`, `>`, `&` as
  `<`, `>`, `&`, and U+2028 / U+2029 as ` ` /
  ` `, and replaces invalid UTF-8 with U+FFFD. To keep files
  byte-close to Go, every JSON file in this area is produced by a
  `goStringify(value, indent?)` helper: `JSON.stringify` then replace each
  of those five characters in the output with its `\uXXXX` form (safe
  because they can only occur inside JSON strings). Parity requirement is
  parse-equivalence; byte equality is the goal.
- **Raw JSON compaction** (`compactJSON(text)`) for provider bodies:
  a single-pass lexer that drops whitespace (space, tab, CR, LF) outside
  strings and applies the same five-character escaping inside strings,
  leaving everything else byte-for-byte.
- **Numbers.** Integers serialize as integers. `confidence_floor` and
  finding confidences are JS numbers (`JSON.stringify` output matches Go
  for the values Roast produces).
- **Timestamps.**
  - `meta.ts`, `findings.jsonl` `ts`: UTC, `YYYY-MM-DDTHH:MM:SS[.frac]Z`,
    where `frac` is the sub-second part with trailing zeros removed and
    the dot omitted when zero (Go `RFC3339Nano`). JS has millisecond
    precision, so at most 3 fraction digits.
  - index `ts`: local time (Go parity, kept; `meta.ts` stays UTC),
    `YYYY-MM-DDTHH:MM:SS` followed by `Z` if the local UTC offset is zero, else
    `+HH:MM` / `-HH:MM` (Go `RFC3339`).
- **Bytewise sort**: compare names as UTF-8 byte strings
  (`Buffer.compare`), not with JS default `sort()`.

### 2.12 Run bundle (`bundle.tar.zst`)

Constants:

- `BundleFile = "bundle.tar.zst"`
- `ManifestFile = "bundle-manifest.json"` (only inside the archive, never
  written beside it)
- `Format = "roast-run-bundle"`, `Version = 1`
- `maxManifestBytes = 1048576` (1 MiB)
- `bundleStaleLockAge = 10 minutes`

#### Manifest

Embedded as the archive entry `bundle-manifest.json`. JSON with 2-space
indentation and a trailing `\n`:

```json
{
  "format": "roast-run-bundle",
  "version": 1,
  "files": [
    {
      "path": "finder_system.gz",
      "sha256": "<64 lowercase hex>",
      "size": 1234
    }
  ]
}
```

- `files` lists every archived run file except the manifest itself, in
  bytewise name order; `sha256` is the lowercase hex SHA-256 of the exact
  archived bytes; `size` is the byte length.
- If there are no run files, Go writes `"files": null` (cannot happen in
  `review`, which always has `meta.json`); the TS port writes `null` in
  that case for parity.

#### Build (`buildBundle(runDir)`)

Returns `{ path, sha256, size }` of the bundle file. Built once:

1. `chmod 0o700 runDir` (error `protect run directory <runDir>: <err>`).
2. `path = runDir/bundle.tar.zst`. `lstat(path)`:
   - exists and is not a directory:
     - not a regular file (symlink, etc.) -> error
       `existing bundle <path> is not a regular file`;
     - `chmod 0o600` (error `protect existing bundle <path>: <err>`);
     - verify it (2.13), error `verify existing bundle <path>: <err>`;
     - hash the file, error `hash existing bundle <path>: <err>`;
     - return `{ path, sha256, size from lstat }` without rebuilding.
   - otherwise continue (a directory at `path` makes the final rename
     fail, see step 7).
3. `tmp = path + ".tmp"`. Acquire the lock (below).
4. Collect files (below). On error remove `tmp` and return it.
5. Write the archive into `tmp` (below). On error remove `tmp`.
6. `rename(tmp, path)`; on failure remove `tmp`, error
   `finalize bundle: <err>`.
7. `stat(path)` for size. Verify (error
   `verify freshly built bundle <path>: <err>`). Hash (error
   `hash freshly built bundle <path>: <err>`). Return.

Lock (`acquireBundleLock(tmp)`):

1. Create `tmp` with `O_CREAT|O_EXCL|O_WRONLY`, mode `0o600`, close it.
   Success -> locked.
2. Failure other than "exists" -> `create bundle lock <tmp>: <err>`.
3. Exists: `stat(tmp)`. Vanished -> `ErrBundleBuildInProgress`. Other
   stat error -> `stat bundle lock <tmp>: <err>`. `now - mtime < 10 min`
   -> `ErrBundleBuildInProgress`.
4. Stale: remove it (error other than "not found" ->
   `reclaim stale bundle lock <tmp>: <err>`), then create exclusively
   again; failure -> `ErrBundleBuildInProgress`.

`ErrBundleBuildInProgress` message:
`bundle build already in progress by another process`.

Collect files (`bundleFiles(runDir)`):

1. List `runDir`, sort entries bytewise by name.
2. Skip: directories (by dirent type, so a symlink to a directory is not
   skipped), the name `bundle.tar.zst`, and names whose extension (text
   from the last `.`) is exactly `.tmp`.
3. A file named `bundle-manifest.json` -> error
   `run directory contains reserved bundle path bundle-manifest.json`.
4. For each remaining name, read it as a regular artifact:
   - `lstat`: symlink -> `run artifact <name> is a symlink; only regular
     files may be bundled`; not regular -> `run artifact <name> is not a
     regular file`;
   - open, `fstat`; if not regular or not the same file (dev + ino) as
     the `lstat` -> `run artifact <name> changed while the bundle was
     being built`;
   - read all bytes once; these exact bytes are both hashed and archived.
5. Append the manifest entry `{ path, sha256, size }`.
6. Serialize the manifest (above), add it as an archive file, then sort
   all archive files bytewise by name. In a normal run the archive order
   is: `bundle-manifest.json`, `finder_system.gz`, `finder_user.gz`,
   `findings.jsonl`, `input.gz`, `meta.json`,
   `provider-responses.jsonl`, `report.md`, `result.json.gz`,
   `verifier_system.gz` (present files only).

Write the archive: open `tmp` with `O_WRONLY|O_TRUNC` (no create; the
lock created it), `fchmod 0o600`, write `zstd(tar(files))`, close.

#### Tar stream (must be byte-identical to Go's)

The uncompressed tar produced by the TS writer must equal Go's
`archive/tar` output for the same inputs, including inputs that need PAX
path records (below). For each file, one 512-byte
ustar header, then the data, zero-padded to a multiple of 512. After the
last file, two 512-byte zero blocks (1024 bytes). No padding to a 10240
record size. Example: one 9-byte file -> 2048 bytes total.

Header fields (offsets in bytes; unspecified bytes are NUL):

| Field | Off | Len | Value |
|---|---|---|---|
| name | 0 | 100 | file name bytes, NUL-filled (no NUL if exactly 100) |
| mode | 100 | 8 | `0000600\0` |
| uid | 108 | 8 | `0000000\0` |
| gid | 116 | 8 | `0000000\0` |
| size | 124 | 12 | size as 11 zero-padded octal digits + `\0` |
| mtime | 136 | 12 | `00000000000\0` (Unix epoch) |
| chksum | 148 | 8 | 6 zero-padded octal digits + `\0` + space |
| typeflag | 156 | 1 | `0` (ASCII 0x30) |
| linkname | 157 | 100 | all NUL |
| magic | 257 | 6 | `ustar\0` |
| version | 263 | 2 | `00` (ASCII) |
| uname | 265 | 32 | all NUL |
| gname | 297 | 32 | all NUL |
| devmajor | 329 | 8 | `0000000\0` |
| devminor | 337 | 8 | `0000000\0` |
| prefix | 345 | 155 | all NUL |
| (pad) | 500 | 12 | all NUL |

Checksum: the unsigned sum of all 512 header bytes with the chksum field
taken as eight spaces (0x20), written as `%06o` + NUL + space. Verified
against Go 1.26: `meta.json`, 9 bytes -> chksum `011006\0 `,
size `00000000011\0`.

PAX path records. Go switches to a PAX header for a name that does not
fit ustar: longer than 100 bytes with no `/` split that fits the
`prefix` field (run files are flat, so there is never a `/`), or
containing non-ASCII bytes. Roast's own artifact names never trigger
this, but a user can drop such a file into a run directory, and the build
must still succeed. The TS writer emits, immediately before the file's
own header block:

1. A PAX extended header entry: a 512-byte header with typeflag `x`
   (0x78), name `<dir>/PaxHeaders.0/<base>` (Go's `path.Join(dir,
   "PaxHeaders.0", base)`; for flat run files `<dir>` is empty, giving
   `PaxHeaders.0/<base>`), ASCII-only and truncated to 100 bytes, mode
   `0000000\0`, uid/gid/mtime zero, size = byte length of the records
   block (octal, as in every size field), magic `ustar\0` version `00`,
   then the records block zero-padded to a multiple of 512. Verified
   against Go 1.26 `archive/tar` on 2026-11-18 (long-name case).
2. The records block: one record, `<len> path=<name>\n`, where `<name>`
   is the full UTF-8 name and `<len>` is the decimal byte length of the
   whole record including the length digits and the newline (compute by
   fixed-point: start from `digits(len(rest)) + len(rest)` and adjust
   until stable).
3. The file's own header as in the table, with the name field holding
   the name truncated to 100 bytes (non-ASCII bytes dropped, matching
   Go's ASCII fallback), then the data and padding as usual.

Match Go's `archive/tar` for these headers as closely as practical; a
fixture captured from Go for one long name and one non-ASCII name is the
reference, and any divergence is documented next to the fixture. The
reader accepts the result regardless (below). A size of 8 GiB or more
(Go would add a PAX `size` record) still throws: the archive is built in
memory and such a file cannot be read.

#### Compression

- Go uses `klauspost/compress/zstd` with default options (single frame,
  default speed level, content checksum on). The TS port uses
  `zlib.zstdCompressSync(tar, { params: {
  [ZSTD_c_compressionLevel]: 3, [ZSTD_c_checksumFlag]: 1 } })`.
- Node 22.15+ marks `zlib.zstd*` experimental, and first use may print an
  `ExperimentalWarning` to stderr. Suppress that one warning only (spec.md
  "Runtime"), not warnings in general. The same applies to decompression
  in `verifyBundle`.
- The compressed bytes will differ from Go's (spec.md "Out of Scope"), so
  `bundle.tar.zst` digests differ between implementations. Required: (a) the
  decompressed tar is byte-identical to Go's for identical run files,
  (b) the TS output is deterministic: same run files -> same bundle
  bytes regardless of run directory path, file mtimes, owner, or file
  modes, (c) TS can verify bundles written by Go and vice versa.

### 2.13 Verify (`verifyBundle(path)`)

Validates format version, flat regular-file layout, and every manifest
size and digest; returns the manifest.

1. Open the file (raw error returned). Decompress zstd (error
   `open zstd stream: <err>` or, for a corrupt stream, `read tar: <err>`).
2. Read tar entries until the end-of-archive marker. Header or framing
   errors -> `read tar: <err>`. The reader must validate the header
   checksum (accept either the unsigned or signed byte sum, as Go does)
   and, when the ustar magic is present and `prefix` is non-empty, use
   `prefix + "/" + name` as the entry name. Supported header types are
   ustar plus PAX: an `x` entry (and a global `g` entry, whose records
   are ignored apart from consuming its data) is parsed as `<len> key=value`
   records, and a `path` record overrides the name of the next entry.
   A record with a bad length, a missing `=` or newline, or a length
   past the block is a `read tar: <err>` error. GNU long-name (`L`, `K`)
   headers are not required: they are rejected as non-regular entries
   by the typeflag check below.
3. For each entry:
   - typeflag must be `0` or NUL (legacy regular file), else
     `bundle entry "<name>" is not a regular file`;
   - name must be a valid name (2.2), else
     `bundle entry "<name>" is not a flat path`;
   - a name already seen, or a second manifest entry ->
     `bundle contains duplicate entry "<name>"`;
   - the manifest entry: header size over 1 MiB ->
     `bundle manifest is larger than 1048576 bytes`; otherwise read it
     (error `read bundle manifest: <err>`);
   - any other entry: SHA-256 and byte count of its data (error
     `read bundle entry <name>: <err>`).
4. No manifest -> `bundle has no bundle-manifest.json`.
5. Parse the manifest strictly: keys match exactly (case-sensitive, so
   `"Format"` is an unknown key; deliberate change 7), unknown keys
   rejected, exactly one JSON value (trailing data ->
   `parse bundle manifest: trailing JSON data`), types `format:string`,
   `version:integer`, `files:array|null` of
   `{path:string, sha256:string, size:integer}`. Errors
   `parse bundle manifest: <err>`.
6. `format != "roast-run-bundle"` -> `unsupported bundle format "<f>"`.
   `version != 1` -> `unsupported bundle version <v>`.
7. `files.length !=` number of non-manifest entries ->
   `bundle manifest lists <m> files but archive contains <n>`.
8. For each manifest entry in order:
   - path empty, not a basename, or equal to `bundle-manifest.json` ->
     `bundle manifest contains invalid path "<p>"`;
   - not strictly greater (bytewise) than the previous path ->
     `bundle manifest paths are not strictly sorted`;
   - `sha256` not 64 lowercase hex chars ->
     `bundle manifest has invalid sha256 for <p>`;
   - not in the archive -> `bundle manifest entry <p> is missing from
     archive`;
   - size mismatch -> `bundle entry <p> size is <actual>, manifest says
     <expected>`;
   - digest mismatch -> `bundle entry <p> digest does not match
     manifest`.
9. Return the manifest.

Archive entry order is not checked; only the manifest's path order is.

### 2.14 `roast runs`

```
roast runs [--limit N] [--json]
```

- No positional arguments; any argument (including unknown subcommands
  such as `runs sync` or `runs status`) is a usage error, exit 2.
- `--limit` integer, default `20`. `<= 0` means no limit.
- `--json` boolean, default false.
- Subcommands: `show`, `checkout`, `prune` (the last two: snapshot area).

Behavior:

1. Records directory `""` -> usage error (exit 2) with message
   `cannot resolve record directory: run inside a Git repository`.
2. Glob `<dir>/runs-*.jsonl` (errors ignored, missing directory = no
   files), sort bytewise ascending (chronological).
3. Read every file in order; skip files that fail to open. Split into
   lines like Go's `bufio.Scanner` with `ScanLines`: split on `\n`, strip
   one trailing `\r`, a final unterminated line counts, no line for a
   trailing `\n`. A line longer than 16 MiB stops reading that file (lines
   already read are kept, the rest of the file is dropped silently). Empty
   lines are kept.
4. If `limit > 0` and there are more lines than `limit`, keep the last
   `limit` lines (across all files).
5. No lines -> write `roast: no run records in <dir>\n` to stderr, exit 0,
   nothing on stdout.
6. `--json`: write each kept line verbatim plus `\n` to stdout (including
   empty or unparseable lines).
7. Otherwise, for each kept line, parse JSON leniently (missing keys are
   zero values); skip lines that fail to parse. Print one line per run,
   Go format string:

   ```
   "%s  %-25s %-8s q=%-5v %-30s findings=%d refuted=%d files=%d  %s\n"
   ```

   with arguments `ts`, `run_id`, `mode`, `quick` (`true`/`false`),
   `assessment`, `n_findings`, `n_refuted`, length of `files_reviewed`
   (0 when null), `repo`. `%-Ns` pads on the right with spaces to N
   characters counted in Unicode code points (Go counts runes) and never
   truncates.
8. Exit 0.

### 2.15 `roast runs show <run-id>`

- Exactly one argument, else usage error (exit 2).
- Resolve `reportPath(id)` (2.10); errors are plain errors (exit 4).
- Read `report.md`; failure -> `run has no report artifact: <err>`
  (exit 4).
- Write `textsafe.text(content)` to stdout with nothing appended (control
  bytes escaped visibly, text sanitization area). Exit 0.

### 2.16 Permissions summary

| Path | Mode | When enforced |
|---|---|---|
| `.roast/` | `0o700` | creation only |
| `.roast/.gitignore` | `0o644` | only when `.roast` is created |
| `.roast/runs/` | `0o700` | creation; chmod on every run-dir write |
| `.roast/runs/<id>/` | `0o700` | creation; chmod on write and bundle build |
| each run-dir file, incl. tmp | `0o600` | fchmod on every open for write |
| `bundle.tar.zst` | `0o600` | on build; chmod when reused |
| `runs-YYYY-MM.jsonl` | `0o600` | fchmod on every append |

The Git toplevel's own mode is never changed.

## 3. TypeScript module design

All filesystem work in this area may use synchronous `node:fs` calls:
files are small, and sync appends make the response recorder's ordering
trivial. The records directory is resolved once per command and passed
in.

`src/record/dir.ts`

```ts
export const STATE_DIR = '.roast'
export function recordDir(cwd:string):Promise<string>  // '' outside repo
export function ensureDir(dir:string):void
export function makeRunDir(dir:string, runId:string):string
export function isValidName(name:string):boolean
export function openPrivate(path:string, flags:number):number  // fd
export function writePrivate(path:string, data:Uint8Array|string):void
export class NoRecordDirError extends Error {}
```

`recordDir` runs `git rev-parse --show-toplevel` through the shared git
exec helper (git area) with `cwd`.

`src/record/run-id.ts`

```ts
export function newRunId(now?:Date):string
```

`src/record/json.ts`

```ts
export function goStringify(value:unknown, indent?:number):string
export function compactJSON(text:string):string
export function rfc3339NanoUTC(d:Date):string
export function rfc3339Local(d:Date):string
export function compareBytes(a:string, b:string):number
```

`src/record/meta.ts`

```ts
export interface Meta { run_id:string; replay_of?:string; ts:string;
    repo:string; invoke_dir?:string; argv?:string[]; roast:BuildMeta;
    scope:ScopeMeta; derived:DerivedMeta;
    roles:Record<string, RoleMeta>; snapshot:SnapshotMeta;
    digests:DigestMeta; budgets?:Record<string, unknown>;
    usage?:Record<string, UsageMeta>; env_names_only?:string[];
    caveats?:string[] }
// BuildMeta, ScopeMeta, DerivedMeta, RoleMeta, SnapshotMeta,
// DigestMeta, UsageMeta as in 2.4
export function serializeMeta(meta:Meta):string  // key order + omits
export function writeMeta(dir:string, meta:Meta):string
export function readMeta(dir:string, id:string)
    :{ meta:Meta; runDir:string }
export function wireProtocol(role:RoleMeta):string
export function resolveRunDir(dir:string, id:string):string
export function reportPath(dir:string, id:string):string
export function removeRun(dir:string, runId:string):void
export function writeArtifact(dir:string, runId:string, name:string,
    content:string|Uint8Array):string
export function readArtifact(runDir:string, name:string):string
export function writeReport(dir:string, runId:string,
    markdown:string):string
export function captureEnv(env:NodeJS.ProcessEnv,
    extraSecrets:string[]):string[]
export function digest(x:string|Uint8Array):string
```

`serializeMeta` builds a plain object in the documented key order,
dropping omit-when-empty keys and sorting map keys, then
`goStringify(obj, 2) + '\n'`. Same pattern for the index line.

`src/record/responses.ts`

```ts
export const PROVIDER_RESPONSES_FILE = 'provider-responses.jsonl'
export class ResponseRecorder {
    constructor(dir:string, runId:string)
    append(role:string, protocol:string, model:string,
        contentType:string, body:Uint8Array):void  // throws
}
```

UTF-8 validity check: `new TextDecoder('utf-8', { fatal: true })`.

`src/record/findings.ts`

```ts
export function openFindingSpill(dir:string, runId:string)
    :((wf:WireFinding) => void)|null
```

`src/record/index-file.ts` (monthly JSONL index)

```ts
export function appendRunLine(dir:string, report:Report, repo:string,
    argv:string[]|null, now?:Date):void
export interface PriorSighting { runTS:string; dropReason:string }
export function seenBefore(dir:string, repoDir:string,
    findings:Finding[], lookbackFiles:number)
    :Map<string, PriorSighting>
```

`src/runbundle/tar.ts`

```ts
export interface TarFile { name:string; data:Uint8Array }
export function writeTar(files:TarFile[]):Uint8Array
export interface TarEntry { name:string; typeflag:string;
    size:number; data:Uint8Array }
export function readTar(archive:Uint8Array):TarEntry[]  // throws
```

`src/runbundle/bundle.ts`

```ts
export const BUNDLE_FILE = 'bundle.tar.zst'
export const MANIFEST_FILE = 'bundle-manifest.json'
export const FORMAT = 'roast-run-bundle'
export const VERSION = 1
export interface ManifestEntry { path:string; sha256:string;
    size:number }
export interface Manifest { format:string; version:number;
    files:ManifestEntry[]|null }
export class BundleBuildInProgressError extends Error {}
export function buildBundle(runDir:string)
    :{ path:string; sha256:string; size:number }
export function verifyBundle(path:string):Manifest
```

The manifest is validated with a strict `zod` schema
(`z.object({...}).strict()`, integer checks).

`src/cli/runs.ts`: registers `runs` (with `--limit`, `--json`) and
`runs show`; `checkout` and `prune` are added by the snapshot area's
module. Uses `recordDir`, `reportPath`, and `textsafe.text`.

Dependencies: git exec helper (git area), `review` types and
`fingerprint` and `DropRefutedByVerifier` (review area), `Report` type
and `toJSON` / `toMarkdown` (render area), `textsafe` (sanitization
area), usage-error type and exit codes (CLI area), the Go-duration
formatter (CLI area). The review command (CLI area) orchestrates the
write order in 2.3.

The best-effort Go wrappers `WriteReport`, `WriteMeta`, `WriteArtifact`
(fixture helpers only) need not be ported; the TS port has only the
checked forms plus the inherently best-effort `appendRunLine` and
finding spill.

## 4. Deliberate changes

None of the listed deliberate changes alter this area's formats. Related
notes:

- Deliberate change 11 applies here: run IDs and artifact names must be
  plain names, so `.` and `..` are rejected (2.2).
- Deliberate change 7 applies to bundle manifests: keys match exactly,
  case-sensitively (2.13).
- Kept as in Go, on purpose: the monthly index keeps the oldest sighting
  within a month (2.9), index timestamps are local time while `meta.ts`
  is UTC (2.11).
- Tar archives support PAX path records on write and read (2.12, 2.13),
  as the cross-cutting "Runtime" rule says; GNU long names are not read.

- Debug tracing (`roast:records`, `roast:runbundle`) may log paths, run
  IDs, sizes, and digests, never file contents, prompts, or provider
  bodies.
- Windows is unsupported, so permission behavior is always enforced (Go
  skipped permission tests on Windows).
- Implementation differences that are not behavior changes: `.gz` and
  `bundle.tar.zst` bytes differ from Go's (different compressors), while
  their decompressed contents match (2.6, 2.12).

## 5. Test plan

Seams: CLI in-process (`run(argv, io)` against the `node:http` fake
inference server) where noted; otherwise the module seam, justified
because bundle bytes, permission tightening of pre-existing files, and
tamper detection are not reachable through the CLI at reasonable cost.
Every test that writes records first chdirs (sets `cwd`) into a fresh
temp Git repository. No assertions on human-readable text.

Records location and lifecycle (CLI seam)

- A review run from a subdirectory with the config in a subdirectory
  writes records under `<toplevel>/.roast/runs`, ignoring
  `ROAST_RECORD_DIR` (TestRunRecordsLiveUnderProjectToplevel).
- End-to-end run: `result.json.gz` exists; the bundle verifies with
  format/version identity; `provider-responses.jsonl` has one line per
  model call (finder + verifier = 2) and is listed in the manifest;
  `meta.json` budgets carry `deadline_duration:"0s"`,
  `request_timeout:"0s"`, `max_total_tokens:0`, `verifier_cap:0`,
  `max_attempts:1` for those flags; finder role records profile,
  protocol, session header, no `api`; `runs show <id>` exits 0 with
  non-empty output; `runs` output contains the run ID
  (TestFinderVerifierPipelineWithMockEndpoint).
- Settings tests read `meta.json` via a `reviewMeta` helper
  (settings_test.go) -- port the helper.

Permissions (module seam)

- Each of `meta.json`, `input.gz`, `report.md`,
  `provider-responses.jsonl`, `findings.jsonl`, whether new or
  pre-existing at `0o644` (also a pre-existing `.tmp`), ends `0o600`; run
  dir and `runs/` end `0o700`; the toplevel stays `0o755`
  (TestPrivateRecordPermissions).
- Monthly index file is `0o600` and re-tightened from `0o644` on the
  next append (TestPrivateMonthlyRecordPermissions).
- Bundle: run dir `0o700`, bundle `0o600`, every tar entry mode `0600`
  (TestBuildPrivatePermissions); lock file `0o600`
  (TestBundleLockPrivatePermissions).

Meta and artifacts (module seam)

- Meta round-trips through write/read; artifacts round-trip through
  gzip; nothing secret is written (TestMetaAndArtifactsRoundTripWithoutSecrets).
- `captureEnv` records names only, excludes `*_API_KEY` and the
  configured credential variable names
  (TestCaptureEnvRecordsNamesOnly,
  TestCaptureEnvRedactsConfiguredCredentialSource).
- A meta with only legacy `api` reports it as the wire protocol
  (TestRoleMetaReadsLegacyAPIField).

Provider responses (module seam)

- Concurrent appends produce unique, gap-free sequence numbers and one
  valid JSON object per line
  (TestResponseRecorderSerializesConcurrentResponses).
- An event-stream body is stored as a JSON string equal to the raw
  stream (TestResponseRecorderPreservesNativeEventStream).
- Add: JSON body compaction preserves number literals (e.g.
  `1.0`, `12345678901234567890`) exactly.

Index and prior sightings (module seam)

- Writes one parseable line with the documented fields; prompt packs;
  every finding carries `fingerprint`; filename is
  `runs-<local YYYY-MM>.jsonl`; repeated calls append; outside a Git
  repository nothing is written and nothing throws
  (TestRecord_WritesJSONL, TestRecord_PromptPacks,
  TestRecord_FingerprintInFindings, TestRecord_MonthlyFilename,
  TestRecord_Appends, TestRecord_SwallowsError_NoDir).
- `seenBefore`: match, no match, other repo filtered, lookback limits
  the number of monthly files, empty dir, dropped findings scanned with
  drop reason, newest month wins (TestSeenBefore_Match,
  TestSeenBefore_NoMatch, TestSeenBefore_CrossRepoFiltered,
  TestSeenBefore_RespectsLookbackFiles, TestSeenBefore_EmptyDir,
  TestSeenBefore_DroppedFindingsScanned,
  TestSeenBefore_NewestSightingWins).
- Add: two lines in one monthly file with the same fingerprint -> the
  earlier line's `ts` is returned (oldest wins within a month); the same
  fingerprint in two months -> the newer month's line wins.

Run IDs and reports

- `isValidName` rejects `""`, `.`, `..`, and names containing `/`;
  accepts plain names. `makeRunDir`, `writeArtifact`, `readArtifact`,
  `readMeta`, and `resolveRunDir` reject `..` and `a/b` without touching
  the filesystem; `removeRun("..")` throws and `.roast/` is intact.
  `runs show ..` exits 4 with `invalid run id`.
- Run ID shape (25 chars, `-` at 16) and two consecutive IDs differ
  (TestNewRunID_Shape, module seam).
- Report write then `runs show` round trip (TestWriteReport_ShowRoundTrip).
- `runs show` escapes control bytes in stored reports: output contains
  no ESC/BEL/C1 bytes (TestRunsShowEscapesStoredReports, CLI seam;
  assert on absence of control bytes only).

Bundle (module seam)

- Two run dirs with identical files but different paths and mtimes
  produce identical bundle digest and size; manifest lists files in
  sorted order (TestBuildIsDeterministicAcrossDirectoriesAndTimestamps).
- An existing bundle is reused byte-for-byte
  (TestBuildReusesExistingBundle).
- A symlinked bundle path or symlinked artifact is rejected
  (TestBuildRejectsSymlinkedBundle, TestBuildRejectsSymlinkedArtifact).
- A manifest digest mismatch fails verification
  (TestVerifyRejectsManifestDigestMismatch).
- An entry with typeflag NUL verifies
  (TestVerifyAcceptsLegacyNULRegularFileType).
- An invalid existing bundle makes build fail
  (TestBuildRejectsInvalidExistingBundle).
- Add: a run directory containing a file with a 150-byte name and one
  with a non-ASCII name builds without throwing; the decompressed tar has
  `x` entries with correct `path` record lengths; `readTar` returns the
  full names; the bundle verifies. A hand-built PAX archive with a bad
  record length fails verification. A GNU `L` entry fails verification.
- Add: a manifest with key `"Format"` (wrong case) fails verification.
- Add: the digest of a diff containing invalid UTF-8 bytes equals the
  SHA-256 of the raw bytes, and `input.gz` decompresses to the raw bytes.
- Add: first bundle build in a fresh process writes no
  `ExperimentalWarning` to stderr (assert on the warning name only).
- Add: `writeTar` output for `meta.json` = `"metadata\n"` is 2048 bytes
  with the exact header bytes in 2.12 (fixture captured from Go); a
  bundle written by Go (checked-in fixture) verifies in TS.

`runs` command (CLI seam)

- `runs` in a repository with no records exits 0
  (TestRunsLocalSubcommandsStillWork).
- `runs sync` / `runs status` exit 2 (TestRunsUploadSubcommandsAreUnknown).
- `runs show` with zero or two arguments exits 2
  (TestCommandUsageErrorsExitWithUsageCode).
- `runs` outside a Git repository exits 2.
- Add: `--json --limit 2` prints exactly the last two raw lines across
  two monthly files.

Differential harness: compare `meta.json`, decompressed `.gz` artifacts,
`provider-responses.jsonl`, `findings.jsonl` (ignoring `ts`), index lines
(ignoring `ts`), and the decompressed bundle tar's entry list and
manifest, after normalizing run IDs, timestamps, and digests that
include them.

## 6. Go baseline references

At commit `cd08f10`:

- `internal/record/record.go` -- DefaultDir, run ID, report, finding
  spill, monthly index, SeenBefore.
- `internal/record/meta.go` -- Meta shape, RunDir, meta/artifact
  read/write, RemoveRun, CaptureEnv, Digest.
- `internal/record/files.go` -- StateDir, ensureDir, makeRunDir, private
  file helpers.
- `internal/record/responses.go` -- ResponseRecorder.
- `internal/runbundle/bundle.go` -- Build, lock, tar/zstd, Verify.
- `internal/cli/runs.go` -- `runs`, `runs show` (checkout/prune belong to
  the snapshot area).
- `internal/cli/cli.go` -- run ID minting, meta construction,
  `initializeRunArtifacts`, `finalizeRunArtifacts`, `priorNotes`,
  budgets map, `exitCode`.
- `internal/llm/provider.go` -- `maxCapturedResponseSize` (16 MiB).
- Tests: `internal/record/{record,meta,files,responses}_test.go`,
  `internal/runbundle/bundle_test.go`, `internal/cli/records_test.go`,
  `internal/cli/cli_test.go` (TestFinderVerifierPipelineWithMockEndpoint,
  TestRunsUploadSubcommandsAreUnknown,
  TestRunsLocalSubcommandsStillWork,
  TestCommandUsageErrorsExitWithUsageCode),
  `internal/cli/hardening_test.go` (TestRunsShowEscapesStoredReports).

## 7. Resolved

1. Monthly index: the oldest sighting wins within a month, Go's behavior
   kept; the Go comment is wrong (spec.md "Further Notes").
2. Run IDs must be plain names; `.`, `..`, and separators are rejected
   (spec.md deliberate change 11).
3. The tar writer emits PAX `path` records for long or non-ASCII names
   instead of throwing (spec.md "Cross-cutting rules", Runtime).
4. The tar reader supports ustar plus PAX path records; GNU long names
   are not required (spec.md "Cross-cutting rules", Runtime).
5. Manifest keys match exactly, case-sensitive (spec.md deliberate
   change 7).
6. Diff bytes stay `Buffer` where hashed or recorded so digests match Go
   (spec.md "Bytes and text").
7. Only the `node:zlib` zstd ExperimentalWarning is suppressed (spec.md
   "Runtime"); compressed bytes may differ from Go (spec.md "Out of
   Scope").
8. Index timestamps are local time and `meta.json` is UTC: Go parity,
   kept (spec.md "Further Notes").
