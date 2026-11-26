// pattern: Imperative Shell
// Paste login uses only the registry's built-in endpoints and the
// command's shared reader, fetch, environment, and cancellation signal.
import {
    builtinProviders,
    lookupProvider,
    providerAt,
    type BuiltinProvider,
} from '../config/provider.js'
import { browserLogin } from './openrouter-login.js'
import type { Env } from '../config/credential.js'
import type { ProjectConfig } from '../config/load.js'
import { resolveRole, type RoleName } from '../config/role.js'
import {
    prepareProjectCredentials,
    projectCredentialsPath,
    saveCredential,
    userCredentialsPath,
    type CredentialScope,
} from '../credentials/credentials.js'
import { goQuote } from '../gocompat/strings.js'
import { abortable } from '../llm/capture.js'
import { AuthError, EndpointError } from '../llm/errors.js'
import type { CommandDef, RunContext } from './command.js'
import { UsageError } from './errors.js'
import { loadProjectConfig, NO_PROJECT_CONFIG } from './config.js'
import { interactiveTerminals, openBrowser, readSecret } from './terminal.js'

export type LoginContext = Pick<RunContext,
    'cwd'|'env'|'signal'|'fetch'|'stdin'|'stdout'|'stderr'|'lines'>

export interface LoginFlags {
    global:boolean;
    noBrowser:boolean;
}

export interface LoginTarget {
    path:string;
    scope:CredentialScope;
}

export function providerNames ():string {
    return builtinProviders().map(p => p.name).join(', ')
}

export async function loginPath (
    global:boolean,
    ctx:LoginContext
):Promise<LoginTarget> {
    if (global) {
        return { path:userCredentialsPath(ctx.env), scope:'user' }
    }
    try {
        const path = await projectCredentialsPath(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
        return { path, scope:'project' }
    } catch (err) {
        if (ctx.signal.aborted) throw err
        throw new UsageError('not in a Git repository; use --global ' +
            'to store the key for the user', { cause:err })
    }
}

export function keyCheckPath (provider:BuiltinProvider):string {
    return provider.name === 'openrouter' ? '/key' : '/models'
}

class KeyRejected extends Error {}

// Discard at most 32 KiB, then cancel even if the provider keeps sending.
async function drainValidationBody (
    response:Response,
    signal:AbortSignal
):Promise<void> {
    if (!response.body) return
    const reader = response.body.getReader()
    let size = 0
    try {
        while (size < 32 * 1024) {
            const chunk = await abortable(reader.read(), signal)
            if (chunk.done) return
            size += chunk.value.byteLength
        }
    } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

export async function validateKey (
    provider:BuiltinProvider,
    key:string,
    ctx:LoginContext
):Promise<void> {
    const url = provider.endpoint.replace(/\/+$/, '') +
        keyCheckPath(provider)
    const signal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(30_000),
    ])
    const prefix = 'llm: inference endpoint failure: check key at ' + url
    let response:Response
    try {
        response = await ctx.fetch(url, {
            method:'GET',
            redirect:'manual',
            signal,
            headers:provider.protocols[0] === 'anthropic' ? {
                'x-api-key':key,
                'anthropic-version':'2023-06-01',
            } : { Authorization:`Bearer ${key}` },
        })
        await drainValidationBody(response, signal)
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new EndpointError(`${prefix}: ${message}`, { cause:err })
    }
    if (response.status >= 300 && response.status < 400) {
        throw new EndpointError(`${prefix}: redirect refused`)
    }
    if (response.status === 401 || response.status === 403) {
        throw new KeyRejected()
    }
    if (!response.ok) {
        throw new EndpointError(`${prefix}: HTTP ${response.status} ` +
            response.statusText)
    }
}

async function pasteLogin (
    provider:BuiltinProvider,
    flags:LoginFlags,
    ctx:LoginContext
):Promise<string> {
    ctx.stderr.write(`Create a ${provider.name} API key at:\n` +
        `  ${provider.keyPage}\n`)
    if (!flags.noBrowser) {
        const err = await openBrowser(provider.keyPage, ctx.signal)
        if (err) {
            ctx.stderr.write(`could not open a browser (${err.message}); ` +
                'open the URL above\n')
        }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        let key:string
        try {
            key = await readSecret(ctx.stderr, ctx.stdin, ctx.lines,
                'Paste the key: ')
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(`read key: ${message}`, { cause:err })
        }
        if (key === '') {
            ctx.stderr.write('no key entered\n')
            continue
        }
        try {
            await validateKey(provider, key, ctx)
            return key
        } catch (err) {
            if (!(err instanceof KeyRejected)) throw err
            ctx.stderr.write(`${provider.name} rejected the key; ` +
                'try again\n')
        }
    }
    throw new AuthError('llm: authentication failed: no accepted ' +
        `${provider.name} key after 3 tries; nothing stored`)
}

export async function runLogin (
    name:string,
    flags:LoginFlags,
    ctx:LoginContext
):Promise<void> {
    const provider = lookupProvider(name)
    if (!provider) {
        throw new UsageError(`unknown provider ${goQuote(name)}; ` +
            `built-in providers: ${providerNames()}`)
    }
    if (!interactiveTerminals(ctx.stdin, ctx.stderr)) {
        throw new UsageError('login needs an interactive terminal; ' +
            `set ${provider.keyEnv} instead`)
    }
    const target = await loginPath(flags.global, ctx)
    await loginProvider(provider, flags, target, ctx)
}

export async function loginProvider (
    provider:BuiltinProvider,
    flags:LoginFlags,
    target:LoginTarget,
    ctx:LoginContext
):Promise<void> {
    const key = provider.login === 'browser' ?
        await browserLogin(provider, flags, ctx) :
        await pasteLogin(provider, flags, ctx)
    if (provider.login === 'browser') {
        try {
            await validateKey(provider, key, ctx)
        } catch (err) {
            if (!(err instanceof KeyRejected)) throw err
            throw new AuthError('llm: authentication failed: openrouter ' +
                'rejected the key it minted; nothing stored')
        }
    }
    const opts = { env:ctx.env, signal:ctx.signal }
    if (target.scope === 'project') {
        await prepareProjectCredentials(target.path, opts)
    }
    await saveCredential(target.path, provider.name, key, new Date(), opts)
    ctx.stdout.write(`stored ${provider.name} credential ` +
        `(${target.scope} scope)\n`)
}

export function providersNeedingLogin (
    cfg:ProjectConfig,
    env:Env
):Array<BuiltinProvider> {
    const providers:Array<BuiltinProvider> = []
    for (const name of Object.keys(cfg.roles).sort()) {
        let role
        try {
            role = resolveRole(cfg, name as RoleName, env)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            throw new UsageError(message, { cause:err })
        }
        if (role.apiKey !== '') continue
        const provider = providerAt(role.baseURL, role.protocol)
        if (provider && !providers.some(p => p.name === provider.name)) {
            providers.push(provider)
        }
    }
    return providers
}

export async function runLoginMissing (
    flags:LoginFlags,
    ctx:LoginContext
):Promise<void> {
    let cfg:ProjectConfig
    try {
        cfg = await loadProjectConfig('', ctx)
    } catch (err) {
        if (err instanceof UsageError && err.message === NO_PROJECT_CONFIG) {
            throw new UsageError('no project config (.roast.jsonc) found; ' +
                'name a provider (`npx roast login <provider>`, one of ' +
                `${providerNames()}) or run \`npx roast init\``)
        }
        throw err
    }
    const providers = providersNeedingLogin(cfg, ctx.env)
    if (providers.length === 0) {
        ctx.stderr.write('every built-in provider the roles use already ' +
            'has a credential\n')
        return
    }
    if (!interactiveTerminals(ctx.stdin, ctx.stderr)) {
        throw new UsageError('login needs an interactive terminal')
    }
    const target = await loginPath(flags.global, ctx)
    for (const provider of providers) {
        await loginProvider(provider, flags, target, ctx)
    }
}

export const loginCommand:CommandDef = {
    command:'login [provider]',
    describe:'Store an API key for a built-in provider',
    builder:y => y
        .positional('provider', { type:'string' })
        .option('global', {
            type:'boolean',
            default:false,
            describe:'Store the credential for the user',
        })
        .option('no-browser', {
            type:'boolean',
            default:false,
            describe:'Print the key page URL without opening a browser',
        }),
    handler:(args, ctx) => {
        const flags = {
            global:args.global === true,
            noBrowser:args['no-browser'] === true,
        }
        return args.provider === undefined ? runLoginMissing(flags, ctx) :
            runLogin(String(args.provider), flags, ctx)
    },
}
