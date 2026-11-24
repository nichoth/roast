# LLM layer and agent loop (TS)

`src/llm/`.

## Adapters

- Adapters read no environment variable. A protocol is an entry in
  `ADAPTERS` (`client.ts`) with a pure encoder and an
  `AsyncIterable<SseEvent>` decoder returning a `ModelTurn`; `send` owns
  fetch, headers (`http.ts` `requestHeaders`), capture, usage, and
  abort.
- One `errors.ts`: `LlmError.kind` (underscore names, read by
  `src/cli/errors.ts`) and `sentinels` (hyphen names, `hasSentinel`)
  must stay in step.
- Tool results sent to models go through `encodeToolResult` (`json.ts`)
  only.
- `anthropic` (`anthropic.ts`) groups items into alternating role
  messages first, then drops a thinking-only assistant message; it never
  edits, reorders, or drops a signed block. `tool_choice` matches Go
  (`{type: auto, disable_parallel_tool_use: false}`).
- Usage stage 1 lives in `usage.ts` per protocol (`chatUsage`,
  `responsesUsage`, `anthropicUsage`); decoders call `normalizeUsage`
  on its result.
- Making an adapter available changes tests that pin unavailability:
  the construction test in `test/llm/client.ts` and the doctor roundtrip
  test (`test/cli/doctor.ts`, whose `doctorProbe` must speak the
  protocol).

## Agent loop (`agent.ts`, `runConversation`)

- `createClient(modelClient, {ledger, now, sleep, sessionId})`
  (`client.ts`) wraps a `ModelClient` into the finder/verifier `Client`.
  The pure decision is `reviewResponse` (`review.ts`); the deadline,
  ledger, final-argument validation, and retries are separate modules.
- `ModelClient.send` owns the request timeout; the loop composes only
  caller + deadline/window signals.
- Cutoff errors come from `cutoffError` (`errors.ts`), which keeps the
  cause out of the matchable chain; tests assert `details.stopCause`
  kinds, never message text.

## Tests

- `test/helpers/inference-server.ts` (`startInferenceServer`: a script
  picks a reply per request; it records method, path, headers, raw and
  parsed body) and `inference-stream.ts` (`writeInferenceStream`, the
  native SSE per protocol). The `responses` writer, like Go's, emits
  every output item as a function call, so message items yield no text.
- `test/helpers/anthropic-fakes.ts`: `anthropicCalls` (a Messages
  response), `startBindingServer` (rejects a signed thinking block whose
  prefix changed; counts `rejected`), and `deepSeekScript` /
  `startDeepSeekServer` (400 on a forced tool choice or a missing
  reasoning replay). `deepSeekScript` plugs into `settingsRepo`, whose
  fetch rewrites every origin to its own server.
- A fake that answers a different protocol than the request path makes
  the client see an incomplete stream and retry with the 5 s backoff;
  branch on `req.path` when one script serves two protocols.
- CLI review tests on `responses` use `responsesProfileConfig`,
  `responsesFindingsReply`, and `responsesCalls` (`test/helpers/review.ts`).
  Requests through `runRoast`'s rewriting fetch carry
  `transfer-encoding`; filter it with the other transport headers.
- Byte-level body behavior (read-ahead, caps, cancel counts) is tested
  with a `highWaterMark: 0` `ReadableStream` returned through
  `ClientConfig.fetch`; `new Response(stream)` neither copies nor
  pre-reads it.
- Agent-loop tests drive `harness(script)` from
  `test/llm/agent-helpers.ts` (a scripted fake `ModelClient`: canned
  turns, errors, or functions of the request; sleeps recorded).
- `AbortSignal.timeout` timers do not keep Node alive, so a fake step
  that waits for an abort must hold a timer (the `aborted()` helper
  does); otherwise the test process just exits.
