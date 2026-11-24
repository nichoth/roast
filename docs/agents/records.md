# Run records

`src/record/` (its own notes: `src/record/AGENTS.md`),
`src/cli/runs.ts`, `src/cli/ignore.ts`.

- `recordDir` is `.roast/runs` at the Git toplevel of the working
  directory (empty outside a repository); there is no env override. Run
  directories are `<dir>/<run-id>/`; the monthly JSONL index is
  `<dir>/runs-YYYY-MM.jsonl`.
- A test that writes or reads records chdirs into a temporary Git
  repository first (`recordRepo`, `test/record/repo.ts`).
- `roast ignore` (`ensureStateIgnored`) owns the toplevel `/.roast/`
  entry; reuse it rather than writing `.gitignore` again.
- `runs` lists the monthly index; `runsSubcommands` is the array the
  snapshot area appends `checkout` and `prune` to. Run IDs go through
  `reportPath` / `resolveRunDir`, which own the plain-name check, so
  CLI code never joins an ID into a path itself.
- CLI tests fabricate records with `writeReport` and raw writes to
  `.roast/runs/runs-YYYY-MM.jsonl` inside `recordRepo`; no review needed.
