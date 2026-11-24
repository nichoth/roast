// Flag -> config -> default resolution (spec 01, 2.14), the --lang
// packs (2.8 step 11), and role flag overrides (2.8 step 3).
import type { Env } from '../config/credential.js'
import { overrideEndpoint } from '../config/credential.js'
import { type ResolvedRole, updateRole } from '../config/resolved-role.js'
import type { GoDuration } from '../gocompat/duration.js'
import type { RoleFlags } from './review-flags.js'

export { resolveLangs } from '../review/classify.js'

// The flag value when the flag was given, else the configured value,
// else `fallback`. An explicit 0 counts as given or configured.
export function flagOrConfig<T> (
    flag:T|undefined,
    configured:T|undefined|null,
    fallback:T
):T {
    if (flag !== undefined) return flag
    return configInt(configured, fallback)
}

// The configured value when set, else `fallback`.
export function configInt<T> (configured:T|undefined|null, fallback:T):T {
    return configured === undefined || configured === null ?
        fallback :
        configured
}

export function flagOrConfigInt (
    changed:boolean,
    flag:number,
    configured:number|undefined|null,
    fallback:number
):number {
    return changed ? flag : configInt(configured, fallback)
}

export function flagOrConfigDuration (
    changed:boolean,
    flag:GoDuration,
    configured:GoDuration|undefined|null,
    fallback:GoDuration
):GoDuration {
    return changed ? flag : configInt(configured, fallback)
}

// Applies --<role>-base-url / -protocol (re-binding the credential),
// then --<role>-model and --<role>-max-output-tokens.
export function applyRoleFlags (
    name:'finder'|'verifier',
    role:ResolvedRole,
    flags:RoleFlags,
    env:Env
):ResolvedRole {
    let next = role
    if (flags.baseUrl !== undefined || flags.protocol !== undefined) {
        next = overrideEndpoint(name, next, {
            baseURL:flags.baseUrl,
            protocol:flags.protocol,
        }, env)
    }
    if (flags.model !== undefined) {
        next = updateRole(next, { model:flags.model })
    }
    if (flags.maxOutputTokens !== undefined) {
        next = updateRole(next, { maxOutputTokens:flags.maxOutputTokens })
    }
    return next
}
