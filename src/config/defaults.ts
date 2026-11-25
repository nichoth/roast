// Shared defaults for starter rendering and CLI settings.
export const DEFAULT_CONFIDENCE_FLOOR = 0.6
export const DEFAULT_QUICK_CONFIDENCE_FLOOR = 0.8
export const DEFAULT_SNAPSHOT = true
export const DEFAULT_GATE_OFFER = true
export const GATE_DEFAULT_TIMEOUT = 180
export const GATE_DEFAULT_SEVERITY = 'HIGH'

// Durations use config spelling; CLI consumers parse them as Go durations.
export const DEFAULT_LIMITS = Object.freeze({
    deadline:'10m',
    request_timeout:'10m',
    max_total_tokens:3_000_000,
    max_diff_bytes:1_000_000,
    max_prompt_bytes:8_000_000,
    max_file_ctx_bytes:400_000,
    max_attempts:4,
    max_verified:25,
})

// Suggested model IDs for each built-in provider, used by the
// starter and the UnplaceableModelError hint.
export const SUGGESTED_MODELS = Object.freeze({
    anthropic:'claude-opus-5-5',
    openai:'gpt-6.1-terra',
    openrouter:Object.freeze([
        'anthropic/claude-opus-5-5',
        'openai/gpt-6.1-terra',
    ] as const),
})

// Review flag defaults that have no config key. Survey values apply
// with `--scope repo`; quick values with `--quick`.
export const DEFAULT_REVIEW_MAX_TURNS = 16
export const SURVEY_MAX_TURNS = 40
export const SURVEY_DEADLINE = '25m'
export const QUICK_DIFF_BYTES = 200_000
export const QUICK_FILE_CTX_BYTES = 100_000
