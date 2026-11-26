# 04: Control retry delays in review tests

**Blocked by:** 01
**Touches:** `test/cli/review-anthropic.ts`, `test/llm/agent-http.ts`,
`src/llm/agent.ts`, `src/llm/client.ts`, `src/llm/retry.ts`,
review orchestration and test helpers as needed
**Status:** done

**What to build:** Exercise the interrupted inference stream retry at a
high practical seam without waiting for production backoff, preserving
real request and retry behavior and production delay semantics.

- [x] The interrupted-stream scenario verifies retry requests and the
  resulting behavior without a production-length sleep.
- [x] Controlled delay tests verify retry delay decisions and cancellation
  at the relevant agent, CLI, or HTTP seam.
- [x] Representative real timer and HTTP integration coverage remains,
  and production retry delays and command behavior are unchanged.
