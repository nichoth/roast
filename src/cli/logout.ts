// pattern: Imperative Shell
// Logout uses the login scope rules and the credential store's safe
// deletion operation; it never contacts a provider.
import { builtinProviders, lookupProvider } from '../config/provider.js'
import {
    deleteCredential,
    loadCredentials,
    prepareProjectCredentials,
} from '../credentials/credentials.js'
import { goQuote } from '../gocompat/strings.js'
import type { CommandDef } from './command.js'
import { UsageError } from './errors.js'
import {
    loginPath,
    providerNames,
    type LoginContext,
} from './login.js'

export async function runLogout (
    name:string|undefined,
    global:boolean,
    ctx:LoginContext
):Promise<void> {
    const named = name === undefined ? undefined : lookupProvider(name)
    if (name !== undefined && !named) {
        throw new UsageError(`unknown provider ${goQuote(name)}; ` +
            `built-in providers: ${providerNames()}`)
    }
    const providers = named ? [named] : builtinProviders()
    const target = await loginPath(global, ctx)
    const opts = { env:ctx.env, signal:ctx.signal }
    if (target.scope === 'project') {
        await prepareProjectCredentials(target.path, opts)
    }
    const entries = await loadCredentials(target.path)
    for (const provider of providers) {
        if (!entries.has(provider.name)) {
            if (named) {
                ctx.stdout.write(`no ${provider.name} credential stored ` +
                    `(${target.scope} scope)\n`)
            }
            continue
        }
        await deleteCredential(target.path, provider.name, opts)
        ctx.stdout.write(`removed ${provider.name} credential ` +
            `(${target.scope} scope)\n`)
        ctx.stderr.write(`The key was not revoked at ${provider.name}; ` +
            `revoke it at:\n  ${provider.keyPage}\n`)
    }
}

export const logoutCommand:CommandDef = {
    command:'logout [provider]',
    describe:'Remove a stored API key',
    builder:y => y
        .positional('provider', { type:'string' })
        .option('global', {
            type:'boolean',
            default:false,
            describe:'Remove the credential stored for the user',
        }),
    handler:(args, ctx) => runLogout(
        args.provider === undefined ? undefined : String(args.provider),
        args.global === true, ctx),
}
