---
name: roast
description: Adversarial cross-model review in which a finder proposes defects and an independent verifier checks each claim against the code. Use after a coherent, non-trivial code or prose change, before declaring the work complete, or when the operator asks for a Roast review.
---

# Roast

Roast reviews local Git changes with two independently configured models. The
finder looks aggressively for defects; the verifier re-reads the cited code and
confirms or refutes each candidate before it reaches the final report.

## Setup and trust boundary

Roast is installed as a project dependency and run with `npx roast`. It sends
the selected diff, repository context, prompts, and tool results to the
inference endpoints in the project config. These destinations are
user-controlled and may be third-party services. Do not assume they are trusted
for private source code: inspect the configuration or run `npx roast doctor`,
and follow the operator's data-handling policy.

Configure profiles in the project config, `.roast.json` (JSONC), found by
walking up from the working directory no further than the Git toplevel;
`npx roast doctor` shows the path it uses, and `--config <path>` names another
file. If there is none, `npx roast init` writes a starter. A profile selects
an endpoint, model, wire protocol (`responses`, `chat`, or `anthropic`),
credential environment variable, and output limit. The finder and verifier
may use different profiles and protocols. `npx roast init` places a bare
Claude or OpenAI model ID on that vendor's API and a slash-form ID
(`anthropic/claude-opus-5-5`) on OpenRouter.

Set up credentials with `npx roast login`: with no argument it logs in to
each built-in provider (`anthropic`, `openai`, `openrouter`) the config uses
that has no key yet, and stores the key for the project inside `.git`
(`--global` stores it for the user). Login needs the operator at an
interactive terminal to paste a key or approve in a browser, so ask them to
run it rather than running it yourself. Environment variables
(`ROAST_FINDER_API_KEY` or `ROAST_VERIFIER_API_KEY`, the profile's
`api_key_env`, then `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`OPENROUTER_API_KEY`) take precedence over a stored key. A stored or
standard provider key goes only to that provider's built-in endpoint.
`npx roast logout` removes a stored key. `npx roast doctor` reports where
each role's credential comes from.

A project config that names a custom endpoint, an unsupported protocol for a
built-in endpoint, a non-standard credential variable, or a prompt-override
path must be approved once per clone before Roast sends anything. In a
non-interactive session an unapproved config makes `npx roast review` exit 2
with a message naming `npx roast trust`. Do
not approve it yourself: show the operator the summary from
`npx roast trust` and let them decide.

`npx roast skill install` installs this skill into the project's
`.agents/skills` directory at the Git toplevel, and into `.claude/skills` when
Claude Code is in use. `--global` installs into the user-level Agent Skills,
Claude Code, and Polytoken locations instead. `npx roast skill status` reports
whether each installed copy matches the installed Roast. On the first
interactive review in a repository, Roast asks once whether to install its
native pre-commit gate and records the answer in local Git config.
Non-interactive runs never install it without recorded consent. The gate is
managed explicitly with `npx roast gate enable|status|disable`.

## When to review

Review coherent, non-trivial changes such as features, refactors, concurrency,
protocol changes, and important bug fixes. Skip formatting-only changes and
minor documentation corrections. Review before committing with `--staged`, or
use `--base <ref>` when the work is already committed.

## Invocations

```sh
npx roast review --task "what changed and why"
npx roast review --staged --task "what changed and why"
npx roast review --quick --task "draft review"
npx roast review --interactive --task "review with repository navigation"
npx roast review --scope repo --task "survey this repository"
npx roast runs
npx roast runs show <run-id>
npx roast doctor
```

`--quick` skips independent verification and is a draft result. Repository
survey mode is prioritized sampling, not exhaustive coverage. A `NO_DIFF`
result means no review ran; it is not a clean review.

Roast writes JSON to stdout and a Markdown report to stderr by default. Exit 0
means the command completed without a finding at the requested gate threshold;
exit 1 means a finding met that threshold; exit 2 is invalid usage or config;
exit 3 is authentication; exit 4 is an operational or resource failure; and
exit 5 is cancellation.

Every non-empty review records a durable local run under `.roast/runs/` at the
Git toplevel. Replay and evaluation tooling are intentionally not part of the
`roast` command.

## Handling findings

Check every finding against the cited code. State whether it is genuine,
refuted, or a deliberate tradeoff and explain what will be changed. A verifier
refutation is expected behavior, not a failure. Do not silently discard a
confirmed finding.
