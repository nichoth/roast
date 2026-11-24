// Role resolution, the finder flip, and role validation (spec 02, 2.5,
// 2.10, 2.11).
import { goTrimSpace } from '../gocompat/strings.js'
import {
    type Env,
    resolveCredential,
    roleKeyVar,
} from './credential.js'
import { endpointProblem } from './endpoint.js'
import { inferFamily } from './family.js'
import { ConfigError, type ProjectConfig } from './load.js'
import { defaultBaseURL, providerAt } from './provider.js'
import {
    type ResolvedRole,
    makeRole,
    updateRole,
} from './resolved-role.js'

export { type ResolvedRole, updateRole }

export type RoleName = 'finder'|'verifier'

interface Selection {
    pin?:boolean;
    author_routes?:Record<string, string>;
}

function resolveProfile (
    cfg:ProjectConfig,
    roleName:string,
    profileName:string,
    selection:Selection,
    env:Env
):ResolvedRole {
    if (!Object.hasOwn(cfg.inference_profiles, profileName)) {
        throw new ConfigError(`role ${roleName} references unknown ` +
            `inference profile ${JSON.stringify(profileName)}`)
    }
    const p = cfg.inference_profiles[profileName]
    const routes = Object.freeze(Object.assign(Object.create(null),
        selection.author_routes ?? {})) as Record<string, string>
    const located = {
        baseURL:p.endpoint || defaultBaseURL(p.protocol),
        protocol:p.protocol,
        stored:cfg.stored,
    }
    const { key, source } = resolveCredential(roleName, p.api_key_env ?? '',
        located, env)
    return makeRole({
        ...located,
        profile:profileName,
        explicitEndpoint:Boolean(p.endpoint),
        apiKey:key,
        model:p.model ?? '',
        maxOutputTokens:p.max_output_tokens,
        sessionHeader:p.session_header ?? '',
        pin:selection.pin ?? false,
        authorRoutes:routes,
        credential:Object.freeze(source),
    })
}

// Expands a configured role into its profile settings and credential.
// Only the credential comes from outside the config.
export function resolveRole (
    cfg:ProjectConfig,
    name:RoleName,
    env:Env
):ResolvedRole {
    const selection = cfg.roles[name]
    if (!selection?.profile) {
        throw new ConfigError(`role ${JSON.stringify(name)} is not configured`)
    }
    return resolveProfile(cfg, name, selection.profile, selection, env)
}

export interface FlipResult {
    role:ResolvedRole;
    note?:string;
    warn?:string;
}

function routeTarget (
    routes:Readonly<Record<string, string>>,
    key:string
):string {
    return (key !== '' && Object.hasOwn(routes, key)) ? routes[key] : ''
}

// Keeps finder generation independent of the author: when the finder has
// a route for the author's model or family, use that profile, unless it
// is no more independent than the finder.
export function resolveFinderFlip (
    cfg:ProjectConfig,
    finder:ResolvedRole,
    authorModel:string,
    env:Env
):FlipResult {
    const authorKey = goTrimSpace(authorModel).toLowerCase()
    if (authorKey === '') return { role:finder }
    const authorFamily = inferFamily(authorModel)
    const finderFamily = inferFamily(finder.model)
    if (finder.pin) {
        if (authorFamily !== '' && finderFamily === authorFamily) {
            return {
                role:finder,
                warn:`author-model ${authorModel} shares the finder family ` +
                    `${authorFamily}, but the finder is pinned; generation ` +
                    'independence is reduced',
            }
        }
        return { role:finder }
    }
    const target = routeTarget(finder.authorRoutes, authorKey) ||
        routeTarget(finder.authorRoutes, authorFamily)
    if (target === '') {
        if (authorFamily === '') {
            return {
                role:finder,
                warn:'could not determine a model family for author-model ' +
                    `${JSON.stringify(authorModel)} and no exact author ` +
                    `route is configured; keeping finder ${finder.model}`,
            }
        }
        if (finderFamily === authorFamily) {
            return {
                role:finder,
                warn:`author-model ${authorModel} shares the finder family ` +
                    `${authorFamily} and no author route is configured; ` +
                    'generation independence is reduced',
            }
        }
        return { role:finder }
    }
    const resolved = resolveProfile(cfg, 'finder', target, {}, env)
    const targetFamily = inferFamily(resolved.model)
    if ((authorFamily !== '' &&
        (targetFamily === '' || targetFamily === authorFamily)) ||
        resolved.model.toLowerCase() === authorModel.toLowerCase()) {
        return {
            role:finder,
            warn:`author-model ${authorModel} shares the finder family ` +
                `${authorFamily} and profile ${JSON.stringify(target)} uses ` +
                `non-independent model ${JSON.stringify(resolved.model)}; ` +
                `keeping finder ${finder.model}`,
        }
    }
    const note = authorFamily === '' ?
        `author-model ${authorModel} matched an exact route; using finder ` +
            `profile ${target} (${resolved.model})` :
        `author-model ${authorModel} maps to family ${authorFamily}; using ` +
            `finder profile ${target} (${resolved.model})`
    return { role:resolved, note }
}

// A starter placeholder such as `<finder-model>`.
export function isPlaceholderModel (model:string):boolean {
    const m = goTrimSpace(model)
    return m.length > 2 && m.startsWith('<') && m.endsWith('>')
}

// The endpoint rule (spec 02, 2.4) for a resolved role or flag value.
export function validateEndpoint (
    field:string,
    baseURL:string,
    protocol:string,
    maxOutputTokens:number
):void {
    const problem = endpointProblem(field, baseURL, protocol,
        maxOutputTokens)
    if (problem) throw new ConfigError(problem)
}

function missingKey (name:string, role:ResolvedRole):string {
    const roleVar = roleKeyVar(name)
    const provider = providerAt(role.baseURL, role.protocol)
    const { kind, env, withheld } = role.credential
    const profileVar = `${env}, named by inference_profiles.` +
        `${role.profile}.api_key_env`
    const prefix = `${name} API key is not configured`
    if (provider && kind === 'profile_env') {
        return `${prefix} (run \`npx roast login ${provider.name}\`, or ` +
            `set ${profileVar}, or ${roleVar})`
    }
    if (provider) {
        return `${prefix} (run \`npx roast login ${provider.name}\`, or ` +
            `set ${provider.keyEnv} or ${roleVar})`
    }
    if (kind === 'profile_env') {
        return `${prefix} (set ${profileVar}, or ${roleVar})`
    }
    if (withheld) {
        return `${prefix}: ${withheld} is not sent to ${role.baseURL} ` +
            "because it is not that provider's default endpoint (set " +
            `inference_profiles.${role.profile}.api_key_env or ${roleVar})`
    }
    return `${prefix} (set inference_profiles.${role.profile}.api_key_env ` +
        `or ${roleVar})`
}

// Checks a fully resolved role before any model call; first failure wins.
export function validateRole (name:string, role:ResolvedRole):void {
    if (goTrimSpace(role.model) === '') {
        throw new ConfigError(`${name} model is not configured (set ` +
            `inference_profiles.${role.profile}.model or --${name}-model)`)
    }
    if (isPlaceholderModel(role.model)) {
        throw new ConfigError(`${name} model ${role.model} is a ` +
            `placeholder: set inference_profiles.${role.profile}.model in ` +
            `the project config to a model ID, or pass --${name}-model`)
    }
    if (goTrimSpace(role.apiKey) === '') {
        throw new ConfigError(missingKey(name, role))
    }
    validateEndpoint(name, role.baseURL, role.protocol, role.maxOutputTokens)
}
