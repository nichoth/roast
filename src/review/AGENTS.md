# Review model and finder

- `Finding` uses wire field names; empty `lines` becomes `null` through
  `toFinding`. Keep the ten wire fields in their schema declaration order.
- `Result` uses internal `dropped` and `stopReason` names. Report rendering
  owns the output names `dropped_findings` and `stop_reason`.
- Final decoders receive both a parsed value and optional raw argument
  text from `FinalSpec.decode`. Pass the raw text to the finding decoder
  to distinguish integer literals from decimal or exponent spellings.
  Early reports first round-trip the agent's float64 map through
  `encodeToolResult`; their integer spelling rules therefore differ.
- Fingerprints are similarity keys, never ids. Accumulation replaces
  content on a repeated fingerprint while preserving first-seen order.
  Capture runs on every accepted add, including submission merges.
- Finder unit tests live in `test/review/`; scripted client tests reuse
  `test/llm/agent-helpers.ts`, and HTTP tests use the inference server.
  Import new test modules from `test/index.ts`.
