// Shared helpers for role and credential tests at the module seam.
import {
    type ProjectConfig,
    type StoredCredentials,
    decode,
    normalize,
    withStoredCredentials,
} from '../../src/config/load.js'
import type { Env } from '../../src/config/credential.js'
import { type ResolvedRole, resolveRole } from '../../src/config/role.js'

export const CUSTOM_ENDPOINT = 'https://template-endpoint.example/v1'
export const AMBIENT_GATEWAY = 'https://ambient-gateway.example/v1'
export const OPENROUTER = 'https://openrouter.ai/api/v1'

// A config from JSON text, normalized as loadConfig would.
export function configFrom (doc:object):ProjectConfig {
    return normalize(decode(JSON.stringify({ version:1, ...doc })), '')
}

// A config whose finder uses `profile` and whose verifier has a model.
export function finderConfig (
    profile:Record<string, unknown>,
    store?:StoredCredentials
):ProjectConfig {
    const cfg = configFrom({
        inference_profiles:{ finder:profile, verifier:{ model:'v' } },
        roles:{ finder:{ profile:'finder' }, verifier:{ profile:'verifier' } },
    })
    return store ? withStoredCredentials(cfg, store) : cfg
}

export function resolveFinder (
    profile:Record<string, unknown>,
    env:Env,
    store?:StoredCredentials
):ResolvedRole {
    return resolveRole(finderConfig(profile, store), 'finder', env)
}

// Answers lookups from fixed maps, project scope first, as the real
// credentials store does; records every provider asked for.
export class FakeStore implements StoredCredentials {
    lookups:string[] = []
    constructor (
        readonly project:Record<string, string> = {},
        readonly user:Record<string, string> = {},
        readonly err?:Error
    ) {}

    lookup (provider:string):{ key:string, scope:'project'|'user' }|null {
        this.lookups.push(provider)
        if (this.err) throw this.err
        if (Object.hasOwn(this.project, provider)) {
            return { key:this.project[provider], scope:'project' }
        }
        if (Object.hasOwn(this.user, provider)) {
            return { key:this.user[provider], scope:'user' }
        }
        return null
    }
}

// A project and a user key for every built-in provider.
export function bothStored ():FakeStore {
    const project:Record<string, string> = {}
    const user:Record<string, string> = {}
    for (const name of ['openai', 'anthropic', 'openrouter']) {
        project[name] = `project-${name}`
        user[name] = `user-${name}`
    }
    return new FakeStore(project, user)
}

// The error `fn` throws, or undefined.
export function thrown (fn:() => unknown):Error|undefined {
    try {
        fn()
    } catch (err) {
        return err as Error
    }
    return undefined
}
