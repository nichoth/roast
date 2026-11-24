// Usage normalization (spec 06, 2.9): provider fields -> disjoint
// intermediate counts (stage 1, per protocol) -> Usage (stage 2, shared).
// Cached tokens are subtracted exactly once (deliberate change 13).

import type { Usage } from './types.js'

export interface IntermediateUsage {
    input:number;
    cacheRead:number;
    cacheWrite:number;
    output:number;
}

function num (v:unknown):number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function obj (v:unknown):Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ?
        v as Record<string, unknown> :
        {}
}

// Stage 1 for `chat`: the `usage` object of a completion chunk.
export function chatUsage (raw:unknown):IntermediateUsage {
    const u = obj(raw)
    const prompt = num(u.prompt_tokens)
    const cached = num(obj(u.prompt_tokens_details).cached_tokens)
    const output = num(u.completion_tokens)
    const reasoning = num(obj(u.completion_tokens_details).reasoning_tokens)
    return {
        input:Math.max(prompt - cached, 0),
        cacheRead:cached,
        cacheWrite:0,
        output:reasoning > output ? output + reasoning : output,
    }
}

// Stage 1 for `responses`: the terminal event's `response.usage`.
export function responsesUsage (raw:unknown):IntermediateUsage {
    const u = obj(raw)
    return chatUsage({
        prompt_tokens:u.input_tokens,
        prompt_tokens_details:{
            cached_tokens:obj(u.input_tokens_details).cached_tokens,
        },
        completion_tokens:u.output_tokens,
        completion_tokens_details:{
            reasoning_tokens:obj(u.output_tokens_details).reasoning_tokens,
        },
    })
}

// Stage 1 for `anthropic`: the usage accumulated over `message_start`
// and `message_delta` (spec 06, 2.8.3).
export function anthropicUsage (raw:unknown):IntermediateUsage {
    const u = obj(raw)
    return {
        input:num(u.input_tokens),
        cacheRead:num(u.cache_read_input_tokens),
        cacheWrite:num(u.cache_creation_input_tokens),
        output:num(u.output_tokens),
    }
}

// Stage 2: clamp every count to >= 0; one call.
export function normalizeUsage (u:IntermediateUsage):Usage {
    return {
        uncachedInputTokens:Math.max(u.input, 0),
        cachedInputTokens:Math.max(u.cacheRead, 0),
        cacheWriteTokens:Math.max(u.cacheWrite, 0),
        outputTokens:Math.max(u.output, 0),
        calls:1,
    }
}

export function zeroUsage ():Usage {
    return {
        uncachedInputTokens:0,
        cachedInputTokens:0,
        cacheWriteTokens:0,
        outputTokens:0,
        calls:0,
    }
}

// A client's running total across its calls.
export class UsageAccumulator {
    private sum:Usage = zeroUsage()

    add (u:Usage):void {
        this.sum.uncachedInputTokens += u.uncachedInputTokens
        this.sum.cachedInputTokens += u.cachedInputTokens
        this.sum.cacheWriteTokens += u.cacheWriteTokens
        this.sum.outputTokens += u.outputTokens
        this.sum.calls += u.calls
    }

    total ():Usage {
        return { ...this.sum }
    }
}
