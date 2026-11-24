# Area 07: Agent loop, token ledger, deadlines and wrap-up

## 1. Purpose

Every model interaction in a review goes through one conversation engine:
the finder's exploration conversation, each verifier conversation, the
`doctor` probe, and every single-shot structured completion. This area
specifies that engine, independent of any wire protocol:

- the **agent loop**: a multi-turn tool conversation that ends when the
  model calls the role's **final tool** (for example `submit_findings`)
  with arguments that validate, and that returns those arguments as the
  conversation's result;
- the **structured completion**: the same loop with only a final tool and
  a one-turn budget;
- the **wrap-up turn**: the reserved last call in which exploration is
  over and the model is told to submit what it has, reached by turn
  exhaustion, the run's **work deadline**, or the **token ledger**;
- the **token ledger**: one per-run admission controller shared by the
  finder and verifier clients that reserves each call's worst-case token
  footprint before it is sent and always keeps enough headroom for the
  wrap-up submission;
- the error vocabulary callers use to tell a graceful cutoff (partial
  results) from an endpoint or credential failure.

Governing invariant: **no stop path may discard accumulated work**. The
budget and the deadline never cancel the wrap-up call; results the model
records early (record tools) always run, even after the cutoff.

Out of scope here (owned by the LLM protocols area): HTTP requests, the
three wire protocols, SSE parsing, raw response capture into run records,
session headers, ambient environment handling, and classifying a provider
error as retryable. This file assumes the adapter interface in section 3.

## 2. Behavior contract

### 2.1 Terms

- **Conversation**: one call to `converse` or `completeStructured`. It has
  a system prompt, one initial user message, a tool list, and a final tool
  name.
- **Turn**: one loop iteration that sends one request to the model and
  processes one complete response. `turn` is 1-based. A **step retry**
  (2.11) and an **in-step switch to wrap-up** (2.8) resend within the same
  turn; they do not increment `turn`.
- **Final tool**: the tool whose arguments end the conversation. It has
  no `run` function; its arguments are validated and returned.
- **Record tool**: a tool with `recordsResult: true`. It saves part of
  the result (the finder's `report_finding`) instead of exploring. It
  runs on the wrap-up turn and after the work deadline.
- **Exploration tool**: any other tool with a `run` function.
- **Nudge tool**: the synthetic tool `__roast_continue` that Roast always
  offers and that Roast itself "calls" to keep the loop going after a
  free-form response (2.6).
- **Final phase** (`finalTurn` flag): set once the loop is in wrap-up.
  It never resets within a conversation.
- **Cutoff**: the reason the final phase was forced by an external limit:
  `work-deadline` or `budget-exhausted`. At most one cutoff is recorded;
  the first one wins. Reaching `maxTurns` enters the final phase without
  a cutoff.
- **Submission attempt**: a final-phase response that is not record-only
  (2.7). Counted per complete response, including responses later
  rejected by required-field validation.
- `maxAttempts`: the client's `maxAttempts` setting if > 0, else **4**.
  It bounds three things: step retries (`maxAttempts - 1` retries per
  request), final-phase submission attempts, and record-only rounds.

### 2.2 Inputs

`ConverseOptions` (all optional unless stated):

| field | meaning | default |
| --- | --- | --- |
| `tools` | exploration, record, and final tools, in order (required) | |
| `finalTool` | name of the final tool; must be in `tools` (required) | |
| `maxTurns` | turn at which the final phase starts | `<= 0` -> 8 |
| `onTurn` | progress callback (2.10) | none |
| `inputByteCeiling` | bytes that trigger the input warning | `<= 0` -> 3e6 |
| `workDeadline` | absolute time (ms epoch) | none |
| `wrapUpWindow` | ms bound for wrap-up call, record tools | `<= 0` -> 90000 |
| `onWorkDeadline` | called once when the work deadline latches | none |
| `onBudgetExhausted` | called once when the ledger forces wrap-up | none |

Client settings used by the loop (resolved by the config and CLI
areas): from the role's inference profile, `model` (request model name,
also used in error messages), `maxOutputTokens` (`max_output_tokens`;
sent on every request and used by the ledger), and `protocol`; from the
run's `limits` (flag, then config, then default), `maxAttempts`
(`max_attempts`) and `requestTimeout` (`request_timeout`, ms per
request, 0 = none); and the run's shared `ledger` sized by
`--max-tokens-total` / `limits.max_total_tokens` (CLI default
3,000,000; an explicit 0 means no ledger). The CLI defaults
`max_attempts` to 4 and `request_timeout` to 10 minutes; the loop's own
fallback for `maxAttempts <= 0` is also 4.

If `finalTool` names no tool in `tools`, the call fails immediately,
before any request, with the plain error
`final tool "<name>" is not configured`.

### 2.3 Tool set sent to the model

- Every request in a conversation offers the **same** tool set: the
  caller's tools in caller order, then the nudge tool last. The set
  never narrows in the final phase (signed reasoning on Anthropic is
  bound to the tool set; see 2.12). The final phase is enforced through
  tool results instead.
- Each caller tool is sent with its **complete** JSON Schema exactly as
  supplied (including top-level keywords such as
  `additionalProperties: false`), deep-copied per request so an adapter
  cannot mutate the caller's copy. `required` lists stay arrays of
  strings.
- Nudge tool definition:
  - name `__roast_continue`
  - description `Continue the Roast tool loop after a free-form response.`
  - schema `{"type":"object","properties":{"message":{"type":"string"}},
    "required":["message"]}`
- Tool choice is always **automatic**. The loop never forces a tool
  choice: thinking-mode providers (DeepSeek, Claude with thinking) reject
  a forced choice. Finalization relies on the notice, validation, and
  bounded reminders.
- `completeStructured(system, user, schemaName, finalSpec)` is a
  conversation with exactly one tool: name `schemaName`, description
  `Return the requested structured result.`, schema = the result's JSON
  Schema (no `$schema`, no `$ref`/definitions, objects closed with
  `additionalProperties: false`), plus the nudge tool. It runs with
  `maxTurns: 1`, no deadline, and starts in the final phase (2.5).

### 2.4 Transcript

The transcript is append-only. Order of a request's messages: system
prompt, initial user message, then for each turn the assistant message,
its tool-results message, and any user messages Roast injected, each at
the position where it was first sent.

- The assistant message records exactly what the model produced, in
  arrival order: text, reasoning blocks (with any signature or opaque
  provider payload), and tool calls. Roast never edits, drops, or
  reorders model output. Synthetic nudge calls (2.6) are appended
  **after** the model's content.
- The tool-results message has one result per dispatched call, in the
  order the model called the tools (not completion order). A result is
  either a success text or an error text (`isError: true`).
- An injected user message (input warning, wrap-up notice) is appended
  once, when first needed, and keeps its position for the rest of the
  conversation; every later request, retry, and reminder resends it.

### 2.5 Turn preparation (before each turn's request)

In this order:

1. `turn += 1`.
2. **Input warning**: if `turn > 1`, the warning was not yet sent, and the
   transcript's byte size (2.13) exceeds `inputByteCeiling`, append once
   the user message
   `INPUT BUDGET EXHAUSTED. Do not request more files. Call \`<final>\`
   now with what you have \u2014 partial results beat none.`
   (one line; `\u2014` is an em dash in the actual string). This does
   **not** enter the final phase.
3. **Work deadline**: if the deadline check (2.8) reports fired, force the
   final phase with cutoff `work-deadline`.
4. **Turn budget**: if `turn >= normalizedMaxTurns`, force the final
   phase (no cutoff). So `maxTurns: 4` gives three exploration turns and
   makes turn 4 the wrap-up turn; `maxTurns: 1` starts in wrap-up.
5. **Wrap-up notice**: if in the final phase and no notice was sent yet,
   append the notice (2.9) as a user message and mark it sent. For a
   structured completion the notice is always
   ``Return the requested structured result via the `<final>` tool call.
   Do not answer in prose.``

### 2.6 Processing one complete response

A response is complete when the adapter delivered a finish event. Before
anything is dispatched:

1. Raw response capture (protocols area) must have succeeded; a capture
   failure fails the turn with a non-retryable error (2.11).
2. If the turn's signal was aborted (caller cancel, request timeout, work
   deadline), the turn fails with that abort; buffered tool calls are
   **never** dispatched.
3. No finish event (stream ended early) -> incomplete-stream error, which
   is retryable (2.11). Partial tool calls are never dispatched.

Then, by finish reason category (`stop`, `length`, `content-filter`,
`tool-calls`, `error`, `other`, `unknown`):

- **Abnormal finish** (anything but `stop` / `tool-calls`): nothing is
  dispatched, not even a final call; the conversation ends. Set
  `stopCause` = `the response ended with finish reason "<category>"`,
  then append ` (the provider sent "<raw>")` when the adapter supplied a
  raw provider reason that differs from the category, then, for `length`
  only, append `; raise max_output_tokens if the output was cut off`.
  A length finish is not retried.
- **`stop` or `tool-calls`**: run **review** below. Its outcome says which
  calls to dispatch (if any), which synthetic nudge calls to append, and
  whether the conversation continues.

**Review** (`stopCause` is cleared first). Let `calls` be the model's
tool calls in order, `final` the **last** call naming the final tool,
`records` the number of record-tool calls. Any call naming a tool that is
neither a caller tool nor the nudge tool is reported to `onTurn`
immediately (2.10).

A. Final phase, no final call, `records > 0`, and every call is a record
   call (**record-only round**): increment `recordRounds`. Submission
   attempts are **not** incremented. If finalization may not continue
   (2.8: a cutoff exists, after latching the deadline) -> set `halt` with
   stopCause ``the model recorded results but did not call `<final>`
   before the cutoff``. Else if `recordRounds > maxAttempts` -> set `halt`
   with stopCause ``the model kept recording results without calling
   `<final>` (<n> recording rounds)``. Dispatch all calls.

B. Otherwise, if in the final phase, `submissionAttempts += 1`.

C. A final call is present:
   - Every exploration call in this response gets the error result
     ``Not executed: this response also called `<final>`, which ends the
     run.`` and is not run. Record calls still run.
   - **Type validation** of the final arguments (2.7). If it fails, the
     loop is in the final phase, and another submission may be made
     (`canRetrySubmission`: finalization may continue and
     `submissionAttempts < maxAttempts`): this is a provisional
     rejection. Clear any earlier `finalErr`. Every final call in the
     response gets the error result ``your previous response was not
     valid JSON matching the schema: <err>. Call `<final>` again with
     valid arguments.`` Set stopCause
     ``the last `<final>` call did not match the schema``.
     Dispatch and continue.
   - Otherwise set `finalErr` to the validation error (or clear it on
     success). A failed validation here is terminal
     (`validationExhausted`): the final call gets the error result
     `<err>` and the conversation stops. This includes an invalid final
     call during exploration: it ends the run immediately, without a
     reminder.
   - On successful type validation, the final call becomes the accepted
     submission. Set stopCause ``the last `<final>` call did not pass
     tool-call validation`` (used only if required-field validation, 2.7,
     rejects it). Dispatch in order:
     - another final call that is not the accepted one (different call ID
       or different arguments text) gets the error result
       ``Not accepted: call `<final>` once per response.``;
     - the accepted call, if it passes required-field validation,
       completes the conversation: the result is the parsed arguments,
       its tool result text is the raw arguments string, and the loop
       stops after this response's dispatch;
     - a final call dispatched after the conversation already completed
       (for example a duplicate of the accepted call) gets
       `Already submitted.` and stops the turn.

D. Final phase, no final call (prose, exploration calls, or unknown
   tools, possibly mixed with record calls):
   - Exploration calls get the error result
     `Not executed: exploration is finished.`; record calls still run.
   - If `canRetrySubmission`: append a nudge call with ID
     `roast-final-<submissionAttempts>` and message
     ``Exploration is finished. Return the result via the `<final>` tool
     call, not prose or another tool.``; dispatch and continue.
   - Else set stopCause ``the model answered without calling
     `<final>` `` (no calls) or ``the model called other tools instead of
     `<final>` `` (some calls), then append
     ` (<n> submission attempt)` / ` (<n> submission attempts)` (singular
     exactly when n = 1). If `records > 0`, set `halt` and dispatch (the
     record calls run; everything else is blocked as above). Otherwise
     dispatch nothing; the conversation ends.

E. Exploration phase, `calls` non-empty: dispatch all calls normally.

F. Exploration phase, no calls (prose only): append a nudge call with ID
   `roast-nudge-<turn>` and message ``Results must be delivered via the
   `<final>` tool call. If you have enough context call it now; otherwise
   call an exploration tool.``; dispatch and continue.

The nudge tool's result is its `message` argument as success text. A
nudge counts as a dispatched call, so the turn continues.

### 2.7 Validating and dispatching tool calls

Dispatch is **sequential**, in the model's call order: one tool finishes
(or is abandoned, 2.8) before the next starts. Before a call is run it
passes **required-field validation** (applies to every tool, including
the final tool and the nudge tool):

- unknown tool -> error result
  `tool not found: <name>. Available tools: <n1>, <n2>, ...` (the caller
  tools then the nudge tool, comma-space separated);
- arguments are not a JSON object -> error result
  `invalid JSON input: <parse error>`;
- a top-level `required` property of the tool's schema is absent ->
  error result `missing required parameter: <name>` (first missing name
  in `required` order).

No repair of malformed arguments is ever attempted (Go disabled
Fantasy's JSON repair). A call that fails this validation is not run.
For the final tool this means no completion; the conversation continues
if the response continues (2.10), and the stop conditions bound it. This
validation does not consume anything beyond the submission attempt
already counted in review B.

**Type validation** of final arguments (review C) mirrors decoding the
JSON into the caller's typed result:

- the text must be valid JSON (else the error is `invalid JSON`);
- every property that is present must have a compatible type (a string
  where a string is expected, an integer where an integer is expected,
  and so on, recursively);
- property names match exactly (case-sensitive; deliberate change 7), so
  `Name` never satisfies `name`; a JSON `null` for any property counts as
  absent (Go parity), not as a type error;
- absent properties are allowed here (required-field validation catches
  top-level ones later); unknown properties are ignored;
- **integers are preserved exactly**: an integer beyond
  `Number.MAX_SAFE_INTEGER` (for example `9007199254740993`) must reach
  the caller unchanged, never rounded. Parse the arguments with a reviver
  that reads the literal source text and yields a `bigint` for unsafe
  integers; the result schema accepts `bigint` for 64-bit integer fields.

Running an exploration or record call:

- A blocked call (review C/D) returns its block message as an error
  result and is not reported to `onTurn`.
- A tool with no `run` gets the error result `{"error":"tool has no
  implementation"}` (as success text, see below).
- `run(args, signal)` receives the decoded argument object. If it throws
  or rejects, or its wait is cut short (2.8), the result value is
  `{"error": "<message>"}`.
- The result value is serialized as JSON and sent as **success** text
  (tool errors are data for the model, not error results). If
  serialization fails, send `{"error": "<serialization error>"}`. An
  `undefined` / `null` result serializes as `null`.
- Serialization uses the llm area's one JSON encoder (spec.md
  cross-cutting "JSON encoding"): object keys are sorted, matching Go's
  map ordering so prompts stay stable, and there is no HTML escaping of
  `<`, `>`, `&`, U+2028 or U+2029. Parity with Go is on parsed JSON, not
  bytes.

### 2.8 Work deadline and wrap-up window

The work deadline is a **latched clock check**, never a timeout around
the whole conversation (that would cancel the wrap-up turn along with the
work).

- `check()`: if already fired, return true. If there is no deadline or
  `now < deadline`, return false. Otherwise latch `fired = true`, call
  `onWorkDeadline` exactly once, and return true.
- Request signal for a model call: the caller's signal, combined with
  - before the latch, a timer that fires at the deadline (so an in-flight
    exploration call cannot run past it);
  - after the latch, a fresh `wrapUpWindow` timeout (so a stuck wrap-up
    cannot hang the run);
  - and, if `requestTimeout > 0`, a per-request timeout.
- **In-flight deadline**: if an exploration call (not final phase) fails
  for any reason, `check()` is true afterwards, and the caller's signal is
  not aborted (and the failure was not a capture failure), the loop forces
  the final phase with cutoff `work-deadline` and immediately sends the
  wrap-up call **within the same turn** (in-step switch, 2.9). The
  failed call is not retried.
- After every model call, `check()` runs (latching a deadline that passed
  during the call).
- **Exploration tool wait**: before running an exploration call, if
  `check()` is true, the call is not started and its result is
  `{"error":"llm: work deadline reached"}` (later calls of a multi-tool
  response short-circuit this way). Otherwise the tool runs with a signal
  bounded by the deadline (or unbounded with no deadline). The loop races
  the tool's promise against that signal: on abort it stops waiting,
  records the abort reason as the error, and abandons the promise (its
  outcome is ignored). Tools that spawn a process kill it on abort
  (spec.md "Process lifetime"), so an abandoned tool does not keep Node
  alive; the CLI also calls `process.exit` after flushing output.
  `check()` runs after either outcome.
- **Record tool wait**: always bounded by a fresh `wrapUpWindow` timeout
  from the caller's signal, before or after the deadline, so work
  reported at the cutoff is kept rather than interrupted.
- `mayContinueFinalization()`: run `check()`; if fired, force the final
  phase with cutoff `work-deadline`; return `cutoff === none`. After any
  cutoff the loop never sends a reminder and never opens a second wrap-up
  window: the wrap-up turn gets exactly one response.
- `canRetrySubmission()` = `mayContinueFinalization() &&
  submissionAttempts < maxAttempts`.

### 2.9 Forced wrap-up: notice text and in-step switch

Notice text, chosen when it is first sent (`<final>` is the final tool):

- cutoff `budget-exhausted`:
  ``TOKEN BUDGET EXHAUSTED \u2014 call `<final>` NOW with everything you
  have; partial results beat none.``
- cutoff `work-deadline` and the deadline latched:
  ``WORK DEADLINE REACHED \u2014 call `<final>` NOW with everything you
  have; partial results beat none.``
- otherwise (turn budget, or a `work-deadline` cutoff whose latch did not
  happen): ``Exploration budget exhausted \u2014 call `<final>` NOW with
  everything you have; partial results beat none.``
- structured completion: the structured notice in 2.5 replaces all of the
  above.

Each is one line in the actual string; `\u2014` is an em dash.

**In-step switch** (budget refusal of an exploration call, 2.13, or an
in-flight deadline, 2.8): set the final phase, append the notice if none
was sent yet, rebuild the request from the transcript (same tool set),
and send it as a final-phase call in the same turn. That response is
processed like any final-phase response (review B-D). The refused or
failed exploration request leaves no trace in the transcript.

### 2.10 Stop conditions, callbacks, and continuation

After each turn's dispatch, evaluate in order, short-circuiting:

1. the conversation completed (accepted final call);
2. `validationExhausted`;
3. `halt`;
4. final phase and `submissionAttempts >= maxAttempts`;
5. **deadline during finalization**: final phase and `check()` is true ->
   force cutoff `work-deadline` (if no cutoff yet) and, if `stopCause` is
   empty, set it to ``the work deadline passed before `<final>` was
   called``.

Stop if any is true. Otherwise continue only if this turn dispatched at
least one call (including nudges) and no result requested a stop (an
accepted final call or `Already submitted.`). A response that dispatches
nothing ends the conversation. After dispatch, if the caller's signal is
aborted, stop with the abort (2.14) instead of continuing.

`maxTurns` does not stop the loop by itself. The final phase is bounded
by submission attempts, record rounds, cutoffs, and the deadline.

Callbacks:

- `onTurn({turn, tool, args})` is called after each **dispatched**
  exploration or record call, whether it succeeded, failed, or was
  refused by the deadline. It is also called, during review, for each
  call to an unknown tool (nothing else would report it). It is never
  called for the final tool, the nudge tool, blocked calls, or calls that
  failed required-field validation. `args` is the decoded argument
  object, or `{"error": "args parse error: <message>"}` if the arguments
  do not parse as a JSON object. `turn` is the current turn number.
- `onWorkDeadline()`: exactly once, at the first latch (2.8). It fires
  even if the wrap-up submission then succeeds, so callers can mark
  coverage as partial.
- `onBudgetExhausted()`: at most once per conversation, when the ledger
  refuses an exploration call, or refuses a final-phase call while no
  cutoff is recorded yet. Fires even if the wrap-up then succeeds.

### 2.11 Step retries

Each turn's request (and each in-step wrap-up request) is retried when it
fails with a retryable error, up to `maxAttempts - 1` retries:

- Retryable (classified by the adapter): HTTP 408, 409, 429, any 5xx; an
  error flagged transient; a response header `x-should-retry` (any case)
  parsing as true; an unexpectedly ended stream (no finish event);
  network/transport errors (DNS, connection refused/reset, TCP timeout,
  HTTP/2 stream errors).
- Never retried: aborts (caller cancel, request timeout, deadline
  signal), capture failures, ledger refusals, any error after a cutoff
  in the final phase (2.14 wraps it into a cutoff error), and every
  other error.
- Delay: initial 5,000 ms, doubled after each retry. A `retry-after-ms`
  header (milliseconds, float) or else `retry-after` (seconds, float, or
  an HTTP date) replaces the delay when the parsed value is > 0 and
  (< 60 s or < the backoff delay). The wait aborts with the caller's
  signal.
- Each retry re-runs ledger admission (the previous reservation was
  released with zero usage) and resends the same transcript; any
  provisional state from the failed attempt is discarded.
- When retries are exhausted the error reports the last attempt's error
  (Go prefixed `retry error: `).
- `maxAttempts: 1` means no retries.

### 2.12 Signed reasoning and conversation identity

- Signed reasoning (Claude 5.1 and later) is bound to the system prompt,
  the tool set, and every earlier message. Hence: the tool set is
  constant (2.3), model output is replayed verbatim (2.4), corrections
  travel as tool results rather than edits, and injected messages never
  move.
- Each conversation gets a session ID `roast-<26 random characters from
  A-Z2-7>` (128 bits, base32), generated once per `converse` /
  `completeStructured` call and passed to the adapter for every request,
  retry, reminder, and correction of that conversation. Distinct
  conversations get distinct IDs. (The header itself is the protocols
  area's.)

### 2.13 Token ledger

One ledger per run, shared by the finder and verifier clients (concurrent
verifier conversations reserve against the same ledger). Units are
"input-equivalent tokens". Constants:

- `EST_BYTES_PER_TOKEN = 3` (conservative tokenization: code-heavy
  prompts run about 3 bytes/token, so this over-estimates, the safe
  direction for admission);
- `DEFAULT_FINAL_ALLOWANCE = 100_000`;
- `CACHED_TOKEN_WEIGHT = 0.1` (cache reads bill about 0.1x).

Construction: `newLedger(limit)` returns **no ledger** (unlimited) when
`limit <= 0`. Otherwise `finalAllowance = min(100_000, limit / 2)`
(floating point, not rounded). All arithmetic is floating point.
State: `committed`, `outstanding` (both start at 0), `exhausted` (false).

`reserve(reqBytes, maxOutput, final)`:

```
est = reqBytes / 3 + maxOutput
headroom = limit
if not final:
    headroom -= max(finalAllowance, est + maxOutput)
if committed + outstanding + est > headroom:
    exhausted = true
    refuse
outstanding += est
return release
```

The non-final hold-back covers this request's own footprint plus a
worst-case response, because the wrap-up call replays the same transcript
grown by this call's output; a smaller hold-back could admit exploration
the final flush can no longer afford. A final reservation may use the
whole limit.

`release(usage)` must be called exactly once per successful reservation;
extra calls are no-ops. It does `outstanding -= est` and
`committed += weighted(usage)` where
`weighted = max(uncached,0) + 0.1 * max(cached,0) + max(cacheWrite,0)
+ max(output,0)`. Each field is floored independently; cached may exceed
uncached legitimately and is never clamped against it.

`exhausted()` is true once any reservation was refused (final or not);
the verify stage reads it to stop launching verifications.
`committed()` returns `{spent: trunc(committed), limit: trunc(limit)}`
(`{0, 0}` with no ledger), for the run record's budget provenance.

With no ledger every reservation is admitted and release is a no-op.

**Admission in the loop.** Every model request is reserved immediately
before it is sent:

- `reqBytes` = the adapter-reported byte size of the serialized request
  body + 2048. (Go measured its internal transcript JSON plus the tool
  definitions JSON plus 2048.) Admission near the limit can therefore
  differ from Go (accepted, spec.md "Resolved open questions").
- `maxOutput` = the client's `maxOutputTokens`.
- `final` = the loop is in the final phase.
- Release with the normalized usage (2.15) when the response delivered a
  finish event, and with zero usage in every other outcome (error, abort,
  capture failure, early stop). Release happens on every path, exactly
  once.

On refusal:

- exploration request: force the final phase with cutoff
  `budget-exhausted`, fire `onBudgetExhausted`, and switch in-step to
  the wrap-up call (2.9). The refused request is not sent.
- final-phase request: if no cutoff is recorded yet, record
  `budget-exhausted` and fire `onBudgetExhausted`. The turn fails with
  the cutoff error ``...; no headroom for the wrap-up call: ...`` (2.14),
  not retried.

So a final-phase reminder is still subject to admission: after a
response whose reported usage spent the budget, the next reminder is
refused and the conversation ends with the budget cutoff.

**Transcript bytes** (for the input warning, 2.5): the UTF-8 byte length
of the JSON serialization of the transcript's messages, system prompt
included, tool definitions excluded.

### 2.14 Errors and result precedence

Sentinels (message texts are the Go texts):

| sentinel | message |
| --- | --- |
| `no-final-call` | `llm: tool loop ended without a final tool call` |
| `work-deadline` | `llm: work deadline reached` |
| `budget-exhausted` | `llm: run token budget exhausted` |
| `auth` | `llm: authentication failed` |
| `endpoint` | `llm: inference endpoint failure` |

`no-final-call` means finalization ran out of bounded attempts without a
valid submission: the finder reports incomplete coverage; the verifier
leaves the candidate unverified (never refuted). The CLI treats
`budget-exhausted`, `work-deadline`, and `no-final-call` as graceful.

**Cutoff error** `cutoffError(what, cause?)`: matches the cutoff sentinel
(or `no-final-call` if no cutoff) **and** `no-final-call`. Message:
`<cutoff sentinel message>; <what>: <no-final-call message>` followed by
`: <cause message>` when there is a cause. The cause contributes text
only; it is not matchable (a `budget-exhausted` cause inside a
`work-deadline` cutoff does not make the error match
`budget-exhausted`). The provider's own error text appears after the
generic sentinel, and the `no-final-call` text appears exactly once.

**Provider error normalization** `normalize(err)`:

1. caller's signal aborted -> the caller's abort reason, unwrapped;
2. err is an abort/timeout (for example `requestTimeout`) -> `endpoint`
   error `llm: inference endpoint failure: <model>: <err>`, keeping err
   as the cause (so a timeout stays detectable);
3. err already matches `auth`, `endpoint`, or `budget-exhausted` -> as is;
4. HTTP status 401 or 403 -> `auth` error
   `llm: authentication failed: <err>; check the configured API key`;
5. anything else -> `endpoint` error as in 2.

**Final-phase request failure after a cutoff** (the request fails and a
cutoff is recorded): the turn fails with
`cutoffError("wrap-up call failed", normalize(err))`, which is never
retried. A capture failure is reported unwrapped instead.

**Result precedence** when the loop ends:

1. accepted final call -> return the parsed result.
2. `finalErr` set -> error
   `<model>: <final> arguments did not satisfy the schema (<err>); if
   truncated, raise max_output_tokens`; if a cutoff is recorded, wrap it
   as `cutoffError("wrap-up submission was invalid", that)`.
   (`finalErr` is cleared on each provisional rejection, so an earlier
   schema failure never masks a later provider failure or a later
   missing submission.)
3. the loop failed with an error:
   - already a cutoff error (matches `no-final-call`) -> as is;
   - a cutoff is recorded -> `cutoffError("wrap-up turn failed", err)`;
   - otherwise `normalize(err)`.
4. no error: let `cause = "<model>: <stopCause>"` if stopCause is set.
   - cutoff recorded -> `cutoffError("wrap-up turn produced no
     submission", cause)`;
   - else `no-final-call` error `<no-final-call message>: <cause>`, or
     the bare `no-final-call` error without a cause.

Caller cancellation therefore surfaces as the raw abort reason (unless a
cutoff was already recorded, in which case it is the cause text of a
cutoff error).

### 2.15 Usage accounting

Adapters report per-response counts: `input`, `cacheRead`, `cacheWrite`,
`output`. Each is floored at 0. The client normalizes them once per
finished response into **disjoint** counts. The per-protocol rules are
owned by the llm-protocols area, which subtracts cached tokens exactly
once for `chat` and `responses` (deliberate change 13; Go subtracted
them twice); `anthropic` counts are disjoint already. The loop and
ledger only consume the resulting `Usage`, where `uncached_input_tokens`,
`cached_input_tokens`, and `cache_write_tokens` never overlap.

`Usage = {uncached_input_tokens, cached_input_tokens, cache_write_tokens,
output_tokens, calls}` with `calls = 1` per finished response. The client
accumulates it across all its conversations (`client.usage()`), and the
same per-response value reconciles the ledger. Responses without a finish
event add nothing. Example (chat): `prompt_tokens` 8 of which 4 cached,
`completion_tokens` 3 -> uncached 4, cached 4, write 0, output 3,
calls 1. Its ledger weight is `4 + 0.1 * 4 + 0 + 3 = 7.4`.

## 3. TypeScript module design

All modules live under `src/llm/`. The loop is written as a small
imperative shell (`agent.ts`) around pure decision functions
(`review.ts`, `ledger.ts` math, `errors.ts`), so most invariants are unit
testable with a scripted fake adapter and an injected clock.

### 3.1 Adapter interface (assumed; owned by the LLM protocols area)

```ts
export type FinishCategory = 'stop'|'length'|'content-filter'|
    'tool-calls'|'error'|'other'|'unknown'

export interface RawUsage {
    input:number
    cacheRead:number
    cacheWrite:number
    output:number
}

export type StreamEvent =
    | {type:'text', text:string}
    | {type:'reasoning', part:ReasoningPart}  // opaque, replayed verbatim
    | {type:'tool-call', id:string, name:string, input:string}
    | {type:'finish', reason:FinishCategory, rawReason?:string,
        usage:RawUsage}

export interface ModelRequest {
    model:string
    system:string
    messages:readonly Message[]
    tools:readonly ToolDefinition[]  // name, description, full schema
    toolChoice:'auto'
    maxOutputTokens:number
    sessionId:string
}

export interface ProtocolAdapter {
    readonly protocol:'chat'|'responses'|'anthropic'
    // Exact byte size of the serialized request body.
    requestBytes(req:ModelRequest):number
    // Yields events in arrival order; throws on transport/HTTP/stream
    // errors. Capture failures throw CaptureError. Thrown errors expose
    // `retryable:boolean` and, for HTTP failures, `status:number`.
    stream(req:ModelRequest, signal:AbortSignal):AsyncIterable<StreamEvent>
}
```

The loop collects a whole response before acting on it; it does not
forward partial text anywhere.

### 3.2 Transcript (`src/llm/messages.ts`)

```ts
export type AssistantPart =
    | {type:'text', text:string}
    | {type:'reasoning', part:ReasoningPart}
    | {type:'tool-call', id:string, name:string, input:string}

export interface ToolResult {
    callId:string
    name:string
    text:string
    isError:boolean
}

export type Message =
    | {role:'user', text:string}
    | {role:'assistant', parts:readonly AssistantPart[]}
    | {role:'tool', results:readonly ToolResult[]}

export function transcriptBytes(system:string,
    messages:readonly Message[]):number
```

### 3.3 Public types (`src/llm/types.ts`)

```ts
export interface Tool {
    name:string
    description:string
    schema:JsonSchemaObject
    // Absent for the final tool.
    run?:(args:Record<string, unknown>, signal:AbortSignal) =>
        unknown|Promise<unknown>
    recordsResult?:boolean
}

export interface TurnInfo {
    turn:number
    tool:string
    args:Record<string, unknown>
}

// Type validation of the final arguments (2.7). `decode` receives the
// value parsed with integer preservation and throws an Error whose
// message is the validation detail.
export interface FinalSpec<T> {
    decode(value:unknown):T
}

export interface ConverseOptions<T> {
    tools:readonly Tool[]
    finalTool:string
    final:FinalSpec<T>
    maxTurns?:number
    onTurn?:(info:TurnInfo) => void
    inputByteCeiling?:number
    workDeadline?:number      // ms since epoch
    wrapUpWindow?:number      // ms
    onWorkDeadline?:() => void
    onBudgetExhausted?:() => void
}

export interface Usage {
    uncached_input_tokens:number
    cached_input_tokens:number
    cache_write_tokens:number
    output_tokens:number
    calls:number
}

export interface Client {
    readonly name:string  // request model name
    converse<T>(system:string, user:string, opts:ConverseOptions<T>,
        signal:AbortSignal):Promise<T>
    completeStructured<T>(system:string, user:string, schemaName:string,
        result:{schema:JsonSchemaObject, decode:FinalSpec<T>['decode']},
        signal:AbortSignal):Promise<T>
    usage():Usage
}
```

`Usage` keeps snake_case keys because it is serialized into run records
as is.

### 3.4 Modules

- `src/llm/errors.ts`
  ```ts
  export type Sentinel = 'no-final-call'|'work-deadline'|
      'budget-exhausted'|'auth'|'endpoint'
  export interface ErrorDetails {
      model?:string
      finishReason?:FinishCategory
      rawFinishReason?:string
      submissionAttempts?:number
      recordRounds?:number
      stopCause?:StopCauseKind
  }
  export class LlmError extends Error {
      readonly sentinels:ReadonlySet<Sentinel>
      readonly details:ErrorDetails
  }
  export function hasSentinel(err:unknown, s:Sentinel):boolean
  export function cutoffError(cutoff:Sentinel|null, what:string,
      cause?:unknown):LlmError
  export function normalizeProviderError(callerSignal:AbortSignal,
      model:string, err:unknown):unknown
  export class CaptureError extends Error {}
  ```
  `hasSentinel` walks `sentinels` and the `cause` chain (so an endpoint
  error wrapping a timeout still exposes the timeout via `cause`).
  `cutoffError` must not put the cause in the matchable chain (2.14):
  store it as `details`-only text, not as `cause`. `details` lets tests
  assert the stop reason, counts, and finish reason without matching
  message text. This module is shared with the protocols area, which
  raises `auth` / `endpoint` errors.

- `src/llm/ledger.ts`
  ```ts
  export const EST_BYTES_PER_TOKEN = 3
  export const DEFAULT_FINAL_ALLOWANCE = 100_000
  export const CACHED_TOKEN_WEIGHT = 0.1
  export type Release = (usage:Usage) => void
  export class Ledger {
      reserve(reqBytes:number, maxOutput:number,
          final:boolean):Release|null   // null = refused
      exhausted():boolean
      committed():{spent:number, limit:number}
  }
  export function newLedger(limit:number):Ledger|null
  export function reserve(ledger:Ledger|null, reqBytes:number,
      maxOutput:number, final:boolean):Release|null
  export function weightedTokens(usage:Usage):number
  ```
  All methods are synchronous, so concurrent verifier promises cannot
  interleave inside a reservation. `Release` is idempotent.

- `src/llm/usage.ts`: `normalizeUsage(protocol, raw):Usage` (2.15) and
  `addUsage(total, u):Usage`.

- `src/llm/deadline.ts`
  ```ts
  export class WorkDeadline {
      constructor(opts:{deadline?:number, window?:number,
          onFire?:() => void, now?:() => number})
      get fired():boolean
      check():boolean
      // Signal for a model call: caller + deadline timer before the
      // latch, caller + fresh window after it.
      callSignal(caller:AbortSignal):AbortSignal
      runTool(tool:Tool, args:Record<string, unknown>,
          caller:AbortSignal):Promise<{value:unknown}|{error:Error}>
  }
  ```
  `callSignal` and `runTool` use `AbortSignal.any` with
  `AbortSignal.timeout` (window, request timeout) or a timer aborting at
  the absolute deadline. `runTool` races the tool against the signal and
  never awaits an abandoned tool.

- `src/llm/final-args.ts`
  - `parsePreservingIntegers(text:string):unknown` -- `JSON.parse` with a
    reviver using the source-text context argument; an integer literal
    outside the safe range becomes `bigint`. Throws on invalid JSON.
  - `checkRequired(schema, input:string):string|null` -- the
    required-field validation of 2.7; returns the error text or null.
  - `typeValidate<T>(text, spec:FinalSpec<T>)` ->
    `{ok:true, value:T}|{ok:false, error:string}` (`invalid JSON` on
    parse failure).

- `src/llm/tool-json.ts`: `goJsonStringify(value):string` -- JSON with
  sorted keys and no HTML escaping (2.7); throws on unserializable values
  (`bigint` is serialized as its decimal digits, cycles throw).

- `src/llm/retry.ts`
  ```ts
  export async function withStepRetry<R>(attempt:() => Promise<R>,
      opts:{maxRetries:number, signal:AbortSignal,
          sleep?:(ms:number, signal:AbortSignal) => Promise<void>}
  ):Promise<R>
  export function retryDelay(err:unknown, backoffMs:number):number
  ```
  Uses `err.retryable` from the adapter; aborts and `CaptureError` and
  `LlmError` cutoff errors are never retried.

- `src/llm/review.ts` (pure)
  ```ts
  export interface ReviewInput {
      calls:readonly {id:string, name:string, input:string}[]
      finalTool:string
      toolNames:ReadonlySet<string>   // caller tools + nudge
      recordTools:ReadonlySet<string>
      finalPhase:boolean
      turn:number
      submissionAttempts:number
      recordRounds:number
      maxAttempts:number
      mayContinue:() => boolean       // 2.8, may latch the deadline
      validateFinal:(input:string) => string|null
  }
  export interface ReviewDecision {
      dispatch:boolean
      nudge?:{id:string, message:string}
      blockExploration?:string
      rejectFinal?:string
      accept?:{id:string, input:string}
      finalErr?:string|null           // undefined = unchanged
      validationExhausted:boolean
      halt:boolean
      stopCause:string
      submissionAttempts:number
      recordRounds:number
      unknownCalls:readonly {name:string, input:string}[]
  }
  export function reviewResponse(input:ReviewInput):ReviewDecision
  ```

- `src/llm/agent.ts` (imperative shell)
  ```ts
  export interface LoopDeps {
      adapter:ProtocolAdapter
      model:string
      protocol:'chat'|'responses'|'anthropic'
      maxOutputTokens:number
      maxAttempts:number          // already normalized (<= 0 -> 4)
      requestTimeout:number       // ms, 0 = none
      ledger:Ledger|null
      addUsage:(u:Usage) => void  // client accumulator
      now?:() => number
      sleep?:(ms:number, signal:AbortSignal) => Promise<void>
      sessionId?:() => string     // default: 'roast-' + base32(16 bytes)
  }
  export function runConversation<T>(deps:LoopDeps, system:string,
      user:string, opts:ConverseOptions<T>, structured:boolean,
      signal:AbortSignal):Promise<T>
  export const NUDGE_TOOL_NAME = '__roast_continue'
  export const DEFAULT_MAX_TURNS = 8
  export const DEFAULT_INPUT_BYTE_CEILING = 3_000_000
  export const DEFAULT_WRAP_UP_WINDOW = 90_000
  export const DEFAULT_MAX_ATTEMPTS = 4
  ```
  Per turn: prepare (2.5), then `withStepRetry` around one model call:
  build request, reserve, stream into a buffer with
  `deadline.callSignal` (plus request timeout), release in `finally`,
  verify capture and signal, then review and dispatch. Budget refusal
  and in-flight deadline perform the in-step switch (2.9) inside the
  same attempt. Then stop conditions (2.10).

- `src/llm/client.ts` (shared with the protocols area): builds a
  `Client` from a resolved role, owns the usage accumulator, implements
  `converse` / `completeStructured` by calling `runConversation`.

### 3.5 Dependencies

- LLM protocols area: adapters, request byte size, capture, retryable
  classification, session header.
- Config / CLI areas: profile values (`model`, `max_output_tokens`,
  `protocol`) and run limits (`limits.max_attempts`,
  `limits.request_timeout`, `limits.max_total_tokens`, which sizes the
  ledger).
- Review (finder) and verify areas: callers; they build tools, the final
  spec (zod-derived JSON Schema plus decoder), deadlines, and react to
  sentinels. The verify stage reads `ledger.exhausted()` before launching
  each verification.
- CLI / records area: constructs one ledger per run and writes
  `ledger.committed()` and client usage into the run record.
- Debug: `@substrate-system/debug` namespace `roast:llm`.

## 4. Deliberate changes

Only these items from `00-decisions.md` touch this area:

- **Own loop, no framework** (Architecture, LLM): the Go loop delegated
  turn sequencing, step retries, required-field validation, unknown-tool
  results, and sequential dispatch to `charm.land/fantasy` v0.48.0. The
  TS loop implements those behaviors itself, exactly as specified in
  section 2; none of them changes. Fantasy's JSON repair of malformed
  tool arguments was disabled in Go and is absent in TS.
- **AbortSignal instead of context** (Architecture): Go contexts become
  `AbortSignal`s. Caller cancellation surfaces as `signal.reason` where
  Go returned `context.Canceled` / `context.DeadlineExceeded`. A tool
  cannot panic; any throw or rejection becomes the `{"error": ...}`
  result (Go: `tool panicked: <value>`).
- **Debug tracing** (Deliberate change 5): namespace `roast:llm`. Trace
  turn numbers, phase changes, cutoffs, ledger admissions/refusals
  (numbers only), retries, and stop causes. Never trace request or
  response bodies, prompts, tool arguments or results, headers, or
  credentials.
- **Case-sensitive keys** (Deliberate change 7): final-argument decoding
  matches property names exactly, where Go matched case-insensitively.
  JSON `null` still means absent.
- **Cached tokens subtracted once** (Deliberate change 13): the ledger
  and `Usage` consume disjoint counts from the llm-protocols area.
- **Process lifetime** (Cross-cutting rules): tools kill child processes
  on abort and the CLI exits explicitly after flushing output.
- **Node `>=22.18`** (Deliberate change 3): required for the
  `JSON.parse` reviver source-text argument used to preserve large
  integers, `AbortSignal.any`, and `AbortSignal.timeout`.

## 5. Test plan

Default seam: the agent loop driven by a scripted fake `ProtocolAdapter`
(a list of canned responses or a function of the request), with an
injected `now` and `sleep` where timing matters. Items marked
**[HTTP]** run the real adapters against a `node:http` fake server and
land with the protocol they need (M3 for `chat`, M4 for the others).
Assertions use sentinels (`hasSentinel`), `LlmError.details`, call
counts, requests received, and tool invocations, never exact message
text.

### 5.1 Finalization

- A valid submission ends finalization in one call however the final
  phase was reached (turn budget, budget refusal, deadline); every
  final-phase request uses automatic tool choice and still offers the
  final tool (TestFinalizationUsesAutomaticToolChoice).
- Final-phase reminders never reopen exploration: an exploration call,
  an unknown tool, or prose on the wrap-up turn is answered with a
  reminder, the exploration tool is never run, and the next valid
  submission succeeds (TestFinalizationRemindsWithoutReopeningExploration).
- A model that never submits stops after exactly `maxAttempts` final
  responses, for both `converse` and `completeStructured`, with
  `no-final-call` (TestFinalizationMissingSubmissionIsBounded).
- After a budget or deadline cutoff there are no reminders: one wrap-up
  call, error matches the cutoff sentinel and `no-final-call`
  (TestFinalizationDoesNotRetryAfterCutoff).
- Invalid submissions and prose share one allowance; when a schema
  failure is followed by prose, the error is `no-final-call`, not the
  stale schema error (TestFinalizationSharesStructuredRetryAllowance).
- A reminder needs ledger admission: reported usage that spends the
  budget makes the next reminder fail with `budget-exhausted` +
  `no-final-call` after one call
  (TestFinalizationReminderRequiresTokenAdmission).
- Caller cancellation during a reminder surfaces as the caller's abort
  reason (TestFinalizationReminderPreservesCallerDeadline).
- A final call missing a required property is never accepted and is
  bounded by `maxAttempts`
  (TestFinalizationFrameworkValidationFailureIsBounded).
- A required-field rejection during exploration does not consume
  final-phase attempts; the run then succeeds on the third call
  (TestExplorationSchemaRejectionPreservesFinalizationAllowance).
- An invalid submission in the final phase is retried with validation
  feedback in the next request and the corrected one is returned
  (TestAgentFinalizationRetriesInvalidSubmission,
  TestStructuredOutputRetryUsesFantasyLoop).
- A provider failure after a provisional schema rejection is reported as
  `endpoint`, not as a schema error
  (TestStructuredOutputRetryDoesNotMaskLaterProviderFailure).
- Persistently malformed final arguments end with the schema error
  (`details.stopCause` = invalid arguments)
  (TestAgentReportsMalformedFinalArguments).
- `{"id":9007199254740993}` reaches the caller exactly
  (TestFinalToolPreservesLargeIntegers).

### 5.2 Record tools and the deadline

- Record-only wrap-up rounds do not spend submission attempts but are
  bounded: with `maxAttempts: 1`, two calls, two records, then
  `no-final-call` with `details.recordRounds === 2`
  (TestWrapUpRecordRoundsAreBounded).
- A deadline that passes while a wrap-up record tool runs lets the
  record finish, fires `onWorkDeadline`, opens no further call, and
  ends with `work-deadline` + `no-final-call`
  (TestDeadlineDuringWrapUpDispatchStopsFinalization).
- After the deadline, record tools still run (alone or next to a blocked
  exploration call) and no second call is made
  (TestRecordToolRunsAfterDeadlineCutoff).
- An exploration call cut by the work deadline is replaced, in the same
  turn, by a wrap-up call under a fresh window; `onWorkDeadline` fires;
  the wrap-up submission succeeds
  (TestAgentInFlightDeadlineGetsFreshFinalWindow).
- A failed wrap-up call after the deadline is not retried, even with
  `maxAttempts: 3` (TestAgentDoesNotRetryFailedDeadlineWrapUp).
- A tool call buffered before an abort is never dispatched: with a
  request timeout the run fails `endpoint` after one call; with a work
  deadline the wrap-up call keeps the full tool set, gets a live signal,
  and its submission succeeds
  (TestStreamCancellationDoesNotDispatchBufferedTool).
- A request timeout is an `endpoint` error whose cause is a timeout, and
  it returns promptly (TestInferenceRequestTimeoutIsEndpointFailure).

### 5.3 Dispatch

- Prose during exploration gets a nudge result and the conversation
  continues (TestAgentNudgesFreeFormResponse).
- An unknown tool gets a `tool not found` error result, is reported once
  to `onTurn`, and the run recovers (TestAgentUnknownToolReturnsErrorToModel).
- Several tool calls in one response run sequentially in call order
  (TestAgentExecutesMultipleToolsSequentially).
- A final call suppresses exploration calls in the same response
  (TestStreamFinalSubmissionSuppressesOtherToolCalls).
- Finish reasons `length`, `content-filter`, `error`, `unknown` never
  dispatch any tool, including a final call
  (TestStreamAbnormalFinishNeverDispatchesTools).
- The complete caller schema (`additionalProperties: false`) reaches the
  adapter (TestAgentRestoresCompleteToolSchemaAtModelBoundary).

### 5.4 Retries

- A transient failure is retried once with `maxAttempts: 2`, honoring
  `retry-after-ms` (TestFantasyRetriesTransientModelFailure).
- [HTTP] An interrupted Anthropic stream is retried and its partial tool
  call is never executed
  (TestAnthropicInterruptedStreamRetriesWithoutExecutingPartialTools).

### 5.5 Ledger and usage

- Budget refusal of the first exploration call goes straight to one
  wrap-up call that succeeds; `onBudgetExhausted` fires
  (TestAgentBudgetRefusalUsesReservedFinalCall, ledger limit 1500,
  `maxOutputTokens` 100).
- Chat usage normalization: prompt tokens 8 with 4 cached, output 3 ->
  uncached 4, cached 4, write 0, output 3, calls 1; counts are disjoint
  and cached is subtracted once (deliberate change 13; Go test
  TestGenericUsageAccounting, expected values updated).
- Aborting a call mid-stream aborts the adapter's signal and releases
  the reservation (`outstanding` back to 0)
  (TestStreamConsumerStopCancelsAndReleasesReservation).
- Ledger unit tests (no Go test; the ledger is a named lower seam):
  `newLedger(0)` and negative limits give no ledger and unlimited
  admission; final allowance is `min(100000, limit/2)`; a non-final
  reservation is refused exactly when
  `committed + outstanding + est > limit - max(allowance, est + out)`;
  a final reservation may use the whole limit; any refusal latches
  `exhausted()`; release is idempotent and reconciles with cache reads
  at 0.1 weight and negative counts floored; `committed()` truncates.

### 5.6 Error naming and provider integration

- [HTTP] A truncated response names finish reason `length` and the
  `max_output_tokens` hint; prose names the model and the submission
  attempt count; a provider rejection during wrap-up keeps the
  provider's error after a single generic sentinel
  (TestNoSubmissionNamesTheCause). Port as assertions on `details`
  (finish reason, attempts, model) plus the sentinel set.
- [HTTP] A reasoning-only `length` / `max_tokens` finish is a
  no-submission error (not `endpoint`), stated once, not retried
  (TestReasoningOnlyLengthFinishNamesTheCeiling).
- [HTTP] Abnormal provider reasons map to categories and keep the raw
  reason (TestAbnormalFinishNamesTheProviderReason).
- [HTTP] Thinking-mode providers get automatic tool choice
  (TestDeepSeekThinkingModeUsesAutomaticToolChoice,
  TestDeepSeekFixtureRejectsForcedToolChoice).
- [HTTP] One session ID per conversation, shared by all its requests
  and corrections, distinct across conversations
  (TestProviderConversationIdentity,
  TestStructuredCorrectionsRetainConversationIdentity).
- [HTTP] Anthropic requests carry `max_tokens` = `maxOutputTokens`
  (TestAnthropicNativeMessagesPreservesOutputBudget).
- [HTTP] Follow-up Anthropic requests replay the signed-thinking prefix
  (system, tools, earlier content, injected reminders) unchanged
  (TestAnthropicReplayKeepsSignedThinkingPrefix,
  TestBindingServerRejectsChangedPrefix).

## 6. Go baseline references

At commit `cd08f10`:

- `internal/llm/agent.go` -- run state, turn preparation, response
  review, final/exploration/nudge tools, error precedence.
- `internal/llm/llm.go` -- `Usage`, `Tool`, `TurnInfo`, `ConverseOpts`,
  `workDeadlineState`, notice text, `Client`.
- `internal/llm/ledger.go` -- ledger constants and math.
- `internal/llm/errors.go` -- sentinels.
- `internal/llm/provider.go` -- `defaultMaxAttempts`,
  `defaultInputByteCeiling`, `addUsage`, `maxAttempts`,
  `normalizeProviderError`.
- `charm.land/fantasy@v0.48.0` `agent.go` (step loop, validation,
  sequential dispatch, continuation), `retry.go` and `errors.go` (retry
  policy and retryable classification).
- Callers: `internal/review/review.go` (finder, `report_finding` record
  tool), `internal/verify/verify.go`, `internal/cli/doctor.go`,
  `internal/cli/cli.go` (ledger construction, `Committed`).
- Tests: `internal/llm/agent_test.go`, `finalization_test.go`,
  `stream_test.go`, `session_test.go`, `anthropic_budget_test.go`,
  `deepseek_test.go`, `stream_capture_test.go`,
  `thinking_binding_test.go`.

## 7. Resolved

1. A type-invalid final call during exploration ends the run with no
   reminder: Go parity, kept (spec.md "Resolved open questions").
2. Ledger `reqBytes` = the adapter's exact request body length + 2048;
   accepted, results near the limit may differ from Go.
3. Tool results use sorted keys and no HTML escaping, via the llm area's
   encoder (spec.md cross-cutting "JSON encoding").
4. Decoders match JSON keys exactly (deliberate change 7); `null` means
   absent (Go parity).
5. Any adapter may supply a raw finish reason.
6. Tools kill child processes on abort and the CLI calls `process.exit`
   after flushing output (spec.md cross-cutting "Process lifetime").

## 8. Open questions

1. **The nudge tool is never sent by Go.** 2.3 says every request offers
   the caller's tools plus `__roast_continue`, and `completeStructured`
   sends its schema tool plus the nudge. At `cd08f10` the Go loop does
   register the nudge with fantasy (`internal/llm/agent.go`,
   `nudgeFantasyTool`), but `prepareStep` returns `ActiveTools:
   s.active`, and `s.active` holds only the caller's tools, so fantasy
   never puts the nudge in a request. Go's `provider_test.go` asserts a
   structured request carries exactly one tool. The TS loop sends it in
   every request (`tools[last]`), so every M3 differential scenario
   (ticket 26) differs at `requests[<model>#<turns>][i].body.tools[n]`.
   This is not one of spec.md's deliberate changes, so the harness does
   not allowlist it. Decide whether TS drops the nudge from requests
   (Go parity; synthetic nudge calls in the transcript would then name a
   tool the request does not offer, as in Go) or whether sending it
   becomes a numbered deliberate change that the harness can cite.
