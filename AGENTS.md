## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout. See `docs/agents/domain.md`.

## Layout

Roast is one TypeScript package (ADR-0004): the CLI in `src/`, its
tests in `test/`, Node-run tooling in `scripts/`. The CI gate, in order:
`npm run lint`, `npm run typecheck`, `npm test` (builds `dist/cli.js`,
then runs the test bundle; it does not typecheck),
`git diff --exit-code -- roast.schema.json`, `npm run check:pack`.

## Area notes

Before editing code in an area, read its notes.

- Any code in `src/`, `test/`, or `scripts/`: `docs/agents/typescript.md`
- Config loading, roles, providers, the `init` starter,
  `roast.schema.json` (`src/config/`): `docs/agents/config.md`
- Trust and approvals (`src/trust/`, `*/trust.ts`):
  `docs/agents/trust.md`
- Stored credentials, `login`, `logout` (`src/credentials/`,
  `src/cli/*login*`, `src/cli/logout.ts`): `docs/agents/auth.md`
- Gate and the pre-commit hook (`src/gate/`): `docs/agents/gate.md`
- Agent skill install (`src/skill/`): `docs/agents/skill.md`
- Run records, `runs`, `ignore` (`src/record/`, `src/cli/runs.ts`):
  `docs/agents/records.md`
- Scope, context, exploration tools, snapshot denylist (`src/scope/`,
  `src/context/`, `src/snapshot/`): `docs/agents/scope-context.md`
- LLM adapters and the agent loop (`src/llm/`): `docs/agents/llm.md`
- The bundle, third-party notices, `check:pack`, release
  (`scripts/`, `package.json`): `docs/agents/packaging.md`

A new note goes in its area's file; a new area gets a file and a line
here. This file holds only what most tasks hit.

## Traps every task hits

- `JSON.parse` syntax errors can quote the input. Credential-file parse
  errors must use value-free messages so diagnostic output cannot expose
  a stored key.
- Shell hooks block Bash commands that contain a heredoc mentioning
  `process.env.PATH`, a heredoc or command containing `env:` or `.env`
  text, or a `credentials*` path together with `cat`, `sed`, `head`, and
  the like. Read and write such files with the editor tools.
- Tests that write project state (run records, trust, stored
  credentials) chdir into a temporary Git repository first. `.roast/`
  ignores itself, so a leak into this checkout is invisible to
  `git status`; check with `ls -a`.
- CLI diagnostic tests that resolve roles need valid test credentials
  and local fake-server routing, even when asserting only local checks.
  Doctor fakes must route GET models checks and POST inference separately;
  a successful chat probe needs a lookup call followed by a final call
  that echoes the token from the replayed tool result.
- The CLI parser preserves dashed option names and disables boolean
  negation. Declare flags such as `no-browser` explicitly and read
  `args['no-browser']`, rather than a camel-case property.
- `simulateTerminals` only bypasses interactive-terminal detection. To
  exercise raw-mode prompt input through the CLI, give stdin an `isTTY`
  value of `true` and a `setRawMode` function; assert raw mode is restored.
- Browser-login tests send callbacks with the real fetch; the injected
  provider fetch rewrites every origin. Bound callback tests with
  `loginTimeouts.browser` and set injected display variables on Linux.
- Starter comments and runtime config/gate settings share defaults in
  `src/config/defaults.ts`. Review flag defaults should use that module
  too, so starter guidance stays aligned with runtime behavior.
- Login orchestration shares `ctx.lines` across providers and prompts.
  Reuse `providersNeedingLogin` and `loginProvider` for login offers;
  `loginPath` owns the scope rules shared by login and logout.

## Docs

- User-facing docs (`README.md`, `docs/`, the bundled
  `src/skill/assets/roast/SKILL.md`) write every invocation as
  `npx roast ...`; Roast is a project dependency, never a `PATH` binary.
  Settings are documented as `.roast.json` keys, never environment
  variables; only credentials, `ROAST_SKIP`, and test-only `ROAST_LIVE_*`
  / `ROAST_TEST_*` variables exist.
- CLI messages in `src/cli/` (for example the gate hint printed
  during review) still say bare `roast`; changing them is a code change,
  not a docs change.
