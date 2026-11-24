// Credential resolution and endpoint overrides (spec 02, 2.6 and 2.9).
// `env` is always passed in; nothing here reads process.env. A key never
// appears in a CredentialSource or an error message.
import { ConfigError } from './load.js'
import {
    builtinProviders,
    defaultBaseURL,
    providerAt,
    sameEndpoint,
} from './provider.js'
import { type ResolvedRole, updateRole } from './resolved-role.js'

export type Env = Readonly<Record<string, string|undefined>>

// The stored-credential store a loaded config carries (filled by the
// credentials area; config never imports it).
export interface StoredCredentials {
    // null or a '' key when none is stored. Throws when a credentials file
    // cannot be used; it never skips a bad file.
    lookup (provider:string):{
        key:string,
        scope:'project'|'user'|'',
    }|null;
}

export type CredentialKind =
    'role_env'|'profile_env'|'provider_env'|'stored'|'none'

export interface CredentialSource {
    readonly kind:CredentialKind;
    // The variable read, for env kinds.
    readonly env?:string;
    // stored: provider name and scope ('project' or 'user').
    readonly provider?:string;
    readonly scope?:string;
    // none: a set provider key that was not sent.
    readonly withheld?:string;
}

export interface Credential {
    key:string;
    source:CredentialSource;
}

// A variable counts only when it is set to a non-empty string.
export function envValue (env:Env, name:string):string {
    if (name === '' || !Object.hasOwn(env, name)) return ''
    const v = env[name]
    return typeof v === 'string' ? v : ''
}

export function roleKeyVar (role:string):string {
    return `ROAST_${role.toUpperCase()}_API_KEY`
}

// Where a credential came from, never the credential itself.
export function describeSource (s:CredentialSource):string {
    switch (s.kind) {
        case 'role_env': return `${s.env} (role override)`
        case 'profile_env': return `${s.env} (profile api_key_env)`
        case 'provider_env': return `${s.env} (ambient provider key)`
        case 'stored':
            return `stored ${s.scope} credential for ${s.provider}`
        default:
            return s.withheld ?
                `none; ${s.withheld} is set but is sent only to its ` +
                    "provider's default endpoint" :
                'none'
    }
}

function wrap (roleName:string, err:unknown):ConfigError {
    const cause = err instanceof Error ? err.message : String(err)
    return new ConfigError(`role ${roleName}: ${cause}`, { cause:err })
}

// A set standard key variable of a built-in provider, preferring the
// provider at the protocol's default endpoint, or ''. Called only after no
// key was sent, so any variable it names was withheld.
function withheldKey (protocol:string, env:Env):string {
    const providers = builtinProviders()
    const preferred = providers.find(p =>
        sameEndpoint(p.endpoint, defaultBaseURL(protocol)))
    const candidates = [
        ...(preferred ? [preferred.keyEnv] : []),
        ...providers.map(p => p.keyEnv),
    ]
    return candidates.find(name => envValue(env, name) !== '') ?? ''
}

// The stored key of the built-in provider at endpoint and protocol. The
// registry alone decides the provider, so a custom endpoint never
// receives a stored key.
function storedCredential (
    stored:StoredCredentials|undefined,
    protocol:string,
    endpoint:string
):Credential|null {
    const provider = providerAt(endpoint, protocol)
    if (!provider || !stored) return null
    const found = stored.lookup(provider.name)
    if (!found || found.key === '') return null
    return {
        key:found.key,
        source:{ kind:'stored', provider:provider.name, scope:found.scope },
    }
}

// A built-in provider's standard key, else its stored key, only when the
// role is on that provider's endpoint with a protocol it accepts there.
// Throws when the store is reached and unusable.
export function ambientCredential (
    protocol:string,
    endpoint:string,
    stored:StoredCredentials|undefined,
    env:Env
):Credential {
    const provider = providerAt(endpoint, protocol)
    if (provider) {
        const key = envValue(env, provider.keyEnv)
        if (key !== '') {
            return { key, source:{ kind:'provider_env', env:provider.keyEnv } }
        }
        const fromStore = storedCredential(stored, protocol, endpoint)
        if (fromStore) return fromStore
    }
    const withheld = withheldKey(protocol, env)
    return { key:'', source:{ kind:'none', withheld } }
}

// The credential of a freshly resolved role: the role variable, the
// profile's variable, then the ambient provider key or stored key.
export function resolveCredential (
    roleName:string,
    apiKeyEnv:string,
    role:Pick<ResolvedRole, 'protocol'|'baseURL'|'stored'>,
    env:Env
):Credential {
    const roleVar = roleKeyVar(roleName)
    const roleKey = envValue(env, roleVar)
    if (roleKey !== '') {
        return { key:roleKey, source:{ kind:'role_env', env:roleVar } }
    }
    try {
        if (apiKeyEnv !== '') {
            const source:CredentialSource = {
                kind:'profile_env',
                env:apiKeyEnv,
            }
            const key = envValue(env, apiKeyEnv)
            if (key !== '') return { key, source }
            // An unset profile variable on a built-in endpoint falls back
            // to the provider's variable, then its stored key, as
            // rebindCredential does after an override.
            const ambient = ambientCredential(role.protocol, role.baseURL,
                role.stored, env)
            return ambient.key === '' ? { key:'', source } : ambient
        }
        return ambientCredential(role.protocol, role.baseURL, role.stored,
            env)
    } catch (err) {
        throw wrap(roleName, err)
    }
}

interface Overrides {
    baseURL?:string;
    protocol?:string;
}

// Applies the protocol, then the endpoint override. Returns the moved
// role and whether the protocol override moved it from one provider's
// default endpoint to another's.
function applyEndpointOverrides (
    role:ResolvedRole,
    { baseURL, protocol }:Overrides
):{ role:ResolvedRole, crossed:boolean } {
    let crossed = false
    let next = role
    if (protocol !== undefined) {
        const previousDefault = defaultBaseURL(role.protocol)
        const nextDefault = defaultBaseURL(protocol)
        next = updateRole(next, { protocol })
        if (nextDefault !== previousDefault &&
            (!role.explicitEndpoint ||
                sameEndpoint(role.baseURL, previousDefault))) {
            next = updateRole(next, { baseURL:nextDefault })
            crossed = true
        }
    }
    if (baseURL !== undefined) {
        next = updateRole(next, { baseURL, explicitEndpoint:true })
        crossed = false
    }
    return { role:next, crossed }
}

// Re-resolves a credential after the endpoint or protocol changed. A role
// key, or a profile key on an endpoint that did not cross providers,
// follows the override; any other key is checked again.
function rebindCredential (
    roleName:string,
    role:ResolvedRole,
    crossed:boolean,
    env:Env
):ResolvedRole {
    const kind = role.credential.kind
    if (kind === 'role_env') return role
    if (kind === 'profile_env' && !crossed) return role
    const roleVar = roleKeyVar(roleName)
    const roleKey = envValue(env, roleVar)
    if (roleKey !== '') {
        return updateRole(role, {
            apiKey:roleKey,
            credential:{ kind:'role_env', env:roleVar },
        })
    }
    let found:Credential
    try {
        found = ambientCredential(role.protocol, role.baseURL, role.stored,
            env)
    } catch (err) {
        throw wrap(roleName, err)
    }
    return updateRole(role, { apiKey:found.key, credential:found.source })
}

// Applies `--<role>-base-url` / `--<role>-protocol` (undefined = flag not
// given) and re-binds the credential through the same path as initial
// resolution. Throws only when a needed stored credential is unusable.
export function overrideEndpoint (
    roleName:string,
    role:ResolvedRole,
    overrides:Overrides,
    env:Env
):ResolvedRole {
    const moved = applyEndpointOverrides(role, overrides)
    return rebindCredential(roleName, moved.role, moved.crossed, env)
}

// Exposed for the override matrix tests only.
export const internal = { applyEndpointOverrides, rebindCredential }
