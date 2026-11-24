// Provider-neutral model families (spec 02, 2.10).
import { goTrimSpace } from '../gocompat/strings.js'

const VENDOR_PREFIXES = [
    'anthropic', 'openai', 'google', 'gemini', 'mistral', 'xai', 'cohere',
    'deepseek',
]

// [family, exact names, ID prefixes], first match wins.
const RULES:[string, string[], string[]][] = [
    ['anthropic', ['anthropic'], ['claude-']],
    ['openai', ['openai'], ['gpt-', 'codex-', 'chatgpt-', 'o1', 'o3', 'o4']],
    ['google', ['google', 'gemini'], ['gemini-']],
    ['mistral', ['mistral'], ['mistral-', 'codestral-']],
    ['xai', ['xai'], ['grok-']],
    ['cohere', ['cohere'], ['command-']],
    ['deepseek', ['deepseek'], ['deepseek-']],
]

export function canonicalFamily (family:string):string {
    return family === 'gemini' ? 'google' : family
}

function trimSuffix (s:string, suffix:string):string {
    return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s
}

// The model's family from a bare family name, a model ID, or a
// `<vendor>/<model>` ID, or '' when it cannot be determined.
export function inferFamily (model:string):string {
    let m = goTrimSpace(model).toLowerCase()
    if (m === '') return ''
    const slash = m.indexOf('/')
    if (slash >= 0) {
        const vendor = m.slice(0, slash)
        if (VENDOR_PREFIXES.includes(vendor)) return canonicalFamily(vendor)
        m = m.slice(slash + 1)
    }
    m = trimSuffix(trimSuffix(m, ':api'), '[1m]')
    for (const [family, names, prefixes] of RULES) {
        if (names.includes(m) || prefixes.some(p => m.startsWith(p))) {
            return family
        }
    }
    return ''
}
