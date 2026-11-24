# 14: Agent loop and token ledger

**Blocked by:** 13
**Touches:** `src/llm/agent.ts` (`runConversation`, `NUDGE_TOOL_NAME`,
`DEFAULT_MAX_TURNS`, `DEFAULT_INPUT_BYTE_CEILING`,
`DEFAULT_WRAP_UP_WINDOW`, `DEFAULT_MAX_ATTEMPTS`), `src/llm/review.ts`
(`reviewResponse`), `src/llm/ledger.ts` (`Ledger`, `newLedger`,
`reserve`, `weightedTokens`), `src/llm/deadline.ts` (`WorkDeadline`),
`src/llm/final-args.ts` (`parsePreservingIntegers`, `checkRequired`,
`typeValidate`), `src/llm/retry.ts` (`withStepRetry`), `src/llm/messages.ts`
(`transcriptBytes`), `src/llm/errors.ts` (cutoff errors, `cutoffError`),
`src/llm/types.ts` (`TurnInfo`, `FinalSpec`, `ConverseOptions`,
`Client`, record `Usage`), `src/llm/client.ts` (`createClient`);
`test/llm/agent-*.ts`, `test/llm/ledger.ts`, `test/index.ts`
**Spec:** `spec/07-agent-loop.md` all sections; `spec/06-llm-protocols.md`
section 3.3 (obligations the loop keeps); `spec.md` deliberate changes 7
and 13, cross-cutting "JSON encoding", "Process lifetime"
**Status:** done

## What to build

Roast's own agent loop (no framework), preserving every Go invariant in
spec 07 section 2: the transcript, turn preparation, processing one
complete response, validating and dispatching tool calls (sequential, in
call order; unknown tools answered with an error result; prose answered
with the nudge tool), the work deadline and the reserved wrap-up window
with the in-step switch, forced wrap-up notices, stop conditions and
callbacks (`onTurn`, `onWorkDeadline`, `onBudgetExhausted`), step retries
(`withStepRetry`, never retrying aborts, `CaptureError`, or cutoffs), one
session ID per conversation, the token ledger with its final allowance,
usage accounting, schema validation of the final tool call
(required fields, then type validation through `FinalSpec.decode`, with
integers outside the safe range preserved as `bigint`), and error
precedence with sentinels and `details`.

`createClient` in `src/llm/client.ts` wraps a ticket 13 `ModelClient`
into the `Client` the finder and verifier call: `converse` (tools plus a
final tool) and `completeStructured` (a single structured call), both
implemented by `runConversation`, plus `usage()` returning the
snake_case record shape (`uncached_input_tokens`, `cached_input_tokens`,
`cache_write_tokens`, `output_tokens`, `calls`) mapped from ticket 13's
camelCase `Usage`.

Seam resolution 6: spec 07 section 3.1 assumes a streaming
`ProtocolAdapter`. Use ticket 13's interface instead: `send(request)`
resolves one complete `ModelTurn` (the loop never acts on partial output
anyway), `requestBytes(request)` gives the body size for the ledger
(`reqBytes` = that length + 2048, spec 07 Resolved 2), and the call
signal composed by `WorkDeadline.callSignal` is passed as
`request.signal`. Map spec 07's `StreamEvent` / `FinishCategory` /
`RawUsage` names onto ticket 13's `ModelTurn` parts, `FinishReason`, and
normalized usage. Cutoff errors (`no-final-call`, `work-deadline`,
`budget-exhausted`) are added to ticket 13's `src/llm/errors.ts`, with
the cutoff cause kept out of the matchable chain (spec 07 section 2.14);
there is no second errors module and no second JSON encoder (tool results
go through `encodeToolResult`).

Test seam: a scripted fake adapter implementing ticket 13's `ModelClient`
interface (canned turns, or a function of the request), with injected
`now`, `sleep`, and `sessionId`. The `[HTTP]` items in spec 07 section 5
that need the `chat` protocol run here against ticket 13's fake inference
server; the Anthropic-only ones land in ticket 28.

Out of scope: building finder or verifier tools and final specs (tickets
16, 21), constructing the ledger from config limits (ticket 20).

## Acceptance criteria

Assert on sentinels (`hasSentinel`), `LlmError.details`, call counts,
requests received, and tool invocations, never on message text.

- [x] A valid submission ends finalization in one call whether the final
  phase came from the turn budget, a budget refusal, or the deadline;
  every final-phase request uses automatic tool choice and still offers
  the final tool.
- [x] In the final phase, an exploration call, an unknown tool, or prose
  gets a reminder, the exploration tool never runs, and the next valid
  submission succeeds.
- [x] A model that never submits stops after exactly `maxAttempts`
  final responses with `no-final-call`, for `converse` and
  `completeStructured`.
- [x] After a budget or deadline cutoff there is one wrap-up call and no
  reminders; the error carries the cutoff sentinel and `no-final-call`.
- [x] Invalid submissions and prose share one allowance; a schema
  failure followed by prose ends with `no-final-call`, not the stale
  schema error.
- [x] A reminder needs ledger admission: usage that spends the budget
  makes the next reminder fail with `budget-exhausted` and
  `no-final-call` after one call.
- [x] Caller cancellation during a reminder surfaces as the caller's
  abort reason.
- [x] A final call missing a required property is never accepted and is
  bounded by `maxAttempts`; a required-field rejection during
  exploration does not consume final-phase attempts.
- [x] An invalid final submission is retried with validation feedback in
  the next request and the corrected one is returned; a provider failure
  after a provisional schema rejection is reported as `endpoint`;
  persistently malformed final arguments end with
  `details.stopCause` = invalid arguments.
- [x] `{"id":9007199254740993}` reaches the caller exactly.
- [x] Record-only wrap-up rounds do not spend submission attempts but are
  bounded: with `maxAttempts: 1`, two calls and two records, then
  `no-final-call` with `details.recordRounds === 2`.
- [x] A deadline passing during a wrap-up record tool lets the record
  finish, fires `onWorkDeadline`, opens no further call, and ends with
  `work-deadline` and `no-final-call`; after the deadline record tools
  still run and no second call is made.
- [x] An exploration call cut by the work deadline is replaced in the
  same turn by a wrap-up call under a fresh window, and its submission
  succeeds; a failed wrap-up call after the deadline is not retried even
  with `maxAttempts: 3`.
- [x] A tool call buffered before an abort is never dispatched: with a
  request timeout the run fails `endpoint` after one call; with a work
  deadline the wrap-up call keeps the full tool set and succeeds.
- [x] Prose during exploration gets a nudge result and continues; an
  unknown tool gets an error result, is reported once to `onTurn`, and
  the run recovers; several calls in one response run sequentially in
  call order; a final call suppresses exploration calls in the same
  response.
- [x] Finish reasons `length`, `content-filter`, `error`, and `unknown`
  never dispatch any tool, including a final call.
- [x] The complete caller schema, including
  `additionalProperties: false`, reaches the adapter.
- [x] A transient failure is retried once with `maxAttempts: 2`,
  honoring `retry-after-ms` through the injected `sleep`.
- [x] Budget refusal of the first exploration call (ledger limit 1500,
  `maxOutputTokens` 100) goes straight to one wrap-up call that
  succeeds, and `onBudgetExhausted` fires.
- [x] Aborting a call mid-flight aborts the request signal and returns
  the ledger's outstanding reservation to 0.
- [x] Ledger unit tests: `newLedger(0)` and negative limits give no
  ledger and unlimited admission; the final allowance is
  `min(100000, limit/2)`; a non-final reservation is refused exactly
  when `committed + outstanding + est > limit - max(allowance,
  est + out)`; a final reservation may use the whole limit; any refusal
  latches `exhausted()`; release is idempotent and reconciles cache
  reads at 0.1 weight with negative counts floored; `committed()`
  truncates.
- [x] Usage: chat prompt tokens 8 with 4 cached and output 3 give
  uncached 4, cached 4, write 0, output 3, calls 1 in `Client.usage()`.
- [x] [HTTP, chat] A truncated response's error names finish reason
  `length` in `details`; prose names the model and attempt count in
  `details`; a reasoning-only `length` finish is a no-submission error,
  not `endpoint`, after one request.
- [x] [HTTP, chat] One session ID per conversation, shared by all its
  requests, retries, and corrections, distinct across conversations;
  thinking-mode models get automatic tool choice.
- [x] Opt-in live tests under `test/live/` (entry `test/live/index.ts`,
  run by `npm run test:live`, never imported by `test/index.ts`, never
  run in CI): with `ROAST_LIVE_DEEPSEEK_API_KEY` (and optional
  `_BASE_URL`, `_MODEL`, `_PROTOCOL`) set, a two-turn review conversation
  completes, and the DeepSeek reasoning ceiling case holds (successors of
  `TestLiveDeepSeekTwoTurnReview`, `TestLiveDeepSeekReasoningCeiling`;
  area 06 section 5). Without the variables each live test skips.
- [x] `npm run lint`, `npm run typecheck`, and `npm run test:ts` pass, and
  the Go build and Go tests still pass.
