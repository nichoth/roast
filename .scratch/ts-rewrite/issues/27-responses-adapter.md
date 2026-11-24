# 27: `responses` adapter end to end, with harness scenarios

**Blocked by:** 20, 26
**Touches:** `src/llm/responses.ts` (encoder and stream decoder),
`src/llm/models.ts` (`responsesSystemMode`), `src/llm/client.ts`
(protocol dispatch for `responses`), `src/llm/usage.ts` (responses
stage 1), `test/helpers/inference-stream.ts` (`writeInferenceStream` for
`responses`), `test/llm/responses.ts`, `test/cli/` review tests on a
`responses` profile, `test/diff/` M4 scenarios
**Spec:** `spec/06-llm-protocols.md` 2.2, 2.3, 2.6.2, 2.8.2, 2.8.4,
2.9, 2.10, 2.13, 3.1 to 3.5, 5 (responses rows); `spec/01-cli.md` 3.8
(responses SSE fixture format); `spec/15-packaging.md` 2.13 (M4
scenarios); spec.md deliberate changes 7, 8, 9, 13
**Status:** done

## What to build

A user whose role profile says `"protocol": "responses"` (OpenAI
Responses API, or OpenRouter's) can run `npx roast review` and get the
same report, exit code, and run record as the Go version.

Ticket 13 built the protocol-neutral client, SSE parser, capture,
`fetch` wrapper, and errors with the `chat` adapter; ticket 20 wired
`review` on `chat`. This ticket adds the second adapter behind the same
`ModelClient.send` / `requestBytes` interface (seam resolution 6: area
06's `send` shape plus `requestBytes`, one `errors.ts`, one tool-result
encoder in `src/llm/json.ts`). Add nothing protocol-specific to the agent
loop.

The encoder is pure: `(config, request) -> {url, headers, body}` as in
2.6.2. `store` is always `false`. `previous_response_id`, `include`, and
`reasoning` are never sent. The whole conversation is replayed on every
request, and reasoning is never replayed. The system prompt's role
follows the model-ID rule (`system`, dropped for `o1-mini` /
`o1-preview`, else `developer`). The decoder consumes SSE events as in
2.8.2, including finish mapping from `incomplete_details.reason`, and
failing on `response.failed` / `error` without a retry. A stream that
ends without `response.completed` or `response.incomplete` raises the
retryable incomplete-stream error. Cached tokens are subtracted once
(deliberate change 13).

Extend the test fixture writer `writeInferenceStream` with the
`responses` event sequence (`spec/01-cli.md` 3.8, `sequence_number` in
emission order), so the fake inference server answers
`POST /v1/responses`.

Add the M4 differential-harness scenarios for `responses`. They are the
M3 review scenarios from ticket 26 (clean review, review with findings,
`--json`, `--staged`, `--max-severity`, failing provider) rerun on a
`responses` profile, compared under the existing allowlist.

## Acceptance criteria

- [x] A review on a `responses` profile against the fake server exits 0
      with no findings and 1 with findings at or above `--max-severity`.
      Its `--format json` stdout parses to the same report shape as a
      `chat` review.
- [x] Every request the fake receives posts to `<base>/v1/responses`
      with `store: false`, `stream: true`, `tool_choice: "auto"`, and no
      `previous_response_id`. The final (wrap-up) turn carries the same
      tools as earlier turns. A tool result is replayed as a
      `function_call_output` item with the matching `call_id`.
- [x] Each tool definition reaches the endpoint with `parameters` equal
      to the caller's full JSON Schema, including `additionalProperties`
      and nested `required`, plus `strict: false`.
- [x] `responsesSystemMode` returns `system` for IDs matching
      `gpt-3|gpt-4|chatgpt-|-chat`, `remove` for `o1-mini` /
      `o1-preview`, and `developer` otherwise. The encoded `input` reflects
      that mode (unit).
- [x] With `maxAttempts: 1`, a 500 reaches the server exactly once (CLI
      seam, exit and JSON error category).
- [x] `response.failed` and `error` events fail the call without a
      retry. A stream that ends with neither `response.completed` nor
      `response.incomplete` is retried as an incomplete stream (adapter
      seam).
- [x] Finish mapping: absent or empty reason -> `tool-calls` or `stop`;
      `max_output_tokens` -> `length`; `content_filter` ->
      `content-filter`. Tool calls on a `length` finish are never
      dispatched (CLI seam: the fake records no follow-up turn carrying
      their output).
- [x] Usage from a fixture with `input_tokens: 100` and 30 cached tokens
      lands in `meta.json` as 70 uncached and 30 cached. With 80 cached,
      it is 20 and 80.
- [x] Ambient `OPENAI_*` / `OPENROUTER_*` variables, and any header
      variables in `io.env`, add no headers or credentials to a
      `responses` request. A 3xx is not followed, its target sees no
      key, and the error is an endpoint error.
- [x] Each raw `text/event-stream` body appears byte-for-byte in the
      run's `provider-responses.jsonl` with protocol `responses`.
- [x] The differential harness runs the M3 review scenarios on a
      `responses` profile. Go and TS agree on exit code, parsed JSON
      stdout, requests grouped by (model, turn count), and run records.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass,
      and the Go build and Go tests still pass.
