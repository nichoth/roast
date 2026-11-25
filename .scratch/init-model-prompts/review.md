<!-- redeye:review from=32cfb454c556d00671db2b5a63e9e1643c29279f to=3f38ec60ddc8179da9d285393856aaed0eae4193 status=fixed -->
## 2026-11-24 16:24 -- review 32cfb45..3f38ec6 -- 2 of 2 fixed
- [x] `suggestedModel` returns the same vendor as the other role for OpenRouter, not the opposite
    src/cli/init.ts:79-82 — when finder picks OpenAI and verifier picks OpenRouter, `suggestedModel('openrouter', { provider:'openai', ... })` sets `otherFamily = 'openai'` then returns `SUGGESTED_MODELS.openrouter[1]` (`openai/gpt-6.1-terra`), suggesting the same vendor. The spec says "choosing the vendor the other role is not using", so the ternary indices should be swapped: `[0]` (anthropic slug) when otherFamily is openai, `[1]` (openai slug) when otherFamily is anthropic.
- [x] Custom endpoint model prompt accepts model IDs with internal whitespace or control characters
    src/cli/init.ts:240-243 — `promptCustomEndpoint` trims the model answer but does not reject strings containing spaces, tabs, or control characters (e.g. `"my model"`, `"model\x01"`). The spec requires "any non-empty trimmed string with no whitespace or control characters". A validation check after trimming is missing.

### Fix
- attempts: 1 of 4
- effort: medium
- agent exit code: 0
- result: merged

# Fix notes

## Finding 1: suggestedModel returns same vendor for OpenRouter

**What:** `suggestedModel` for OpenRouter was returning the same
vendor slug as the other role instead of the opposite.

**Root cause:** The ternary at lines 80-82 had indices `[1]`/`[0]`
effectively swapped. The intermediate `otherFamily` variable
obscured the logic. Simplified to: return the OpenAI slug only when
the other role is Anthropic; return the Anthropic slug in all other
cases (including when no other choice exists, per spec: "finder
defaults to the Anthropic slug when the verifier is not yet known").

**Files changed:**
- `src/cli/init.ts` -- simplified `suggestedModel` OpenRouter branch
- `test/cli/init.ts` -- added test: OpenRouter verifier suggests
  Anthropic slug when finder is OpenAI

**Key learning:** The initial naive fix (just swapping `[0]`/`[1]`)
broke the existing test for the no-other-choice case. The correct
fix required understanding all four cases (no other, openai, anthropic,
openrouter/custom as other).

## Finding 2: Custom model prompt accepts whitespace/control chars

**What:** `promptCustomEndpoint` trimmed the model answer but did not
reject strings containing spaces, tabs, or control characters.

**Root cause:** The model prompt was a single read without a
validation loop, unlike the other prompts in the same function.

**Files changed:**
- `src/cli/init.ts` -- added `hasWhitespaceOrControl` helper and
  validation loop for custom model input
- `test/cli/init.ts` -- added test: space and tab in model rejected,
  then valid model accepted

**Key learning:** eslint `no-control-regex` rejects control characters
in regex literals. Used charCode scanning instead, as documented in
`docs/agents/typescript.md`.

## Final state

Both findings fixed and committed. Full test suite, lint, and
typecheck all pass.
---
