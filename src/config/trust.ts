// The trust projection (ADR-0001) and approval hash v2 (ADR-0003, spec
// 03 sections 2.2 to 2.4). Pure: no I/O.
import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.js'
import type { NormalizedProfile, ProjectConfig } from './load.js'
import { defaultBaseURL, providerAt } from './provider.js'

// One profile a role or author route selects, reduced to where requests
// go, how, and which variable supplies the credential.
export interface TrustedProfile {
    // "roles.finder" or "roles.finder.author_routes.<family>".
    selector:string;
    profile:string;
    // The endpoint as configured, or the protocol default; not normalized.
    endpoint:string;
    protocol:string;
    // The profile's credential variable; '' when none applies.
    credentialEnv:string;
}

export interface PromptOverride {
    // "prompts.finder_code", "prompts.finder_prose", or "prompts.verifier".
    name:string;
    // The raw string from the config, unresolved.
    path:string;
}

export interface TrustProjection {
    profiles:TrustedProfile[];
    promptOverrides:PromptOverride[];
}

// Type aliases, not interfaces, so the document is a CanonicalValue.
export type Destination = {
    credential_env:string;
    endpoint:string;
    protocol:string;
}

export type HashDocument = {
    destinations:Destination[];
    prompts:{ name:string, path:string }[];
}

const PROMPT_NAMES = ['finder_code', 'finder_prose', 'verifier'] as const

function byCodeUnits (a:string, b:string):number {
    return a < b ? -1 : a > b ? 1 : 0
}

function profileEndpoint (p:NormalizedProfile):string {
    return p.endpoint || defaultBaseURL(p.protocol)
}

// The profile's own credential variable, without the role override.
function credentialEnv (p:NormalizedProfile):string {
    if (p.api_key_env) return p.api_key_env
    return providerAt(profileEndpoint(p), p.protocol)?.keyEnv ?? ''
}

export function trustProjection (cfg:ProjectConfig):TrustProjection {
    const profiles:TrustedProfile[] = []
    const add = (selector:string, name:string|undefined):void => {
        if (name === undefined) return
        if (!Object.hasOwn(cfg.inference_profiles, name)) return
        const p = cfg.inference_profiles[name]
        profiles.push({
            selector,
            profile:name,
            endpoint:profileEndpoint(p),
            protocol:p.protocol,
            credentialEnv:credentialEnv(p),
        })
    }
    const roles = cfg.roles as Record<string, ProjectConfig['roles']['finder']>
    for (const roleName of Object.keys(roles).sort(byCodeUnits)) {
        const role = roles[roleName]
        if (!role) continue
        add(`roles.${roleName}`, role.profile)
        const routes = role.author_routes ?? {}
        for (const family of Object.keys(routes).sort(byCodeUnits)) {
            add(`roles.${roleName}.author_routes.${family}`, routes[family])
        }
    }
    const promptOverrides:PromptOverride[] = []
    for (const name of PROMPT_NAMES) {
        const path = cfg.prompts?.[name] ?? ''
        if (path !== '') promptOverrides.push({ name:`prompts.${name}`, path })
    }
    return { profiles, promptOverrides }
}

// On a built-in provider's endpoint, with a protocol it accepts and its
// standard key variable.
function standard (p:TrustedProfile):boolean {
    const provider = providerAt(p.endpoint, p.protocol)
    return provider !== undefined && p.credentialEnv === provider.keyEnv
}

export function requiresApproval (p:TrustProjection):boolean {
    return p.promptOverrides.length > 0 || !p.profiles.every(standard)
}

function compareDestinations (a:Destination, b:Destination):number {
    return byCodeUnits(a.endpoint, b.endpoint) ||
        byCodeUnits(a.protocol, b.protocol) ||
        byCodeUnits(a.credential_env, b.credential_env)
}

// The JSON value the approval hash covers: deduplicated, sorted
// destinations and the prompt overrides in projection order. Selectors
// and profile names are left out.
export function trustHashDocument (p:TrustProjection):HashDocument {
    const destinations:Destination[] = []
    for (const profile of p.profiles) {
        const d:Destination = {
            credential_env:profile.credentialEnv,
            endpoint:profile.endpoint,
            protocol:profile.protocol,
        }
        if (!destinations.some(x => compareDestinations(x, d) === 0)) {
            destinations.push(d)
        }
    }
    destinations.sort(compareDestinations)
    const prompts = p.promptOverrides.map(o => ({
        name:o.name,
        path:o.path,
    }))
    return { destinations, prompts }
}

// `sha256:<hex>` over the canonical JSON of the hash document.
export function trustHash (p:TrustProjection):string {
    const text = canonicalJson(trustHashDocument(p))
    return 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex')
}
