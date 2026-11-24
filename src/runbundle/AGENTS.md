# Run bundles

- Tar headers and PAX records must match Go archive/tar byte for byte.
  Full Go-captured fixtures live under `test/runbundle/fixtures/`; they
  are frozen (see its README). PAX auxiliary headers have mode zero and
  zero-filled device fields; regular headers use mode 0600 and octal
  device fields. Readers consume extension headers, so inspect raw tar
  blocks when testing extension types or modes.
- Keep bytes through compression and hashing. Bind artifact reads to an
  opened regular descriptor and compare device/inode before reading.
  The fixed `.tmp` file is both the exclusive lock and staging file;
  reopening it must not create a replacement if it disappears.
- The manifest is strict at both object levels. Integer spellings need
  JSON.parse source context, and null fields retain Go zero semantics.
  Use Map for archive inventories so object-property names remain valid.
- Standalone bundle use must install the narrow startup warning filter
  before calling zstd; do not suppress unrelated warnings.
- Focused tests: `npm run test:one -- test/runbundle/index.ts`.
  The aggregate is registered in `test/index.ts`. Tests that build bundles
  use recordRepo to chdir and isolate project state. Fresh-process tests
  load esbuild via createRequire, use baseOptions and the require banner.
  Check TAP totals as well as process exit status.
