# MISSION

We are porting the `roast` CLI from Go to TypeScript. The Go code
(`cmd/roast`, `internal/`) is the reference behavior; the TypeScript
lives in `src/`, `test/`, and `scripts/`.

Each session has exactly one task, given under `# THIS SESSION` at the
end of this prompt with its full acceptance criteria. The session ends
when that task is committed with `passes: true`, or when you wrap up
with a WIP commit and a progress note.

# STEPS

1. Orient. Read `AGENTS.md`, `docs/agents/typescript.md`, and the
   `## Codebase Patterns` section at the top of `progress.log`. If
   `# THIS SESSION` shows uncommitted changes or typecheck errors, they
   are an earlier session's unfinished work: read them and continue
   from them. Done when you can name the files you will write.
2. Read the task's sources: the issue and spec files its criteria name,
   and the Go code it ports (usually `internal/<area>/*.go` and its
   `_test.go`). Done when you know which Go function and which Go test
   case covers each acceptance criterion.
3. Port the tests. Translate the Go test cases into a tapzero module at
   `test/<area>/<name>.ts`, import it from `test/index.ts`, and run it:
   `npm run test:one -- test/<area>/<name>.ts`. Done when it runs red.
4. Port the code until that module is green. After each edit run
   `npm run typecheck` (`test:one` does not typecheck). Each time
   typecheck is clean, make a WIP commit:
   `git commit -m "WIP: [ID] - <what this step did>"`.
5. Gate. Run `npm run lint`, `npm test`, and `npm run test:go`. Done
   when all three are green and every acceptance criterion holds.
6. Finish. Append a `progress.log` entry (format below), set
   `passes: true` for your task's ID in `specs/prd.json`, and commit
   everything as `FEATURE: [ID] - <description>`. Then stop.

# SCOPE

Your task's files are the paths its criteria name plus the tests you
write for them. Paths listed under `Reserved for later tasks` belong to
other tasks; when your code needs one, write the smallest stub your
task needs and record it in `progress.log`.

Your task is fully described under `# THIS SESSION`. In
`specs/prd.json`, the only edit is your own task's `passes` flag.

# HONEST GREEN

Green means the real tests pass. Every test you write checks real
behavior, and existing tests stay as they are. If the task cannot be
finished honestly this session, leave `passes: false` and wrap up.

After the session, the loop reruns lint, `npm test`, and
`npm run test:go`. If any fails, it sets `passes` back to false.

# WRAP-UP

When the loop tells you to wrap up, or you are stuck after two
different approaches, stop new work and:

1. Make `npm run typecheck` clean, reverting your own broken edits if
   needed.
2. Append a `progress.log` entry saying what works, what is left, and
   what blocked you.
3. Make a WIP commit, leave `passes: false`, and stop.

# PROGRESS LOG

Append to `progress.log`, never replace:

```
## [Date/Time] - [Task ID]
- What was implemented
- Files changed
- Learnings for future sessions (patterns, gotchas, where things live)
---
```

When a learning applies beyond this task, also add one line for it to
the `## Codebase Patterns` section at the top of `progress.log` (create
the section if it is missing).
