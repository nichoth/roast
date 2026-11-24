# 19: Run bundles

**Blocked by:** 18
**Touches:** `src/runbundle/tar.ts` (`TarFile`, `writeTar`, `TarEntry`,
`readTar`), `src/runbundle/bundle.ts` (`BUNDLE_FILE`, `MANIFEST_FILE`,
`FORMAT`, `VERSION`, `ManifestEntry`, `Manifest`,
`BundleBuildInProgressError`, `buildBundle`, `verifyBundle`),
`test/runbundle/` (including a Go-built bundle fixture and tar header
fixtures captured from the Go baseline), `test/index.ts`
**Spec:** `spec/10-records.md` 2.12-2.13, 2.16, 3 (`src/runbundle/`), 4,
5 ("Permissions" bundle items, "Bundle"); `spec.md` "Deliberate changes"
7, "Cross-cutting rules" (Runtime: zstd warning, PAX records), "Out of
Scope" (byte-identical compressed output)
**Status:** done

## What to build

`bundle.tar.zst`: a deterministic, verifiable archive of a run directory.

`writeTar` is an in-house ustar writer whose uncompressed output is
byte-identical to Go `archive/tar` for the same inputs: fixed header
fields (mode `0600`, zero uid/gid/mtime, `ustar\0` + `00`), the checksum
rule of 2.12, data padded to 512, two zero blocks, and no padding to a
10240 record. Names that do not fit ustar (over 100 bytes or non-ASCII)
get a PAX `x` entry `PaxHeaders.0/<base>` carrying a self-length `path`
record before the file's own header, as in 2.12. A file of 8 GiB or more
throws.

`readTar` validates checksums (unsigned or signed sum), applies a
non-empty ustar `prefix`, parses PAX `x` (and consumes `g`) records with
strict length checks, and lets a `path` record override the next entry's
name. GNU long-name entries are not supported and fail later as
non-regular.

`buildBundle(runDir)` follows 2.12: protect the run dir, reuse and verify
an existing regular-file bundle byte for byte, otherwise take the
`bundle.tar.zst.tmp` lock (stale after 10 minutes,
`BundleBuildInProgressError` otherwise), collect regular files in
bytewise order (skipping directories, the bundle, `.tmp` names; rejecting
symlinks, non-regular files, files that change identity mid-read, and a
stray `bundle-manifest.json`), embed the manifest, compress with
`node:zlib` zstd (level 3, checksum on), rename into place, verify, and
hash. The zstd `ExperimentalWarning` is suppressed by the startup filter
from ticket 01; this ticket ensures library use outside the CLI entry
(tests) also emits none.

`verifyBundle(path)` follows 2.13 exactly, including a strict manifest
parse with case-sensitive keys (deliberate change 7), unknown keys and
trailing data rejected, integer types, sorted paths, digest and size
checks.

Wiring the bundle into `review` finalization is ticket 20; `runs` and
`runs show` are ticket 23.

## Acceptance criteria

- [x] `writeTar([{name:'meta.json', data:'metadata\n'}])` is 2048 bytes
  and its header bytes equal the Go-captured fixture (checksum
  `011006\0 `, size `00000000011\0`).
- [x] Two run directories with identical files but different paths,
  mtimes, and modes produce identical bundle bytes, digest, and size, and
  the manifest lists files in bytewise sorted order.
- [x] An existing valid bundle is reused byte for byte without
  rebuilding.
- [x] A symlinked bundle path and a symlinked artifact are rejected; an
  invalid existing bundle makes the build fail.
- [x] After a build the run dir is `0o700`, the bundle `0o600`, every tar
  entry mode is `0600`, and the lock file while held is `0o600`.
- [x] A fresh lock younger than 10 minutes yields
  `BundleBuildInProgressError`; a stale lock is reclaimed and the build
  succeeds.
- [x] A run directory with a 150-byte file name and a non-ASCII file name
  builds; the decompressed tar has `x` entries with correct `path` record
  lengths; `readTar` returns the full names; the bundle verifies; the tar
  bytes match Go-captured fixtures for one long and one non-ASCII name
  (or any divergence is documented next to the fixture).
- [x] A bundle written by the Go baseline (checked-in fixture) verifies
  in TS.
- [x] Verification fails on a manifest digest mismatch, a hand-built PAX
  archive with a bad record length, a GNU `L` entry, and a manifest key
  `"Format"`; it accepts an entry with typeflag NUL.
- [x] Building and verifying a bundle in a fresh process writes no
  `ExperimentalWarning` to stderr (asserted on the warning name only).
- [x] `npm run lint`, `npm run typecheck`, and the TS test suite pass,
  and the Go build and Go tests still pass.
