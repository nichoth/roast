# 02: Interactive provider and model prompts for built-in providers

**What to build:** When `npx roast init` runs with interactive terminals
(the existing `interactiveTerminals(stdin, stderr)` check) and a role's
model flag is missing or blank, it asks for that role's provider and
model. Each role is asked in full, finder first. A flag always wins for
its role, so one flag plus a prompt for the other role works, and both
flags mean no prompts.

The provider menu is numbered and lists Anthropic, OpenAI, and
OpenRouter. It accepts a number or a provider name. The finder's default
follows the existing starter placement (OpenAI). The verifier's default
is the other provider by the `otherProvider` rule. The model prompt shows
a suggested ID from the shared constants (ticket 01) that Enter accepts.
For OpenRouter the suggestion is the slug for the vendor the other role
is not using (the Anthropic slug when the verifier is not yet known). A
typed model must pass `placeModel` and place onto the chosen provider.
There is no placeholder escape at a built-in provider's model prompt.

Every prompt asks again on invalid input and prints the validator's own
message. Prompts read through the shared `ctx.lines` reader so scripted
stdin flows across model prompts and login. All writes (project config,
`.gitignore` entry, stored credentials) happen after the last model
prompt. EOF or an abort signal at any prompt exits with nothing written.
The project-config existence check from ticket 01 runs before the first
prompt.

When both roles resolve to the same model on the same endpoint and
protocol, `init` prints one line saying verification adds little in that
setup. The same provider with different models gets no note.

Without interactive terminals, missing models become today's
placeholders and `init` prints a hint naming `--finder-model` and
`--verifier-model`. `--no-login` keeps its meaning and does not suppress
model prompts. The existing login offer still runs after the prompts.

Docs: update README "### 2. Create the project config" (prompts and the
non-interactive fallback); add the prompt flow and where suggested model
IDs live to `docs/agents/config.md`; add "update the suggested model IDs
and the README `init` example together" to the release checklist in
`docs/agents/packaging.md`.

**Blocked by:** 01

**Touches:** `src/cli/init.ts`, `src/cli/terminal.ts` (`LineReader`,
`interactiveTerminals`), `src/config/starter.ts`, `src/config/defaults.ts`,
`src/config/provider.ts` (`builtinProviders`), `test/cli/init.ts`,
`README.md`, `docs/agents/config.md`, `docs/agents/packaging.md`

**Status:** done

- [x] Choosing each built-in provider by number and accepting the
      suggested model writes a config whose role resolves onto that
      provider with the suggested model
- [x] Choosing a provider by name and typing a model writes that model on
      that provider
- [x] Accepting the verifier's default provider after choosing a finder
      provider places the verifier on the other provider (Anthropic and
      OpenAI swap; OpenRouter stays OpenRouter)
- [x] With `--finder-model` given, only the verifier is prompted, and the
      finder uses the flag's model
- [x] With both model flags, `init` reads nothing from stdin and writes
      the flag models
- [x] Without interactive terminals, `init` writes placeholder models,
      reads no stdin, and exits successfully
- [x] An invalid menu choice followed by a valid one succeeds
- [x] A model that does not place onto the chosen provider (for example an
      OpenAI ID under Anthropic) followed by a valid one succeeds
- [x] EOF partway through the prompts exits without writing `.roast.json`,
      a `.gitignore` entry, or stored credentials
- [x] An existing `.roast.json` is refused before any stdin is read
- [x] After the prompts, the login offer still stores a credential for a
      built-in provider that lacks one
