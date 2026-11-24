# 13: LLM core and the `chat` adapter

**Blocked by:** 04
**Touches:** `src/llm/types.ts`, `src/llm/errors.ts`, `src/llm/sse.ts`,
`src/llm/usage.ts`, `src/llm/models.ts`, `src/llm/chat.ts`,
`src/llm/capture.ts`, `src/llm/http.ts`, `src/llm/json.ts`,
`src/llm/session.ts`, `src/llm/client.ts`; exports `ClientConfig`,
`ModelRequest`, `ModelTurn`, `AssistantPart`, `ConversationItem`,
`ToolDefinition`, `ToolResult`, `Tool`, `Usage`, `RawResponse`,
`ModelClient`, `createModelClient`, `LlmError`, `AuthError`,
`EndpointError`, `NoFinalCallError`, `WorkDeadlineError`,
`ProviderError`, `IncompleteStreamError`, `CaptureError`,
`hasSentinel`, `isRetryable`, `retryDelayMs`, `errorStatus`,
`normalizeProviderError`, `parseSse`, `encodeToolResult`,
`decodeModelText`, `newSessionId`, `setFetch`, `resetFetch`;
`test/helpers/inference-server.ts`, `test/helpers/inference-stream.ts`
(`writeInferenceStream`, `writeJSONStream`), `test/llm/*.ts`,
`test/index.ts`
**Spec:** `spec/06-llm-protocols.md` sections 1, 2.1-2.5, 2.6 intro,
2.6.1, 2.7, 2.8 intro, 2.8.1, 2.8.4, 2.9-2.13, 3, 4, 5 (A and U seam
items for `chat` and the shared modules); `spec/01-cli.md` sections 3.7
and 3.8 (`chat` stream format); `spec/07-agent-loop.md` section 3.3
(`Tool` shape) and 3.4 (`errors.ts` sentinels); `spec.md` deliberate
changes 7, 8, 9, 13, 14, cross-cutting "JSON encoding", "Bytes and text",
"Network"
**Status:** done

## What to build

The provider-facing half of the LLM layer, with raw `fetch` and no SDK,
plus the `chat` protocol (OpenAI Chat Completions; OpenRouter, DeepSeek,
others):

- Protocol-neutral types, and `createModelClient(config)`: synchronous,
  no I/O, failing in the spec's order on non-positive max output tokens,
  a blank key, or an unknown protocol (`""` means `chat`).
- `send(request)`: one HTTP attempt, never retried here. Encode, add the
  credential, `User-Agent: roast/<version>`, `X-Agent-Session-Id` and the
  optional session header (set once each), POST with
  `redirect: 'manual'`, refuse every 3xx as an `EndpointError` (no key
  sent onward), read at most 32 KiB of any error body, run the lazy SSE
  parser over a 2xx body through raw-response capture, assemble the
  turn, normalize usage, call `onUsage` once, release the body, run the
  capture callback (a capture failure latches the client and is never
  retried), and honor the request signal and timeout.
- Ambient environment never adds headers, credentials, or endpoints:
  nothing in this area reads `process.env`.
- The shared SSE parser (CRLF/CR/LF, multi-line data, comments, missing
  final blank line, chunk boundaries inside lines and UTF-8 sequences,
  pull-based).
- Usage normalization: cached tokens subtracted once for `chat`
  (deliberate change 13); a chunk without usage keeps the last reported
  usage (deliberate change 14).
- Error classification and retry delays (`isRetryable`,
  `retryDelayMs` with `retry-after-ms`, `retry-after` seconds and date).
- Raw-response capture with the size cap, the `Content-Length` check,
  streaming capture that never reads ahead, and the sticky failure gate.
- `chat` encoding (model-ID rules such as `max_completion_tokens` for
  reasoning models, automatic tool choice, DeepSeek reasoning replay) and
  chunk decoding into `ModelTurn` with finish-reason categories and the
  raw reason preserved.
- `encodeToolResult`: the single tool-result JSON encoder (sorted keys in
  code-unit order, no HTML escaping of `<>&` or U+2028/U+2029);
  `decodeModelText` turns lone surrogates into U+FFFD.
- `newSessionId()`: `roast-` plus unpadded base32 of 16 random bytes.

Seam resolution 6 (adapter interface): keep spec 06's `ModelClient`
shape (`send(request):Promise<ModelTurn>`, `usage()`), and add
`requestBytes(request):number`, the exact byte length of the encoded
body, which the agent loop's ledger needs (ticket 14). There is one
`src/llm/errors.ts`; ticket 04 already created it with minimal classes
(`LlmError` with `kind`, auth, endpoint, budget-exhausted,
work-deadline, no-final-call) for `errorCategoryFor`, so extend that
file, keeping those exports: spec 06's classes, where `LlmError` also carries
spec 07's `sentinels` set and `details`, and `hasSentinel(err, s)`
recognizes `AuthError` as `auth` and `EndpointError` as `endpoint` while
walking `cause`. Ticket 14 adds cutoff errors to this module rather than
creating a second one. There is one tool-result encoder, in
`src/llm/json.ts`; no `tool-json.ts`. This ticket also defines the
`Tool` type from spec 07 section 3.3 (`name`, `description`, `schema`,
optional `run(args, signal)`, optional `recordsResult`) in
`src/llm/types.ts`, so ticket 12 can build tools before the loop exists.
The adapter-level `Usage` is camelCase as in spec 06; ticket 14 maps it
to the snake_case record shape.

`fetch` comes from `http.ts` (`setFetch` / `resetFetch` for tests);
`ClientConfig` also accepts an optional `fetch` that overrides it, so
the CLI can pass `io.fetch` down in ticket 20.

Test helpers this ticket owns, for every later ticket to reuse and
extend: `test/helpers/inference-stream.ts` with
`writeInferenceStream(res, protocol, response)` and `writeJSONStream`
(only the `chat` format of spec 01 section 3.8 now; tickets 27 and 28 add
`responses` and `anthropic`, and an unknown protocol is an error), and a
`node:http` fake inference server in `test/helpers/inference-server.ts`
that records each request (method, path, headers, parsed body) and
answers from a script selected by request content.

Out of scope: the `responses` and `anthropic` encoders and decoders
(tickets 27, 28; until then `createModelClient` with those protocols
fails clearly), the agent loop, step retries, and the ledger (ticket
14), and the CLI-seam tests that need `review` (tickets 20, 27, 28). Live
`ROAST_LIVE_*` tests land in ticket 14 (DeepSeek, `chat`) and ticket 28
(Anthropic).

## Acceptance criteria

Seams: (A) `createModelClient(...).send()` against the `node:http` fake;
(U) pure unit tests. Assert on requests received, error classes,
sentinels, and parsed values, never on message text.

- [x] Construction fails for a blank or whitespace key, a non-positive
  max output tokens, and an unknown protocol, in the spec's order (A).
- [x] A `chat` request posts to the configured endpoint once, with only
  Roast's headers (credential, `User-Agent` `roast/<version>`, session
  headers), whatever provider, auth-token, or custom-header variables
  are set in the environment (A).
- [x] Reasoning-model IDs get `max_completion_tokens`, others
  `max_tokens`; forced tool choice is never sent (U on the encoder).
- [x] Tool schemas reach the request with `additionalProperties` and
  nested `required` lists intact (U on the encoder).
- [x] `requestBytes(request)` equals the byte length of the body
  actually sent (A).
- [x] A 3xx response is not followed, the redirect target receives no
  request and no key, and the error is an `EndpointError` that is not
  retryable (A).
- [x] An error body larger than 32 KiB is read only up to 32768 bytes
  (A).
- [x] Two concurrent conversations get distinct `roast-` session IDs,
  mirrored into the configured session header; each header is set once,
  and an environment naming that header does not change its value (A).
- [x] A capture-callback failure surfaces as `CaptureError` on that call
  and on every later call of the client, after exactly one HTTP request
  (A).
- [x] `Content-Length: 16777217` fails with the size error; an invalid
  JSON 2xx body fails once; streaming capture without `Content-Length`
  fails on overflow without calling the callback and never buffers more
  than the cap (A and U).
- [x] Streaming capture does not read ahead of the parser, preserves
  exactly the bytes read, and releases the body once (A with a
  controlled `ReadableStream`).
- [x] A request timeout yields an `EndpointError` whose cause is a
  timeout, within one second of the timeout (A).
- [x] Classification table: 408, 409, 429, 5xx, and `x-should-retry`
  retryable; 401, 403, 3xx, 400 not; transient stream types, incomplete
  streams, and transport errors retryable; aborts and `CaptureError` not
  (U).
- [x] `retryDelayMs` honors `retry-after-ms`, `retry-after` seconds, and
  `retry-after` dates, and ignores out-of-range hints (U).
- [x] `chat` usage `prompt_tokens: 100, cached_tokens: 30` normalizes to
  uncached 70 and cached 30, and cached 80 to 20 and 80; a chunk without
  usage after one with usage keeps the earlier usage (U).
- [x] Finish reasons `insufficient_system_resource`, `content_filter`,
  and an unknown value map to `error`, `content-filter`, and `unknown`
  with the raw reason exposed (U on the decoder).
- [x] The SSE parser handles CRLF, CR, and LF, multi-line data,
  comments, a missing final blank line, chunk boundaries inside a line
  and inside a UTF-8 sequence, and reads no further than the requested
  event (U).
- [x] `encodeToolResult` sorts keys and leaves `<`, `>`, `&`, and U+2028
  unescaped; a lone surrogate in model output decodes to U+FFFD (U).
- [x] `hasSentinel` reports `auth` for an `AuthError` and `endpoint` for
  an `EndpointError`, including through a `cause` chain (U).
- [x] `writeInferenceStream` for `chat` emits the three chunks plus
  `[DONE]` of spec 01 section 3.8, and the `chat` decoder turns that
  stream back into the original tool calls, finish reason, and usage (U).
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
  the Go build and Go tests still pass.
