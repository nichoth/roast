# Agent skill install

`src/skill/`, `src/cli/skill.ts`.

- `installationTargets` resolves targets: a non-empty parent (`--dir`)
  wins, then a non-empty project root gives project-local targets,
  otherwise the user-level targets. The CLI maps `--dir`, `--global`,
  and the Git toplevel onto it; `doctor` inspects user-level targets.
- The bundled skill text in `src/skill/assets/roast/SKILL.md` describes
  the install locations; update it when target resolution changes.
- `src/skill/assets.ts` imports each file under `src/skill/assets/roast/`
  explicitly; a new file there needs a new import, and
  `test/skill/assets.ts` fails until it has one.
- Home, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, and `PATH` come from the
  context env. `skillHooks.lookPath` is the swappable lookup.

## Tests

- Tests isolate `HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_CONFIG_HOME` so
  they can assert nothing reaches the real user directories
  (`isolateSkillHome`, `test/cli/skill.ts`). Keep `PATH`: the CLI shells
  out to `git`.
- `isolateSkillHome` blanks the two config overrides, because
  `isolatedEnv` sets `CLAUDE_CONFIG_DIR`, which counts as Claude Code
  being present.
