// The gate offer before bare `roast` and `review` (spec 01, 2.9). The
// offer and its setting come from the config the hook will load, at the
// Git toplevel; without one there is nothing to offer, since the hook
// would let every commit through unreviewed. Nothing here fails the
// command.
import { gateOffers, loadConfig, type ProjectConfig } from '../config/load.js'
import { bootstrap } from '../gate/bootstrap.js'
import { gitRoot } from '../git/git.js'
import type { RunContext } from './command.js'
import { gateConfigPath } from './config.js'
import { interactiveTerminals, promptYesDefault } from './terminal.js'

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// The toplevel config, or null when there is none or it fails to load
// (the review reports that error itself).
async function toplevelConfig (
    ctx:RunContext
):Promise<{ repo:string, cfg:ProjectConfig }|null> {
    try {
        const repo = await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
        const file = gateConfigPath(repo)
        if (file === '') return null
        return { repo, cfg:loadConfig(file) }
    } catch (err) {
        if (ctx.signal.aborted) throw err
        return null
    }
}

export async function maybeBootstrapGate (ctx:RunContext):Promise<void> {
    if (ctx.errorFormat === 'json') return
    const found = await toplevelConfig(ctx)
    if (!found) return
    const terminals = interactiveTerminals(ctx.stdin, ctx.stderr)
    try {
        await bootstrap({
            repo:found.repo,
            env:ctx.env,
            noOffer:!gateOffers(found.cfg),
            out:line => { ctx.stderr.write(`roast: ${line}\n`) },
            prompt:terminals ?
                question => promptYesDefault(ctx.stderr, ctx.lines, question) :
                undefined,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        ctx.stderr.write(
            `roast: pre-commit gate setup skipped: ${message(err)}\n`)
    }
}
