// The built-in provider registry (spec 02, 2.7): the one place that says
// which endpoint, protocols, standard key variable, key page, and login
// method each provider has. Trust standardness, ambient credentials, the
// `init` starter, and login all consult it.
import { goTrimSpace } from '../gocompat/strings.js'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export type Protocol = 'chat'|'responses'|'anthropic'
export type LoginMethod = 'paste'|'browser'

export interface BuiltinProvider {
    readonly name:string;
    readonly endpoint:string;
    // The first is the one starter profiles use.
    readonly protocols:readonly Protocol[];
    readonly keyEnv:string;
    readonly keyPage:string;
    readonly login:LoginMethod;
}

// No two entries share an (endpoint, protocol) pair, so providerAt finds
// at most one. Order matters for withheldKey and listings.
const REGISTRY:readonly BuiltinProvider[] = Object.freeze([
    {
        name:'openai',
        endpoint:DEFAULT_OPENAI_BASE_URL,
        protocols:['responses', 'chat'],
        keyEnv:'OPENAI_API_KEY',
        keyPage:'https://platform.openai.com/api-keys',
        login:'paste',
    },
    {
        name:'anthropic',
        endpoint:DEFAULT_ANTHROPIC_BASE_URL,
        protocols:['anthropic'],
        keyEnv:'ANTHROPIC_API_KEY',
        keyPage:'https://console.anthropic.com/settings/keys',
        login:'paste',
    },
    {
        name:'openrouter',
        endpoint:OPENROUTER_BASE_URL,
        protocols:['chat', 'responses'],
        keyEnv:'OPENROUTER_API_KEY',
        keyPage:'https://openrouter.ai/settings/keys',
        login:'browser',
    },
].map(p => Object.freeze({
    ...p,
    protocols:Object.freeze([...p.protocols]) as readonly Protocol[],
} as BuiltinProvider)))

function copy (p:BuiltinProvider):BuiltinProvider {
    return { ...p, protocols:[...p.protocols] }
}

// Copies of the registry, in registry order.
export function builtinProviders ():BuiltinProvider[] {
    return REGISTRY.map(copy)
}

// The provider with exactly this name (case-sensitive).
export function lookupProvider (name:string):BuiltinProvider|undefined {
    const p = REGISTRY.find(p => p.name === name)
    return p && copy(p)
}

// The provider that accepts `protocol` at `endpoint`.
export function providerAt (
    endpoint:string,
    protocol:string
):BuiltinProvider|undefined {
    const p = REGISTRY.find(p =>
        (p.protocols as readonly string[]).includes(protocol) &&
        sameEndpoint(p.endpoint, endpoint))
    return p && copy(p)
}

// The implicit endpoint of a profile that sets none. OpenRouter is never
// one.
export function defaultBaseURL (protocol:string):string {
    return protocol === 'anthropic' ?
        DEFAULT_ANTHROPIC_BASE_URL :
        DEFAULT_OPENAI_BASE_URL
}

// Parses an endpoint with WHATWG URL, or null when it does not parse or
// has an empty host. WHATWG repairs `https:///v1` and `https:v1` into a
// host; Go sees an empty one, so text after the scheme must start with
// `//` and a non-empty authority.
export function parseEndpoint (s:string):URL|null {
    const colon = s.indexOf(':')
    if (colon < 0) return null
    const rest = s.slice(colon + 1)
    if (!rest.startsWith('//')) return null
    const end = rest.slice(2).search(/[/?#]/)
    const authority = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end)
    // Userinfo alone (`https://u@/v1`) leaves no host either.
    if (authority.slice(authority.lastIndexOf('@') + 1) === '') return null
    let u:URL
    try {
        u = new URL(s)
    } catch {
        return null
    }
    return u.host === '' ? null : u
}

function stripTrailingSlashes (p:string):string {
    let end = p.length
    while (end > 0 && p[end - 1] === '/') end--
    return p.slice(0, end)
}

// Endpoints compare by scheme and host (case-insensitive), path without
// trailing slashes, raw query, and userinfo. Unparseable values never
// match.
export function sameEndpoint (a:string, b:string):boolean {
    const left = parseEndpoint(goTrimSpace(a))
    const right = parseEndpoint(goTrimSpace(b))
    if (!left || !right) return false
    return left.protocol === right.protocol &&
        left.host === right.host &&
        stripTrailingSlashes(left.pathname) ===
            stripTrailingSlashes(right.pathname) &&
        left.search === right.search &&
        left.username === right.username &&
        left.password === right.password
}
