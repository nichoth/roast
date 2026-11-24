// pattern: Imperative Shell
import fs from 'node:fs/promises'
import path from 'node:path'
import { starter, UnplaceableModelError } from '../config/starter.js'
import { PROJECT_CONFIG_NAME } from '../config/load.js'
import { gitRoot } from '../git/git.js'
import type { CommandDef, RunContext } from './command.js'
import { loadProjectConfig } from './config.js'
import { UsageError } from './errors.js'
import { ensureStateIgnored, STATE_IGNORE_ENTRY } from './ignore.js'
import { loginPath, loginProvider, providersNeedingLogin } from './login.js'
import { interactiveTerminals, promptYesDefault } from './terminal.js'

export async function offerLogin (
    file:string, ctx:RunContext
):Promise<void> {
    try {
        const cfg = await loadProjectConfig(file, ctx)
        const providers = providersNeedingLogin(cfg, ctx.env)
        if (providers.length === 0) return
        if (!interactiveTerminals(ctx.stdin, ctx.stderr)) {
            ctx.stderr.write('run `npx roast login` to store an API key ' +
                'for each provider the config uses\n')
            return
        }
        const target = await loginPath(false, ctx)
        for (const provider of providers) {
            const yes = await promptYesDefault(ctx.stderr, ctx.lines,
                `Log in to ${provider.name} now?`)
            if (!yes) continue
            try {
                await loginProvider(provider,
                    { global:false, noBrowser:false }, target, ctx)
            } catch (err) {
                ctx.stderr.write(`login to ${provider.name} failed: ` +
                    `${String(err)}\n`)
            }
        }
    } catch (err) {
        ctx.stderr.write(`skipping login: ${String(err)}\n`)
    }
}

export async function writeStarter (
    cwd:string, finderModel:string, verifierModel:string
):Promise<string> {
    const file = path.resolve(cwd, PROJECT_CONFIG_NAME)
    let body:string
    try {
        body = starter(finderModel, verifierModel)
    } catch (err) {
        if (!(err instanceof UnplaceableModelError)) throw err
        throw new UsageError(`--${err.role}-model: ${err.message}`,
            { cause:err })
    }
    let handle:fs.FileHandle
    try {
        handle = await fs.open(file, 'wx', 0o644)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new UsageError(`${file} already exists; edit it, ` +
                'or remove it to start over', { cause:err })
        }
        throw new Error(`create ${file}: ${String(err)}`, { cause:err })
    }
    try {
        await handle.writeFile(body)
    } catch (err) {
        await handle.close().catch(() => {})
        throw new Error(`write ${file}: ${String(err)}`, { cause:err })
    }
    try {
        await handle.close()
    } catch (err) {
        throw new Error(`close ${file}: ${String(err)}`, { cause:err })
    }
    return file
}

export const initCommand:CommandDef = {
    command:'init',
    describe:'Write a starter .roast.json in the working directory',
    builder:y => y
        .option('finder-model', {
            type:'string',
            default:'',
            describe:'Finder model ID (default: a placeholder to edit)'
        })
        .option('verifier-model', {
            type:'string',
            default:'',
            describe:'Verifier model ID (default: a placeholder to edit)'
        })
        .option('no-login', {
            type:'boolean',
            default:false,
            describe:'Do not offer to log in to the config providers'
        }),
    handler:async (args, ctx) => {
        let repo:string
        try {
            repo = await gitRoot(ctx.cwd, {
                env:ctx.env as NodeJS.ProcessEnv, signal:ctx.signal,
            })
        } catch (err) {
            if (ctx.signal.aborted) throw err
            throw new UsageError(String(err), { cause:err })
        }
        const file = await writeStarter(ctx.cwd,
            args['finder-model'] as string, args['verifier-model'] as string)
        ctx.stdout.write(`wrote ${file}\n`)
        const ignored = await ensureStateIgnored(repo)
        if (ignored.added) {
            ctx.stdout.write(`added ${STATE_IGNORE_ENTRY} ` +
                `to ${ignored.path}\n`)
        }
        if (!args['no-login']) await offerLogin(file, ctx)
    },
}
