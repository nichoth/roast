import { test } from '@substrate-system/tapzero'
import {
    chatUsage,
    normalizeUsage,
    UsageAccumulator,
} from '../../src/llm/usage.js'
import {
    isChatReasoningModel,
    responsesSystemMode,
    anthropicDefaultThinking,
} from '../../src/llm/models.js'

test('chat usage subtracts cached tokens once', t => {
    const u = (cached:number) => normalizeUsage(chatUsage({
        prompt_tokens:100,
        completion_tokens:7,
        total_tokens:107,
        prompt_tokens_details:{ cached_tokens:cached },
    }))
    t.deepEqual(u(30), {
        uncachedInputTokens:70,
        cachedInputTokens:30,
        cacheWriteTokens:0,
        outputTokens:7,
        calls:1,
    }, 'cached 30')
    t.equal(u(80).uncachedInputTokens, 20, 'cached 80 uncached')
    t.equal(u(80).cachedInputTokens, 80, 'cached 80 cached')
    t.equal(u(120).uncachedInputTokens, 0, 'cached over prompt clamps')
})

test('chat usage counts reasoning tokens above output', t => {
    const out = (o:number, r:number) => normalizeUsage(chatUsage({
        prompt_tokens:1,
        completion_tokens:o,
        completion_tokens_details:{ reasoning_tokens:r },
    })).outputTokens
    t.equal(out(10, 4), 10, 'reasoning included in output')
    t.equal(out(4, 10), 14, 'reasoning above output is added')
    t.deepEqual(normalizeUsage(chatUsage(undefined)), {
        uncachedInputTokens:0,
        cachedInputTokens:0,
        cacheWriteTokens:0,
        outputTokens:0,
        calls:1,
    }, 'missing usage is zero')
})

test('stage 2 is the identity on disjoint counts', t => {
    t.deepEqual(normalizeUsage({
        input:8, cacheRead:4, cacheWrite:1, output:3,
    }), {
        uncachedInputTokens:8,
        cachedInputTokens:4,
        cacheWriteTokens:1,
        outputTokens:3,
        calls:1,
    })
    t.equal(normalizeUsage({
        input:-5, cacheRead:0, cacheWrite:0, output:0,
    }).uncachedInputTokens, 0, 'negative clamps to 0')
})

test('accumulator sums calls', t => {
    const acc = new UsageAccumulator()
    const one = normalizeUsage({
        input:10, cacheRead:3, cacheWrite:2, output:4,
    })
    acc.add(one)
    acc.add(one)
    t.deepEqual(acc.total(), {
        uncachedInputTokens:20,
        cachedInputTokens:6,
        cacheWriteTokens:4,
        outputTokens:8,
        calls:2,
    })
    const snap = acc.total()
    snap.calls = 99
    t.equal(acc.total().calls, 2, 'total is a copy')
})

test('chat reasoning model IDs', t => {
    for (const id of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'GPT-5.1',
        'openai/gpt-5', 'gpt-oss-120b', 'codex-mini-latest',
        'computer-use-preview', 'openai/gpt-oss-20b']) {
        t.ok(isChatReasoningModel(id), `${id} is a reasoning model`)
    }
    for (const id of ['gpt-4o', 'gpt-4.1', 'gpt-3.5-turbo', 'deepseek-chat',
        'gpt-5-chat-latest', 'chatgpt-4o-latest', 'claude-sonnet-4',
        'deepseek-reasoner']) {
        t.ok(!isChatReasoningModel(id), `${id} is not`)
    }
})

test('responses system mode and anthropic thinking', t => {
    t.equal(responsesSystemMode('gpt-4o'), 'system', 'gpt-4 system')
    t.equal(responsesSystemMode('o1-mini'), 'remove', 'o1-mini removed')
    t.equal(responsesSystemMode('o1-preview'), 'remove', 'o1-preview')
    t.equal(responsesSystemMode('gpt-5'), 'developer', 'developer')
    t.ok(anthropicDefaultThinking('Claude-Mythos-Preview'), 'mythos')
    t.ok(!anthropicDefaultThinking('claude-sonnet-4-5'), 'others not')
})
