# Run records

- Resolve the records directory once with `recordDir(cwd, { env })` and
  pass it into record operations. An empty directory means recording is
  unavailable; checked writes throw `NoRecordDirError`, while the index
  and finding spill remain best effort. Filesystem APIs are asynchronous.
- Validate run IDs and artifact names before any filesystem operation.
  `makeRunDir` tightens both private directories on each write;
  `openPrivate` tightens file descriptors, including existing files.
- `meta-types.ts`, ordered field lists in `meta-json.ts`, and decoding in
  `meta-read.ts` must change together when the metadata contract changes.
  Optional fields serialize with Go omitempty behavior. Readers ignore
  unknown exact-case keys and provide zero values for absent/null fields.
- Metadata uses the specified fixed `meta.json.tmp` staging path and
  rename. Tighten a leftover staging file before publishing it. The
  general fsutil atomic helper uses random exclusive temporary files,
  so it does not provide this legacy staging-file behavior.
- Diff input stays bytes through hashing and gzip. Provider JSON body
  compaction is textual; parsing and re-encoding loses numeric spellings
  and duplicate keys. JSON escaping follows the spec index.
- Map keys sort with `compareBytes`. Preserve struct field order instead
  of recursively sorting whole metadata or finding objects. The monthly
  index uses local timestamps; metadata and finding spill use UTC.
- Await recorder and spill writes. Their per-instance queues serialize
  concurrent appends; response appends also fsync before returning.
- Record tests use `test/record/repo.ts` to chdir into a temporary Git
  repository and isolate home/config directories. Never write this
  checkout's self-ignored `.roast/`. Import tests in `test/record/index.ts`,
  which is imported by `test/index.ts`.
