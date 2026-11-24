# 28: `anthropic` adapter end to end, with harness scenarios

**Blocked by:** 20, 26
**Touches:** `src/llm/anthropic.ts` (encoder and stream decoder),
`src/llm/models.ts` (`anthropicDefaultThinking`), `src/llm/client.ts`
(protocol dispatch, `X-Api-Key`, `Anthropic-Version`), `src/llm/usage.ts`
(anthropic stage 1), `test/helpers/inference-stream.ts`
(`writeInferenceStream` for `anthropic`), `test/llm/anthropic.ts`,
`test/cli/` review tests on an `anthropic` profile, binding and DeepSeek
fake servers under `test/helpers/`, `test/diff/` M4 scenarios
**Spec:** `spec/06-llm-protocols.md` 2.2 (`/v1` trimming), 2.3, 2.5,
2.6.3, 2.8.3, 2.8.4, 2.9, 2.10, 2.13, 3.1 to 3.5, 4, 5 (anthropic,
DeepSeek, capture rows); `spec/01-cli.md` 3.8 (anthropic SSE fixture
format); `spec/15-packaging.md` 2.13 (M4 scenarios); spec.md deliberate
changes 7, 8, 9, 21; spec.md Further Notes (`claude-mythos-preview`)
**Status:** done

## What to build

A user whose role profile says `"protocol": "anthropic"` (native
Messages API, or DeepSeek's Anthropic-compatible endpoint) can run
`npx roast review` and get the same report, exit code, and run record as
the Go version.

This ticket adds the third adapter behind the `ModelClient.send` /
`requestBytes` interface from ticket 13 (seam resolution 6). The
encoder follows 2.6.3:

- `max_tokens` is the profile budget exactly, and `system` is a text
  block array.
- `tool_choice` is always `{type: "auto"}`, never forced in any phase.
- Each `input_schema` is a deep copy of the caller's full schema
  (deliberate change 21: unlike Go, `additionalProperties` and nested
  `required` survive).
- There is no `cache_control` and no `anthropic-beta` header.
- `thinking: {type: "adaptive", display: "summarized"}` is sent only
  for model IDs containing `claude-mythos-preview`, kept for parity.

Message grouping alternates user and assistant blocks. Assistant blocks
are replayed byte-faithfully in arrival order. A signed thinking block
replays as `thinking`, redacted data as `redacted_thinking`, and an
unsigned one is dropped. Blank or non-object `tool_use` input becomes
`{}`.

The decoder follows 2.8.3:

- Blocks are tracked by index. `message_delta` updates usage
  field-by-field.
- Finish is mapped from `stop_reason`.
- A missing `message_stop` or empty stop reason raises the retryable
  incomplete-stream error, and the partial tool call never runs.

The base URL has a trailing `/v1` trimmed before `/v1/messages` is
appended. The credential goes only in `X-Api-Key`.

Extend `writeInferenceStream` with the `anthropic` sequence
(`message_start` ... `message_stop`, `spec/01-cli.md` 3.8). Port the Go
`bindingServer` (rejects a changed signed-thinking prefix) and
`deepSeekThinkingServer` (rejects forced tool choice and a missing
`thinking` replay) as test fakes.

Add the M4 differential-harness scenarios for `anthropic`: the M3 review
scenarios from ticket 26 rerun on an `anthropic` profile. Tool-schema
differences caused by deliberate change 21 go on the harness allowlist.

## Acceptance criteria

- [x] A review on an `anthropic` profile against the fake posts to
      `<base>/v1/messages` (also when the base URL ends in `/v1`). It
      sends `X-Api-Key`, a non-empty `Anthropic-Version`, and no
      `Authorization` header. It sends `system` and `stream: true`, and
      the same tools on the wrap-up turn. The second request carries the
      injected notice. The review exits 0 or 1 by findings as with
      `chat`.
- [x] `max_tokens` equals the profile's `max_output_tokens` for 1024 and
      for 32768.
- [x] `tool_choice.type` is `auto` for converse and for structured
      calls, in every phase. A DeepSeek-style fake that answers 400 to
      any forced choice or missing `thinking` replay sees no rejected
      request.
- [x] Each tool's `input_schema` deep-equals the caller's full JSON
      Schema, including `additionalProperties` and nested `required`.
      `required` is `[]` when the schema has none.
- [x] A model ID containing `claude-mythos-preview` gets the adaptive
      `thinking` field. Other IDs send no `thinking` field.
- [x] A signed thinking block, including one that arrived after a tool
      call, is replayed unchanged in order. A binding fake that rejects
      any changed prefix accepts the follow-up request.
- [x] A 401 maps to the auth category: exit 3, and `--error-format json`
      reports category `auth`.
- [x] A 3xx is not followed, the redirect target never sees
      `x-api-key`, and the error is an endpoint error that is not
      retried.
- [x] Finish mapping: `end_turn` / `pause_turn` / `stop_sequence` ->
      `stop`; `max_tokens` / `model_context_window_exceeded` ->
      `length`; `refusal` / `content_filtered` / `guardrail_intervened`
      -> `content-filter`; other -> `unknown` with the raw reason
      exposed.
- [x] An interrupted stream (tool input and `stop_reason` but no
      `message_stop`) is retried and its partial tool never runs. All
      streams appear in `provider-responses.jsonl`, and `meta.json`
      usage counts only completed calls.
- [x] Usage accumulation over the Go fixture yields 20 / 6 / 4 / 8 / 2
      (uncached, cached, cache write, output, calls) in `meta.json`.
- [x] Ambient `ANTHROPIC_*` variables (API key, auth token, base URL,
      custom headers) never change the endpoint, the headers, or the
      credential of a request.
- [x] The differential harness runs the M3 review scenarios on an
      `anthropic` profile. Go and TS agree on exit code, parsed JSON
      stdout, requests (modulo the allowlisted schema change), and run
      records.
- [x] An opt-in live test in `test/live/` (run by `npm run test:live`,
      never in CI): with `ROAST_LIVE_ANTHROPIC_API_KEY` (and optional
      `_BASE_URL`, `_MODELS`) set, a two-turn review completes for each
      listed model (successor of `TestLiveAnthropicTwoTurnReview`).
      Without the variables it skips.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
