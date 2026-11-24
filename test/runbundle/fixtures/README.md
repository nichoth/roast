These binary fixtures come from Go's archive/tar and the Go runbundle
implementation at the baseline commit cd08f10. They are frozen: the Go
program that captured them (test/runbundle/fixtures/capture.go, added in
89976e7) was deleted with the Go tree at the M6 cutover and only runs
against a checkout of that era.

meta.tar contains meta.json = "metadata\n". long.tar contains a 150-byte
ASCII name and "long content". unicode.tar contains caf\u00e9.txt and
"non-ascii\n". go-bundle.tar.zst contains meta.json = "metadata\n" and
the baseline-generated manifest. Full tar bytes match; no divergence is
allowed by these fixtures. Compressed bytes need not match Node's output.
