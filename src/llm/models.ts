// Model-ID rules (spec 06, 2.6).

const REASONING = /(?:^|[-.])(?:o[134]|oss)|gpt-[5-9]|codex-|computer-use/
const CLASSIC_CHAT = /gpt-3|gpt-4|chatgpt-|-chat/

// Chat reasoning models take `max_completion_tokens` instead of
// `max_tokens`.
export function isChatReasoningModel (id:string):boolean {
    const lower = id.toLowerCase()
    return REASONING.test(lower) && !CLASSIC_CHAT.test(lower)
}

// How the `responses` protocol sends the system prompt.
export function responsesSystemMode (
    id:string
):'system'|'developer'|'remove' {
    if (CLASSIC_CHAT.test(id.toLowerCase())) return 'system'
    if (id.includes('o1-mini') || id.includes('o1-preview')) return 'remove'
    return 'developer'
}

// Models that get adaptive thinking by default on `anthropic`.
export function anthropicDefaultThinking (id:string):boolean {
    return id.toLowerCase().includes('claude-mythos-preview')
}
