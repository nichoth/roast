# 06 -- LLM protocol adapters

Area: the three inference wire protocols (`chat`, `responses`,
`anthropic`; OpenRouter is reached through `chat` or `responses`) spoken
over raw `fetch`, the shared SSE parser, raw response capture, error
classification, and usage normalization. The agent loop, token ledger,
wrap-up turn, final-tool validation and the retry loop itself belong to the
agent-loop area; this file defines the adapter interface that area
consumes and the error/usage values it receives.

## 1. Purpose

Each **role** (finder, verifier) is bound to one **inference profile**: a
model, an endpoint (base URL), a protocol, an output limit, an optional
`session_header`, and a **credential** resolved by the config area. This
area turns one model turn of the agent loop (system prompt, conversation so
far, tool set) into exactly one HTTP request in the profile's protocol,
streams the response, and returns a protocol-neutral assistant turn: ordered
text, reasoning and tool-call parts, a finish reason, and normalized token
usage.

It also enforces three security and evidence invariants that hold no
matter which protocol is used:

1. Only Roast's resolved configuration shapes a request. Nothing in the
   process environment adds a credential, header, base URL, or proxy
   setting through this layer.
2. A credential is never forwarded to a host the profile did not name:
   every redirect is refused (2.5).
3. Every successful (2xx) provider response body is captured, byte for
   byte and size-capped, into the **run record** before any tool call it
   contains can be dispatched; a capture failure is permanent.

## 2. Behavior contract

### 2.1 Client construction

A client is created per role per run (and once per role by `doctor`) from:

| field             | meaning                                             |
|-------------------|-----------------------------------------------------|
| `role`            | `"finder"`, `"verifier"`, or a doctor check name    |
| `baseUrl`         | profile endpoint; CLI trims trailing `/`            |
| `apiKey`          | resolved credential value                           |
| `model`           | model ID, sent verbatim as the body's `model`       |
| `protocol`        | `""` or `"chat"`, `"responses"`, `"anthropic"`      |
| `maxOutputTokens` | positive integer                                    |
| `maxAttempts`     | attempts per model call; `<= 0` means 4             |
| `requestTimeout`  | per request; `0` disables                           |
| `sessionHeader`   | optional extra header name (validated by config)    |
| `captureResponse` | optional callback receiving each raw 2xx body       |

Construction is synchronous, performs no I/O, and fails with these
messages (checked in this order):

1. `maxOutputTokens <= 0` -> `<model>: max output tokens must be positive`
2. `apiKey.trim() === ""` -> `<model>: API key is not configured`
3. unknown protocol -> `unsupported inference protocol "<protocol>"`

An empty protocol is `chat` everywhere, including the `protocol` field of a
captured raw response (`protocolName`).

Built-in endpoints (config area, restated for context): OpenAI
`https://api.openai.com/v1` (`responses`, `chat`), Anthropic
`https://api.anthropic.com/v1` (`anthropic`), OpenRouter
`https://openrouter.ai/api/v1` (`chat`, `responses`). OpenRouter is never a
protocol's implicit default endpoint.

### 2.2 Endpoint URL

`baseUrl` already has trailing slashes removed by the CLI; adapters remove
them again defensively.

| protocol    | request URL                                           |
|-------------|-------------------------------------------------------|
| `chat`      | `<base>/chat/completions`                             |
| `responses` | `<base>/responses`                                    |
| `anthropic` | `<base'>/v1/messages`                                 |

For `anthropic`, `base'` is `base` with trailing `/` characters removed and
then one trailing `/v1` removed if present. Roast profiles write Anthropic
endpoints with `/v1` like the OpenAI protocols, so
`https://api.anthropic.com/v1` -> `https://api.anthropic.com/v1/messages`,
and `https://gw.example/anthropic` ->
`https://gw.example/anthropic/v1/messages`. OpenRouter chat therefore posts
to `https://openrouter.ai/api/v1/chat/completions`.

All requests are `POST` with a JSON body.

### 2.3 Request headers

Every request carries exactly these Roast-controlled headers:

| header               | chat / responses        | anthropic             |
|----------------------|-------------------------|-----------------------|
| `Content-Type`       | `application/json`      | `application/json`    |
| credential           | `Authorization: Bearer <key>` | `X-Api-Key: <key>` |
| `Anthropic-Version`  | absent                  | `2023-06-01`          |
| `User-Agent`         | `roast/<version>`       | `roast/<version>`     |
| `X-Agent-Session-Id` | session ID              | session ID            |
| `<session_header>`   | session ID (if set)     | session ID (if set)   |

- `<version>` is the package version (Go: `buildinfo.Version`, `dev` in
  tests). In TS it is injected at build time; tests may assert the prefix
  `roast/`.
- Anthropic requests never carry `Authorization`; chat/responses requests
  never carry `X-Api-Key`.
- Session ID: `roast-` followed by 26 characters of the RFC 4648 base32
  alphabet `A-Z2-7` from a CSPRNG (Go `crypto/rand.Text()`, 128 bits). The
  agent loop mints one per `converse` / `completeStructured` call and passes
  it in every request of that call, including retries and the wrap-up turn.
  Two concurrent conversations on one client have different IDs.
- The session headers are set last. Header names are case-insensitive, so
  a profile `session_header` of `x-opencode-session` yields one header with
  the session value. Config validation already rejects reserved names
  (`Authorization`, `X-Api-Key`, `Content-Type`, `User-Agent`,
  `X-Agent-Session-Id`, `Anthropic-Version`, `Anthropic-Beta`,
  `Anthropic-Workspace-Id`, `OpenAI-Organization`, `OpenAI-Project`, any
  `X-Stainless-*`, hop-by-hop and framing headers).
- `Accept` is not significant to any fake or provider Roast targets; the TS
  adapters send `Accept: text/event-stream`.

### 2.4 Ambient environment never influences requests

The Go SDKs read `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_BASE_URL`,
`OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_CUSTOM_HEADERS`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_PROFILE`, `ANTHROPIC_WORKSPACE_ID`,
`ANTHROPIC_CONFIG_DIR` profile files, and federation variables; Go Roast
strips every header they could add (`sdkenv.go`). The TS adapters read no
environment variable at all, so the contract becomes structural:

- Request URL, headers and body are a pure function of the client config,
  the session ID, and the model request.
- With any of the variables above set to junk (including a decoy base URL
  and custom headers naming `User-Agent` and `X-Agent-Session-Id`), the
  configured endpoint receives exactly one request per call, the credential
  header holds only the configured key, `User-Agent` is `roast/<version>`,
  there is one `X-Agent-Session-Id` starting `roast-`, no
  `OpenAI-Organization`, `OpenAI-Project`, `Anthropic-Workspace-Id` or
  custom header, no header value contains an ambient value, and the decoy
  receives nothing.
- Credential discovery from the environment happens only in the config
  area (`ROAST_<ROLE>_API_KEY`, `api_key_env`, provider variables, stored
  credentials). The adapter receives a finished key.

### 2.5 Redirects

Every HTTP redirect is refused as an endpoint error, for all three
protocols (deliberate change 8; Go followed redirects on `chat` and
`responses`). Every request uses `fetch(..., {redirect: 'manual'})` and any
3xx response is an endpoint failure: a non-2xx HTTP error (status 3xx, not
retryable, `ErrEndpoint`). The redirect target is never contacted, so it
never sees `Authorization` or `X-Api-Key`.

### 2.6 Request bodies

Common rules for all protocols:

- `stream: true` always. Non-streaming generation is never used (Go's
  managed model returns `roast agent runtime requires streaming` for it).
- The model ID is sent verbatim.
- Tool choice is always automatic. Roast never forces a tool choice:
  thinking-mode providers (DeepSeek, Claude with thinking) reject forced
  choice with a 400. This holds for exploration turns, the wrap-up turn,
  and the single-call structured path.
- The tool set is identical on every request of one conversation, in the
  caller's order, including the wrap-up turn (it is part of the signed
  reasoning prefix). The agent loop decides the set; adapters serialize it.
- No temperature, top_p, penalties, seed, `user`, metadata, parallel tool
  flags (except Anthropic's below), prompt-cache keys, or cache-control
  markers are sent. Provider-side prompt caching is whatever the provider
  does automatically; Roast only reads cache counters back (2.9).
- No reasoning / thinking configuration is sent, with the one Anthropic
  exception in 2.6.3.

#### 2.6.1 `chat` (OpenAI Chat Completions; OpenRouter, DeepSeek, others)

```json
{
  "model": "<model>",
  "messages": [ ... ],
  "max_tokens": 4096,
  "stream": true,
  "stream_options": {"include_usage": true},
  "tools": [
    {"type": "function",
     "function": {"name": "read", "description": "...",
                  "parameters": { <complete caller JSON Schema> },
                  "strict": false}}
  ],
  "tool_choice": "auto"
}
```

- Output limit field: `max_tokens`, except for models matched as reasoning
  models, which get `max_completion_tokens` instead (and no `max_tokens`).
  A model ID is a reasoning model when its lowercased ID matches
  `/(?:^|[-.])(?:o[134]|oss)|gpt-[5-9]|codex-|computer-use/` and does not
  match `/gpt-3|gpt-4|chatgpt-|-chat/`. This applies to every chat
  endpoint, including OpenRouter IDs such as `openai/gpt-5`.
- `tools` and `tool_choice` are omitted when the tool list is empty.
- `description` is always present (empty string when the tool has none).
- `parameters` is a deep copy of the caller's full schema, including
  `additionalProperties` and nested `required` arrays.
- Tool-call `arguments` are kept as the raw string received; the agent loop
  decodes them (2.8.4).

Message encoding (in conversation order):

- system prompt: `{"role":"system","content":"<text>"}`
- user text: `{"role":"user","content":"<text>"}`
- assistant turn: see below
- tool result:
  `{"role":"tool","tool_call_id":"<id>","content":"<output>"}`

Assistant turn: one message
`{"role":"assistant","content":"<texts joined by \n>","tool_calls":[...],
"reasoning_content":"<reasoning texts joined by \n>"}` where:

- `content` is omitted when the turn has no text part.
- `tool_calls` entries are
  `{"id":"<id>","type":"function","function":{"name":"<n>",
  "arguments":"<raw input string>"}}`,
  in arrival order; omitted when none.
- `reasoning_content` is present whenever the turn has at least one
  reasoning part, even if the joined text is empty. DeepSeek thinking mode
  rejects a follow-up request with tools whose earlier assistant messages
  lack `reasoning_content`. OpenRouter's `reasoning` field is also replayed
  as `reasoning_content`.
- An assistant turn with neither text nor tool calls is dropped (even if it
  carried reasoning).
- Tool results carry the output string unchanged; an error result is the
  error text as plain content (no error flag exists on this protocol).

#### 2.6.2 `responses` (OpenAI Responses API; OpenRouter)

```json
{
  "model": "<model>",
  "input": [ ... ],
  "max_output_tokens": 4096,
  "store": false,
  "stream": true,
  "tools": [
    {"type": "function", "name": "read", "description": "...",
     "parameters": { <complete caller JSON Schema> }, "strict": false}
  ],
  "tool_choice": "auto"
}
```

- `store` is always `false`; `previous_response_id` is never sent; the full
  conversation is replayed every request. No `include`, no `reasoning`.
- `tools` / `tool_choice` omitted when the tool list is empty.

Input items:

- system prompt: `{"role":"<mode>","content":"<text>"}` (see below)
- user text:
  `{"role":"user","content":[{"type":"input_text","text":"<text>"}]}`
- assistant text: `{"role":"assistant","content":"<text>"}`
- assistant tool call: `{"type":"function_call","call_id":"<id>",
  "name":"<n>","arguments":"<raw>"}`
- assistant reasoning: never replayed
- tool result:
  `{"type":"function_call_output","call_id":"<id>","output":"<output>"}`

Assistant parts become separate items in arrival order. System message
mode: if the lowercased model ID matches `/gpt-3|gpt-4|chatgpt-|-chat/`,
role `system`; otherwise, if the model ID contains `o1-mini` or
`o1-preview`, the system prompt is dropped; otherwise role `developer`.

#### 2.6.3 `anthropic` (native Messages API)

```json
{
  "model": "<model>",
  "max_tokens": 4096,
  "system": [{"type": "text", "text": "<system prompt>"}],
  "messages": [ ... ],
  "stream": true,
  "tools": [
    {"name": "read", "description": "...",
     "input_schema": {"type": "object",
                      "properties": { ... }, "required": ["path"]}}
  ],
  "tool_choice": {"type": "auto", "disable_parallel_tool_use": false}
}
```

- `max_tokens` is the profile's `maxOutputTokens` exactly (a 32768 budget
  reaches the endpoint unchanged).
- `input_schema` is a deep copy of the caller's full JSON schema, including
  `additionalProperties` and nested `required` arrays (deliberate change
  21; Go dropped every top-level keyword except `type`, `properties` and
  `required` because of a Fantasy limitation). `type` is `"object"`;
  `required` is always present (`[]` when the schema has none).
- `tools` / `tool_choice` omitted when the tool list is empty.
- Thinking: no `thinking` field, except when the lowercased model ID
  contains `claude-mythos-preview`, which gets
  `"thinking": {"type": "adaptive", "display": "summarized"}` (kept for
  parity).
- No `cache_control` anywhere; no `anthropic-beta` header.

Message encoding: conversation items are grouped into alternating role
blocks. Consecutive user texts and tool results merge into one
`{"role":"user","content":[...]}` message, blocks in order; consecutive
assistant turns merge into one assistant message.

- user text: `{"type":"text","text":"<text>"}`
- tool result: `{"type":"tool_result","tool_use_id":"<id>",
  "content":[{"type":"text","text":"<output>"}]}`, plus
  `"is_error":true` for error results
- assistant text: `{"type":"text","text":"<text>"}`
- assistant thinking:
  `{"type":"thinking","thinking":"<text>","signature":"<sig>"}`
- redacted thinking: `{"type":"redacted_thinking","data":"<data>"}`
- assistant tool call:
  `{"type":"tool_use","id":"<id>","name":"<n>","input":<object>}`

- Assistant blocks are replayed in exactly the order they arrived,
  including a thinking block that arrived after a tool call (it is signed
  over that call). Never reorder, merge, edit or drop a signed block: Claude
  5.1+ rejects a thinking block whose prefix (system prompt, tool set, and
  every earlier block) changed.
- A reasoning part with a signature replays as `thinking`; one with
  redacted data as `redacted_thinking`; one with neither is dropped.
- `tool_use.input` is the tool call's raw input parsed as a JSON object;
  blank input or input that does not parse to an object becomes `{}` (keeps
  the `tool_use` / `tool_result` pairing).
- An assistant message with no text and no tool use (thinking only) is
  dropped.

### 2.7 SSE parsing (shared)

One parser for all protocols, consuming the response body as bytes:

- UTF-8 decode incrementally; lines end in `\n`, `\r\n` or `\r`.
- Fields: `event:` sets the event name, `data:` appends a data line (joined
  with `\n`), `id:` and `retry:` are ignored, lines starting `:` are
  comments (OpenRouter keepalives). One optional space after the colon is
  stripped. A blank line dispatches the event; an event with no data lines
  is skipped. A trailing event without a final blank line is dispatched at
  EOF.
- Parsing is lazy: bytes are read only as the protocol decoder asks for
  the next event. Decoders stop reading at their terminal event (below)
  without draining the rest of the body; the body is then cancelled.

Per protocol event handling:

- `chat`: the event name is ignored. Data `[DONE]` (prefix match) ends the
  stream. Data whose JSON has a top-level `error` member (any value) ends
  the stream with a stream error (2.10). Other data is a
  `chat.completion.chunk`.
- `responses`: the event name is ignored; dispatch on the data JSON's
  `type`.
- `anthropic`: events with an empty name or named `ping` are skipped; an
  event named `error` ends the stream with an error built from its data
  (`{"type":"error","error":{"type":"...","message":"..."}}`). Others
  dispatch on the data JSON's `type`. Unknown types are ignored.

Malformed JSON in a dispatched event fails the call with a non-retryable
error.

### 2.8 Turn assembly

The adapter returns one `ModelTurn` per request (3.2): `parts` in arrival
order, `finishReason`, optional `rawFinishReason`, and `usage`. Finish
reason categories (Fantasy's names, used verbatim in agent-loop messages):
`stop`, `length`, `content-filter`, `tool-calls`, `error`, `other`,
`unknown`.

#### 2.8.1 `chat` chunks

For each chunk (single choice expected; all choices are processed):

- `usage`: if the chunk's `usage.total_tokens` is a positive number, the
  turn's usage becomes this chunk's usage. A chunk without usage (or with
  non-positive `total_tokens`) leaves the last reported usage unchanged
  (deliberate change 14; Go reset it to empty).
- Reasoning: a delta whose `reasoning_content` (preferred) or `reasoning`
  field is a non-empty string appends to the open reasoning part (opening
  one if none). A delta with such a field present and non-null but empty
  also opens a reasoning part, unless the delta is a boundary or reasoning
  already ended. A boundary is a delta with non-empty `content`, any
  `tool_calls`, or a non-empty `finish_reason`; a boundary closes an open
  reasoning part (it stays in `parts`, possibly with empty text).
- `content`: appended to the open text part (opening one).
- `tool_calls[i]`: keyed by `index`. A new index whose `function.name` and
  `function.arguments` are both empty is ignored. Otherwise it opens a call
  with `id` (or `tool-call-<index>` when missing), `type` (default
  `function`; any other type fails the call), `name`, and initial
  arguments. Later deltas for a known index append `function.arguments`.
- `finish_reason`: the last non-empty value wins.

At end of stream (EOF or `[DONE]`):

1. Map the raw finish: `stop` -> stop, `length` -> length,
   `content_filter` -> content-filter, `tool_calls` / `function_call` ->
   tool-calls, `insufficient_system_resource` (DeepSeek) -> error, anything
   else -> unknown.
2. If no finish reason arrived and there are tool calls: if any call's
   arguments are empty or not valid JSON, fail with the retryable
   incomplete-stream error; otherwise the finish is tool-calls.
3. If no finish reason arrived and there are no tool calls, fail with the
   incomplete-stream error.
4. Calls with empty arguments get `"{}"`.
5. If the mapped finish is length, error or content-filter and there are
   tool calls, the tool calls are suppressed (not in `parts`) and
   `rawFinishReason` is set.
6. Otherwise `rawFinishReason` is set when the mapped finish is length,
   content-filter, error or unknown (the agent loop prints
   `finish reason "<category>" (the provider sent "<raw>")` when they
   differ).
7. Tool-call parts are appended after text/reasoning, sorted by index.

#### 2.8.2 `responses` events

- `response.created`: ignored.
- `response.output_item.added` with item type `function_call`: open a
  call at `output_index`.
- `response.function_call_arguments.delta`: ignored for the result.
- `response.output_item.done` with item type `function_call`: if a call
  is open at `output_index`, close it and emit the tool call
  `{id: item.call_id, name: item.name, input: item.arguments}`.
- `response.output_text.delta`: append `delta` to the text part.
- `response.reasoning_summary_text.delta`: append to a reasoning part
  (kept in `parts`, never replayed).
- `response.completed`, `response.incomplete`: terminal; finish and usage
  come from the event's `response`.
- `response.failed`: fail with
  `response failed: <response.error.message> (code: <code>)` (the code
  suffix only when non-empty); not retryable.
- `error`: fail with `response error: <message> (code: <code>)`; not
  retryable.
- anything else: ignored.

Finish from `response.incomplete_details.reason` (`hasCall` = any tool call
emitted):

- `""` or absent -> tool-calls if `hasCall`, else stop.
- `max_tokens`, `max_output_tokens` -> length.
- `content_filter` -> content-filter.
- anything else -> tool-calls if `hasCall`, else other.

`response.status` is not consulted. Tool calls are kept even on length or
content-filter (the agent loop never dispatches them, 3.3). Ending without
`response.completed` or `response.incomplete` is the incomplete-stream
error.

#### 2.8.3 `anthropic` events

- `message_start`: usage := `message.usage`.
- `content_block_start`: open a block at `index`: `text`, `thinking`,
  `redacted_thinking` (its `data` comes from the start block), or
  `tool_use` (`id`, `name`).
- `content_block_delta`: `text_delta` appends to text;
  `thinking_delta` appends to thinking text; `signature_delta` appends to
  the signature; `input_json_delta` appends `partial_json`.
- `content_block_stop`: close the block. A `tool_use` emits a tool call
  whose input is the accumulated JSON, else the start block's `input`
  serialized when non-empty, else `"{}"`.
- `message_delta`: stop reason := `delta.stop_reason`;
  `usage.output_tokens` replaces output; `input_tokens`,
  `cache_creation_input_tokens` and `cache_read_input_tokens` replace the
  current values only when present and non-null.
- `message_stop`: terminal.
- anything else: ignored.

Parts are recorded in block-close order, which is index order for the
native API. A thinking part keeps its text and signature; a
`redacted_thinking` part keeps `data`.

Finish mapping: `end_turn`, `pause_turn`, `stop_sequence` -> stop;
`max_tokens`, `model_context_window_exceeded` -> length; `tool_use` ->
tool-calls; `refusal`, `content_filtered`, `guardrail_intervened` ->
content-filter; anything else -> unknown. If the stream ends without
`message_stop`, or with an empty stop reason, the call fails with the
retryable incomplete-stream error (pinned: a stream with complete tool
input and `stop_reason` but no `message_stop` is retried and its partial
tool call never runs).

#### 2.8.4 Decoding model output

All text decoded from provider bytes (text, reasoning, tool-call argument
strings) replaces lone UTF-16 surrogates with U+FFFD at decode time
(cross-cutting "Bytes and text"). Tool arguments are decoded by the agent
loop with exact, case-sensitive key matching (deliberate change 7); a JSON
`null` argument means absent. Adapters pass the raw argument string through
and never repair or re-key it.
### 2.9 Usage normalization

`Usage` (JSON names are used in run records):

```ts
interface Usage {
    uncachedInputTokens:number  // uncached_input_tokens
    cachedInputTokens:number    // cached_input_tokens
    cacheWriteTokens:number     // cache_write_tokens
    outputTokens:number         // output_tokens
    calls:number                // calls
}
```

A client accumulates usage across all its calls (thread-safe in Go; in TS
a plain object mutated synchronously). A call contributes when the provider
delivered its terminal finish (any finish reason, including abnormal ones),
even if the call then fails on capture or on a signal that fired at the
same time (Go adds usage whenever a finish part was seen). A call that
failed before a finish (HTTP error, stream error, incomplete stream,
transport error, abort) contributes nothing and does not increment
`calls`. Each contributing call adds `calls: 1`. The same per-call value
is reported to the agent loop for the ledger release (3.2 `onUsage`).

Per-response normalization subtracts cached tokens exactly once (deliberate
change 13; Go subtracted them twice for `chat` and `responses`):

Stage 1, provider fields -> intermediate `{input, cacheRead, cacheWrite,
output}`:

- `chat`: `P = usage.prompt_tokens`, `C =
  usage.prompt_tokens_details.cached_tokens`, `O =
  usage.completion_tokens`, `R =
  usage.completion_tokens_details.reasoning_tokens` (missing -> 0).
  `input = max(P - C, 0)`, `cacheRead = C`, `cacheWrite = 0`,
  `output = R > O ? O + R : O`.
- `responses`: same with `input_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens`,
  `output_tokens_details.reasoning_tokens`.
- `anthropic`: `input = input_tokens`, `cacheRead =
  cache_read_input_tokens`, `cacheWrite = cache_creation_input_tokens`,
  `output = output_tokens` (after the accumulation in 2.8.3).

Stage 2, intermediate -> `Usage` (every value first clamped to `>= 0`),
the same for every protocol because stage 1 already yields disjoint counts:
`uncached = input`, `cached = cacheRead`, `write = cacheWrite`,
`output = output`. There is no further subtraction. For `chat` and
`responses`, `prompt_tokens: 100, cached_tokens: 30` gives uncached 70 and
cached 30; `cached_tokens: 80` gives uncached 20 and cached 80.

Pinned values: two Anthropic responses each with `input_tokens: 10,
output_tokens: 4, cache_creation_input_tokens: 2,
cache_read_input_tokens: 3` accumulate to `{uncached: 20, cached: 6,
write: 4, output: 8, calls: 2}`. An intermediate of `{input: 8, cacheRead:
4, cacheWrite: 1, output: 3}` yields `{uncached: 8, cached: 4, write: 1,
output: 3}` on every protocol.

DeepSeek-specific counters (`prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`) are not read.

### 2.10 Errors and classification

Every failure an adapter raises is one of:

1. **HTTP error**: non-2xx status (3xx included, since redirects are not
   followed). The error body is read, at most 32 KiB (32768 bytes; the rest
   is discarded and the body cancelled; deliberate change 9), and is not
   captured. Fields: `status`, response headers (lowercased names),
   provider error `type`/`code` and `message` parsed best-effort from
   `{"error":{"type","code","message"}}` or Anthropic's
   `{"type":"error","error":{"type","message"}}`. Retryable when any of:
   header `x-should-retry` is one of Go `ParseBool`'s true spellings (`1`,
   `t`, `T`, `true`, `TRUE`, `True`); status `408`, `409`, `429`, or
   `>= 500`. A false `x-should-retry` does not prevent a status-based
   retry.
   `401`, `403`, other 4xx, and 3xx are not retryable.
2. **Stream error**: an error delivered inside a 200 stream (chat `error`
   member, Anthropic `error` event). Retryable iff the provider error
   `type` (or `code` when type is empty) is one of `server_error`,
   `internal_error`, `overloaded_error`, `api_error`, `rate_limit_error`.
   Responses `response.failed` / `error` events are never retryable.
3. **Incomplete stream**: the body ended cleanly without the protocol's
   terminal signal (2.8). Message `stream transport error: unexpected EOF`.
   Retryable.
4. **Transport error**: `fetch` rejected or the body read failed for a
   network reason (connection refused/reset, DNS failure, socket closed,
   TLS failure, HTTP/2 stream reset, unexpected EOF mid-body). Retryable.
5. **Abort**: the request's `AbortSignal` fired (caller cancellation, the
   agent loop's work deadline, or the per-request timeout). Never retried.
   The adapter rethrows the signal's reason unchanged so the caller can tell
   them apart.
6. **Capture error** (2.11). Permanent; never retried, and it disables
   the client.
7. **Protocol error**: malformed event JSON, a non-`function` chat tool
   call type. Not retryable.

Retry delay hints (consumed by the agent loop's retry policy, which owns
the loop: up to `maxAttempts` attempts per model call, Go Fantasy
`DefaultRetryOptions` initial delay 5000 ms, factor 2, so 5 s, 10 s, 20 s):
for an HTTP error with headers, `retry-after-ms` (float milliseconds), else
`retry-after` (float seconds, or an RFC 1123 date relative to now) gives
`hint`; the delay is `hint` when `hint > 0` and (`hint < 60 s` or `hint <
backoff`), otherwise the exponential backoff. Adapters never retry
internally (Go disables SDK retries: a 500 with `maxAttempts: 1` reaches
the server exactly once).

`normalizeProviderError(outerSignal, model, err)` maps any error that
escapes the agent loop, in this order:

1. `outerSignal.aborted` -> return `outerSignal.reason` (caller
   cancellation passes through untouched).
2. `err` is an abort or timeout (request timeout, work-deadline-bounded
   call) -> `ErrEndpoint` with message
   `llm: inference endpoint failure: <model>: <err message>`, keeping the
   timeout as `cause` (pinned: a request timeout is an endpoint failure that
   still identifies as a deadline).
3. `err` already is `ErrAuth`, `ErrEndpoint`, or `ErrBudgetExhausted`
   (ledger area) -> unchanged.
4. `err` carries HTTP status 401 or 403 anywhere in its cause chain ->
   `ErrAuth`: `llm: authentication failed: <err message>; check the
   configured API key`.
5. Otherwise -> `ErrEndpoint` as in step 2.

Sentinel kinds (Go `errors.go`) become error classes with a `kind` field
so callers test `err instanceof AuthError` or walk `cause`:
`ErrNoFinalCall` (`llm: tool loop ended without a final tool call`),
`ErrWorkDeadline` (`llm: work deadline reached`), `ErrAuth`
(`llm: authentication failed`), `ErrEndpoint`
(`llm: inference endpoint failure`). The first two are raised by the agent
loop; they are defined here so the whole `llm` error vocabulary lives in
one module.

### 2.11 Raw response capture

When `captureResponse` is configured, every 2xx response of every attempt
is captured as:

```ts
interface RawResponse {
    role:string         // client role
    protocol:string     // "chat" | "responses" | "anthropic"
    model:string
    contentType:'application/json'|'text/event-stream'
    body:Uint8Array     // exact bytes, no request, no headers
}
```

Rules (`maxCapturedResponseSize = 16 MiB = 16 << 20` bytes):

1. Non-2xx responses are never captured. With no callback, nothing is
   captured or buffered.
2. If `Content-Length` exceeds 16 MiB, cancel the body and fail
   `capture <role> provider response: body exceeds 16777216-byte limit`.
3. Media type (parameters stripped, lowercased) `text/event-stream`:
   streaming capture. Do not read eagerly: the SSE parser pulls chunks,
   and each chunk is appended to the capture buffer as it is read. If a
   chunk would take the buffer over 16 MiB, fail with the size message;
   the callback is not called. When the adapter is done with the body
   (terminal event, error, abort, or EOF) it releases the body exactly
   once and then calls the callback with the bytes read so far, partial
   streams included (an interrupted stream's bytes are captured and the
   retry's stream is captured separately).
4. Any other media type: read the whole body with a 16 MiB + 1 limit,
   fail on overflow with the size message, fail if the bytes are not valid
   JSON with `capture <role> provider response: <model> returned invalid
   raw JSON`, else call the callback with `contentType:
   'application/json'`, then parse the bytes as SSE as usual (a JSON body
   yields no events and ends as an incomplete stream).
5. A callback failure fails with `capture <role> provider response:
   <callback error message>`.
6. Every capture failure is a `CaptureError`: permanent, never retried
   (pinned: one HTTP request with `maxAttempts: 3`), and sticky. After the
   first capture failure the client refuses every later request with the
   same error without contacting the server.
7. Ordering: the adapter resolves a turn only after the body has been
   released and the capture callback has succeeded, so no tool call from a
   response is dispatched before that response is in the run record. A
   capture failure discovered at release replaces any turn result.
8. Each in-flight request owns its own body and capture buffer; concurrent
   verifier calls on one client never share them.

### 2.12 Request timeout and cancellation

- The agent loop composes each request's signal from the caller's signal,
  the work-deadline bound (before the deadline fires) or the wrap-up window
  (after), and `AbortSignal.timeout(requestTimeout)` when
  `requestTimeout > 0` (CLI default 10 minutes; `doctor` uses 15 s).
- The timeout covers the whole request: connect, headers, and reading the
  full stream.
- An abort fails the call immediately (pinned: a 10 ms timeout returns
  within one second) and is never retried; the composed reason is rethrown
  (2.10 kind 5).
- After the stream loop the adapter re-checks the signal: a turn that
  completed while the signal fired is reported as the abort, not as a turn.

### 2.13 Provider quirks (summary)

- **DeepSeek** (chat and its Anthropic-compatible endpoint): thinking mode
  rejects any forced `tool_choice` (400 `Thinking mode does not support
  this tool_choice`), so choice is always `auto`; every earlier assistant
  message must replay `reasoning_content` (chat) or start with its
  `thinking` block (anthropic), which 2.6.1 and 2.6.3 guarantee;
  `insufficient_system_resource` maps to `error` and suppresses tool calls;
  a reasoning-only response with `length` finish is not retried (the agent
  loop reports it naming the model, `finish reason "length"`, and the
  `max_output_tokens` hint once).
- **OpenRouter**: `chat` at `/api/v1/chat/completions`; reasoning arrives as
  `reasoning` and is treated like `reasoning_content`; `:` comment lines
  are keepalives.
- **OpenAI reasoning models** on chat: `max_completion_tokens` (2.6.1).
- **Anthropic**: base URL `/v1` trimming, no redirects, `X-Api-Key` only,
  full `input_schema`, signed thinking replay.
- **Claude 5.1+ signed thinking**: blocks are bound to the system prompt,
  tool set and every earlier block; the adapter's job is byte-faithful
  replay of what it received (text, signature, order). Keeping the prefix
  stable across injected messages is the agent loop's job.

## 3. TypeScript module design

Directory `src/llm/` (shared with the agent-loop area, which owns
`agent.ts`, `ledger.ts`, and the retry loop). Files owned by this area:

| module                 | kind      | contents                             |
|------------------------|-----------|--------------------------------------|
| `types.ts`             | types     | protocol-neutral request/turn types  |
| `errors.ts`            | pure      | errors, retryability, delays     |
| `sse.ts`               | pure      | lazy SSE parser                      |
| `usage.ts`             | pure      | stage 1 + stage 2, accumulator   |
| `models.ts`            | pure      | model-ID rules (2.6)             |
| `chat.ts`              | pure      | chat request encoder and stream decoder |
| `responses.ts`         | pure      | responses encoder and decoder        |
| `anthropic.ts`         | pure      | anthropic encoder and decoder        |
| `capture.ts`           | shell     | body ownership, cap, sticky gate |
| `http.ts`              | shell     | swappable `fetch`, headers, redirects |
| `json.ts`              | pure      | tool-result JSON encoder, text decode |
| `session.ts`           | shell     | `newSessionId()`                     |
| `client.ts`            | shell     | `createModelClient`, `send`          |

Encoders and decoders are pure: an encoder maps `(config, request)` to
`{url, headers, body}` without session or credential headers; a decoder
consumes an `AsyncIterable<SseEvent>` and returns a `ModelTurn` or throws.
This keeps every wire contract testable without sockets.

### 3.1 Types (`types.ts`)

```ts
export type Protocol = 'chat'|'responses'|'anthropic'

export interface ClientConfig {
    role:string
    baseUrl:string
    apiKey:string
    model:string
    protocol:''|Protocol
    maxOutputTokens:number
    maxAttempts:number          // <= 0 -> 4 (DEFAULT_MAX_ATTEMPTS)
    requestTimeoutMs:number     // 0 disables
    sessionHeader?:string
    captureResponse?:(raw:RawResponse) => Promise<void>|void
}

export interface ToolDefinition {
    name:string
    description:string
    schema:Record<string, unknown>   // complete caller JSON Schema
}

export type AssistantPart =
    | { type:'text', text:string }
    | { type:'reasoning', text:string, signature?:string,
        redactedData?:string }
    | { type:'tool-call', id:string, name:string, input:string }

export interface ToolResult {
    callId:string
    name:string
    output:string
    isError:boolean
}

export type ConversationItem =
    | { role:'user', text:string }
    | { role:'assistant', parts:AssistantPart[] }
    | { role:'tool', results:ToolResult[] }

export interface ModelRequest {
    system:string
    items:ConversationItem[]
    tools:ToolDefinition[]
    sessionId:string
    signal:AbortSignal            // already composed by the agent loop
    onUsage?:(usage:Usage) => void
}

export type FinishReason =
    'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other'|'unknown'

export interface ModelTurn {
    parts:AssistantPart[]         // arrival order, replay verbatim
    finishReason:FinishReason
    rawFinishReason?:string
    usage:Usage                   // normalized, calls: 1
}

export interface Usage {
    uncachedInputTokens:number
    cachedInputTokens:number
    cacheWriteTokens:number
    outputTokens:number
    calls:number
}

export interface RawResponse {
    role:string
    protocol:Protocol
    model:string
    contentType:'application/json'|'text/event-stream'
    body:Uint8Array
}
```

Tool-call `input` is always the raw argument string as received (chat,
responses) or as accumulated (anthropic). The agent loop parses and
validates it; adapters never repair JSON.

### 3.2 Adapter interface consumed by the agent loop (`client.ts`)

```ts
export interface ModelClient {
    readonly config:Readonly<ClientConfig>
    readonly protocol:Protocol           // '' normalized to 'chat'
    readonly maxAttempts:number          // normalized
    // One HTTP attempt. Never retries. Resolves only after capture
    // succeeded. Rejects with the kinds in 2.10.
    send(request:ModelRequest):Promise<ModelTurn>
    // Accumulated usage across all calls on this client.
    usage():Usage
}

export function createModelClient(config:ClientConfig):ModelClient
```

`send` steps:

1. If the client's capture gate holds a failure, reject with it.
2. Encode with the protocol encoder; add credential, `User-Agent`,
   `Anthropic-Version` (anthropic), then `X-Agent-Session-Id` and
   `sessionHeader` set to `request.sessionId`.
3. `fetch` through `http.ts` with `request.signal` and `redirect:
   'manual'` for every protocol.
4. Non-2xx (including any 3xx): read at most 32 KiB of the error body,
   reject with an HTTP error (2.10).
5. 2xx: open the body through `capture.ts` (2.11), run the SSE parser
   lazily over it, and feed the protocol decoder.
6. When the decoder sees the terminal finish, compute usage, add it to the
   client total and call `request.onUsage` once.
7. Release the body (cancel the reader if not at EOF) and run the capture
   callback; a capture failure latches the gate and rejects.
8. If `request.signal.aborted`, reject with `signal.reason`.
9. Resolve the `ModelTurn`.

### 3.3 Obligations the agent loop keeps (cross-reference)

Stated here so the boundary is unambiguous; specified in the agent-loop
area:

- Dispatch tool calls only from turns whose finish is `stop` or
  `tool-calls`; every other finish ends the attempt with a stop cause
  (`responses` may still return tool-call parts on length/content-filter).
- Mint one session ID per conversation; pass the same tool list on every
  turn; replay each `ModelTurn.parts` verbatim as an assistant item.
- Retry with `isRetryable(err)` and `retryDelayMs(err, backoffMs)` up to
  `maxAttempts`; never retry `CaptureError` or aborts.
- Compose the request signal (2.12) and map escaped errors with
  `normalizeProviderError`.

### 3.4 Errors (`errors.ts`)

```ts
export class LlmError extends Error { kind:string }
export class AuthError extends LlmError {}         // ErrAuth
export class EndpointError extends LlmError {}     // ErrEndpoint
export class NoFinalCallError extends LlmError {}  // agent loop
export class WorkDeadlineError extends LlmError {} // agent loop

export class ProviderError extends Error {
    status?:number
    headers?:Record<string, string>   // lowercased names
    providerType?:string
    retryable:boolean
}
export class IncompleteStreamError extends ProviderError {}
export class CaptureError extends Error {}         // permanent

export function isRetryable(err:unknown):boolean
export function retryDelayMs(err:unknown, backoffMs:number,
    now?:number):number
export function errorStatus(err:unknown):number|undefined // walks cause
export function normalizeProviderError(outer:AbortSignal, model:string,
    err:unknown):unknown
```

`isRetryable`: false for aborts (`AbortError`, `TimeoutError`, or the
composed signal's reason) and `CaptureError`; `ProviderError.retryable`
when present; true for transport errors (`TypeError` from `fetch` with a
network `cause`, `UND_ERR_*` socket errors, `ECONNRESET`, `ECONNREFUSED`,
`ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EPIPE`, premature close); false
otherwise.

### 3.5 Other modules

- `sse.ts`: `parseSse(chunks:AsyncIterable<Uint8Array>):
  AsyncGenerator<{event:string, data:string}>`. Pull-based; never buffers
  more than the current chunk plus a partial line.
- `capture.ts`: `class CaptureGate { failure?:CaptureError }` per client;
  `openCapturedBody(response, config, gate):{chunks, release()}` where
  `release()` is idempotent, cancels the reader, then invokes the callback
  for SSE bodies. Non-SSE bodies are read, validated and captured inside
  `openCapturedBody` before `chunks` yields.
- `http.ts`: `let fetchImpl:typeof fetch = globalThis.fetch` plus
  `setFetch(f)` / `resetFetch()` for tests (the TS equivalent of Go's
  `redirectDefaultTransport`, shared with the login and doctor areas).
- `json.ts`: `encodeToolResult(value:unknown):string`, the one encoder for
  tool results sent to models (this area owns it; other areas import it).
  It sorts object keys (code-unit order, matching Go's map ordering) and
  does not HTML-escape `<`, `>`, `&` or U+2028/U+2029.
  `decodeModelText(bytes:Uint8Array):string` decodes UTF-8 and replaces
  lone surrogates with U+FFFD. Tool arguments the agent loop decodes match
  keys exactly (case-sensitive) and treat `null` as absent.
- `session.ts`: `newSessionId():string` using `crypto.getRandomValues`
  over 16 bytes encoded as unpadded base32 (26 characters) behind
  `roast-`.
- `models.ts`: `isChatReasoningModel(id)`, `responsesSystemMode(id):
  'system'|'developer'|'remove'`, `anthropicDefaultThinking(id)`.

Dependencies: none on other Roast areas except the version constant
(build-time define). The config area supplies `ClientConfig` values;
the agent-loop and doctor areas consume `ModelClient`; the record area
supplies `captureResponse`.

Debug tracing (`roast:llm`): request URL host and path, protocol, model,
status, attempt outcome, finish reason, usage numbers, byte counts. Never
bodies, headers, prompts, keys, or session IDs' pairing with bodies.

## 4. Deliberate changes

- Raw `fetch` replaces Fantasy and the provider SDKs (settled decision).
  Consequences, none observable by Roast's contract: the incidental SDK
  headers (`X-Stainless-*`, `Idempotency-Key`, SDK `Accept`) are no longer
  sent; the ambient-environment stripping in Go's `sdkenv.go` becomes
  unnecessary because nothing reads the environment.
- Debug tracing via `@substrate-system/debug` namespace `roast:llm`, with
  no bodies, headers, prompts or credentials.
- Windows is unsupported (no effect on this area).
- spec.md deliberate changes applying here: 7 (exact JSON key match, `null`
  means absent), 8 (every redirect refused), 9 (error bodies capped at 32
  KiB), 13 (cached tokens subtracted once), 14 (chat usage kept across
  chunks without usage), 21 (Anthropic tools carry the full schema).
- No proxy library is bundled: the README documents `NODE_USE_ENV_PROXY=1`
  and `NODE_EXTRA_CA_CERTS`, and `doctor` warns when `HTTPS_PROXY` is set
  without `NODE_USE_ENV_PROXY` (cross-cutting "Network"). Adapters still
  read no environment variable.

No other behavior changes; `claude-mythos-preview` keeps its default
adaptive thinking (parity).

## 5. Test plan

Seams: (C) CLI in-process `run(argv, io)` against a `node:http` fake
inference server, asserting requests received, exit codes, JSON output and
run-record files; (A) `createModelClient(...).send()` against a
`node:http` fake, used where the CLI cannot reach the behavior at
reasonable cost (byte-level capture, concurrency, sticky failure); (U)
pure unit tests for the SSE parser, usage normalization and encoders.
A shared fixture writer ports `testutil.WriteInferenceStream`: from a
complete response object it emits the native SSE sequence for each
protocol (chat chunks plus `[DONE]`; responses events with
`sequence_number`; anthropic `message_start` ... `message_stop`).

Wire shape and headers:

- Anthropic posts to `<base>/v1/messages` after `/v1` trimming, sends
  `X-Api-Key`, a non-empty `Anthropic-Version`, `system`, `stream: true`,
  the same tools on the wrap-up turn, the full `input_schema` including
  `additionalProperties`, and the injected notice in the second request
  (`TestAnthropicAgentUsesNativeMessages`) (C).
- Anthropic `max_tokens` equals the profile budget for 1024 and 32768
  (`TestAnthropicNativeMessagesPreservesOutputBudget`) (C).
- Anthropic and structured calls use `tool_choice.type == "auto"`
  (`TestAnthropicCompleteStructuredUsesAutomaticToolChoice`) (C).
- Responses replays `function_call_output`, sends `store: false`, no
  `previous_response_id`, `tool_choice: "auto"`, identical tools on the
  final turn (`TestResponsesAgentReplaysToolOutputAndKeepsToolsOnFinalTurn`)
  (C).
- Tool schemas reach each protocol with `additionalProperties` and nested
  `required` lists intact
  (`TestToolSchemasCarryRequiredFields`) (C).
- `User-Agent` is `roast/<version>` (`TestUserAgentIncludesBuildVersion`)
  (U on the header builder).
- Chat `max_completion_tokens` for reasoning-model IDs, `max_tokens`
  otherwise; responses system mode by model (no Go test; new) (U).

Ambient environment and credentials:

- For each protocol and each env scenario (provider keys, auth token,
  explicit and fallback Anthropic profile, federation, custom headers),
  only the configured endpoint is called, once, with only Roast headers
  (`TestProvidersIgnoreAmbientSDKEnvironment`) (C).
- Blank or whitespace key fails construction
  (`TestNewRejectsMissingAPIKey`) (A).
- Anthropic 401 maps to `AuthError`
  (`TestAnthropicMapsAuthenticationFailure`) (C, exit code and JSON).
- A 3xx from any protocol (`chat`, `responses`, `anthropic`) is not
  followed, the target sees no key, and the error is an `EndpointError`,
  not retried (`TestAnthropicDoesNotForwardCredentialsThroughRedirect`,
  extended) (A).
- An error body larger than 32 KiB is read only up to 32768 bytes (new)
  (A).

Session identity:

- Two concurrent conversations get distinct `roast-` IDs, stable across a
  retry and two turns, mirrored into `session_header`
  (`TestProviderConversationIdentity`,
  `TestStructuredCorrectionsRetainConversationIdentity`) (A).
- Session header set once each, never duplicated; with the environment
  naming the header it still carries Roast's value
  (`TestSessionTransportDoesNotMutateRequests`,
  `TestSessionHeaderOverridesEnvironmentHeader`) (A).

Capture:

- Callback failure: one HTTP request despite `maxAttempts: 3`, error
  names the callback error (`TestCaptureFailureDoesNotRetryProviderCall`)
  (C via a run-record write failure, or A).
- `Content-Length: 16777217` fails with the size error
  (`TestCaptureRejectsOversizedProviderResponse`) (A).
- Invalid JSON 2xx body fails once, not retried
  (`TestCaptureDoesNotRetryInvalidJSONResponse`) (A).
- Streaming capture does not read ahead, preserves exactly the bytes read,
  releases the body once (`TestStreamCaptureDoesNotEagerlyReadAndPreserves
  PartialBytes`) (A with a controlled `ReadableStream`).
- No `Content-Length`: overflow fails, callback not called, buffer never
  exceeds the cap (`TestStreamCaptureEnforcesLimitWithoutContentLength`)
  (U on `capture.ts`).
- Interrupted Anthropic stream (no `message_stop`) is retried, its partial
  tool never runs, all three streams are captured, usage counts only
  completed calls
  (`TestAnthropicInterruptedStreamRetriesWithoutExecutingPartialTools`)
  (C, run-record raw responses).

Retries and errors:

- A 500 with `maxAttempts: 1` reaches the server once for chat and
  responses (`TestChatRetriesOnlyThroughFantasy`,
  `TestResponsesRetriesOnlyThroughFantasy`) (C).
- Request timeout yields `EndpointError` caused by a timeout within one
  second (`TestInferenceRequestTimeoutIsEndpointFailure`) (A).
- Classification table: 408/409/429/5xx/`x-should-retry` retryable,
  401/403/3xx/400 not, transient stream types, incomplete stream,
  transport errors, aborts (new) (U).
- `retryDelayMs` with `retry-after-ms`, `retry-after` seconds and date,
  out-of-range hints (new) (U).

Usage:

- Anthropic accumulation 20/6/4/8/2 (from
  `TestAnthropicAgentUsesNativeMessages`) (C via `meta.json`).
- Stage 2 on 8/4/1/3 -> 8/4/1/3 (`TestGenericUsageAccounting`, updated)
  (U).
- Chat and responses from fixture usage objects: `prompt_tokens: 100,
  cached_tokens: 30` -> uncached 70, cached 30; cached 80 -> 20 and 80 (new)
  (U).
- A chat chunk without usage after a chunk with usage keeps the earlier
  usage (new) (U).
- `encodeToolResult` sorts keys and leaves `<>&` and U+2028 unescaped; a
  lone surrogate in model output decodes to U+FFFD (new) (U).

DeepSeek and finish reasons:

- Forced tool choice never sent on chat or anthropic in any phase
  (`TestDeepSeekThinkingModeUsesAutomaticToolChoice`,
  `TestDeepSeekFixtureRejectsForcedToolChoice`) (C with a port of
  `deepSeekThinkingServer`, which also rejects missing
  `reasoning_content` / leading `thinking` replay).
- Signed thinking prefix replay accepted by a binding fixture that rejects
  any changed prefix (`TestAnthropicReplayKeepsSignedThinkingPrefix`,
  `TestBindingServerRejectsChangedPrefix`) (A or C with a port of
  `bindingServer`).
- `insufficient_system_resource` -> `error`, `content_filter` ->
  `content-filter`, unknown -> `unknown`, each with the raw reason exposed
  (`TestAbnormalFinishNamesTheProviderReason`) (C).
- Reasoning-only `length` finish is one request
  (`TestReasoningOnlyLengthFinishNamesTheCeiling`) (C).

SSE parser (U, new): CRLF/CR/LF, multi-line data, comments, missing final
blank line, chunk boundaries inside a line and inside a UTF-8 sequence,
laziness (no read beyond the requested event).

Live tests (opt-in, never CI): `ROAST_LIVE_ANTHROPIC_API_KEY`
(`_BASE_URL`, `_MODELS`), `ROAST_LIVE_DEEPSEEK_API_KEY` (`_BASE_URL`,
`_MODEL`, `_PROTOCOL`) two-turn reviews and the DeepSeek reasoning ceiling
(`TestLiveAnthropicTwoTurnReview`, `TestLiveDeepSeekTwoTurnReview`,
`TestLiveDeepSeekReasoningCeiling`).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/llm/provider.go` (client construction, capture transport,
  usage normalization, `normalizeProviderError`, `errorStatus`)
- `internal/llm/sdkenv.go`, `internal/llm/errors.go`, `internal/llm/llm.go`
  (`Usage`, `Client`)
- `internal/llm/agent.go` (`managedModel.Stream`, `streamCall`, tool
  schema restoration, auto tool choice, session context, retry wiring)
- `internal/config/provider.go`, `internal/config/config.go`
  (`DefaultBaseURL`, `validateSessionHeader`), `internal/cli/cli.go`
  (`clientConfig`, request-timeout default), `internal/cli/doctor.go`
  (`doctorRoundtripCheck`)
- `internal/testutil/inference.go` (SSE fixture writer)
- Tests: `internal/llm/provider_test.go`, `ambient_env_test.go`,
  `anthropic_budget_test.go`, `deepseek_test.go`, `session_test.go`,
  `stream_capture_test.go`, `stream_test.go`, `thinking_binding_test.go`,
  `tool_schema_test.go`, `agent_test.go` (usage, timeout), `live_test.go`;
  `internal/cli/init_test.go` (`providerServer` routes)
- Fantasy `charm.land/fantasy@v0.48.0`: `retry.go`, `errors.go`,
  `providers/openai/language_model.go`, `language_model_hooks.go`,
  `responses_language_model.go`, `reasoning.go`,
  `providers/openaicompat/language_model_hooks.go`, `provider_options.go`,
  `providers/anthropic/anthropic.go`, `error.go`; openai-go
  `packages/ssestream`; anthropic-sdk-go v1.84.0 `packages/ssestream`,
  `messageutil.go` (`Accumulate`), `internal/requestconfig`.

## 7. Resolved

1. Cached tokens are subtracted once for `chat` and `responses` (spec.md
   deliberate change 13); stage 2 no longer subtracts (2.9).
2. Every HTTP redirect is refused as an endpoint error for all protocols
   (spec.md deliberate change 8; `redirect: 'manual'`, 2.5).
3. No proxy library is bundled; README documents `NODE_USE_ENV_PROXY=1` and
   `NODE_EXTRA_CA_CERTS`; doctor warns on `HTTPS_PROXY` without
   `NODE_USE_ENV_PROXY` (spec.md cross-cutting "Network").
4. Anthropic tool definitions carry the full JSON schema, including
   `additionalProperties` (spec.md deliberate change 21).
5. A chat chunk without usage keeps the last reported usage (spec.md
   deliberate change 14).
6. Provider error bodies are read at most 32 KiB (spec.md deliberate change
   9).
7. `claude-mythos-preview` keeps default adaptive thinking (spec.md
   "Further Notes", parity).
