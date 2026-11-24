// The environment tests build `io.env` from (spec 01, 3.7).

const AMBIENT_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'OPENROUTER_', 'ROAST_']

// A copy of `base` without any variable whose upper-cased name starts
// with ANTHROPIC_, OPENAI_, OPENROUTER_, or ROAST_.
export function cleanEnv (
    base:Readonly<Record<string, string|undefined>>
):Record<string, string> {
    const env:Record<string, string> = {}
    for (const [key, value] of Object.entries(base)) {
        if (value === undefined) continue
        const upper = key.toUpperCase()
        if (AMBIENT_PREFIXES.some(p => upper.startsWith(p))) continue
        env[key] = value
    }
    return env
}
