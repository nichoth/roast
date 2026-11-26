// `roast gate enable|disable|status` and the hidden `gate settings` the
// pre-commit hook calls (spec 12, 2.10).
import type { Argv } from 'yargs'
import { recordDecision } from '../gate/decision.js'
import { manualLine } from '../gate/constants.js'
import { inspect, install, remove, summary } from '../gate/hook.js'
import { gitRoot } from '../git/git.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { NO_GATE_CONFIG, gateConfigPath, loadProjectConfig } from './config.js'
import { UsageError } from './errors.js'

import {
    GATE_DEFAULT_TIMEOUT, GATE_DEFAULT_SEVERITY,
} from '../config/defaults.js'
export {
    GATE_DEFAULT_TIMEOUT, GATE_DEFAULT_SEVERITY,
} from '../config/defaults.js'

// Prints the gate's timeout and severity from the config, or their
// defaults. The environment never changes them.
async function settingsHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const explicit = typeof args.config === 'string' ? args.config : ''
    const cfg = await loadProjectConfig(explicit, ctx)
    const timeout = cfg.gate?.timeout_seconds ?? GATE_DEFAULT_TIMEOUT
    const severity = cfg.gate?.severity ?
        cfg.gate.severity.toUpperCase() :
        GATE_DEFAULT_SEVERITY
    ctx.stdout.write(`timeout_seconds=${timeout}\nseverity=${severity}\n`)
}

const settingsCommand:CommandDef = {
    command:'settings',
    describe:false,
    builder:(y:Argv) => y.option('config', {
        type:'string',
        describe:'project config file (default: nearest .roast.jsonc)',
    }),
    handler:settingsHandler,
}

// The Git toplevel of the working directory.
async function repoRoot (ctx:RunContext):Promise<string> {
    try {
        return await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        throw new UsageError('not inside a Git repository', { cause:err })
    }
}

// Installs the gate and records consent, also when the hook is foreign
// and the user must add the manual line. The toplevel config must exist
// (the hook sees no other) but is not loaded or trust-checked.
async function enableHandler (
    _args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const repo = await repoRoot(ctx)
    let config:string
    try {
        config = gateConfigPath(repo)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new UsageError(msg, { cause:err })
    }
    if (config === '') throw new UsageError(NO_GATE_CONFIG)
    const { action, status } = await install(repo, ctx.env)
    await recordDecision(repo, 'enabled', ctx.env)
    const p = status.hookPath
    if (action === 'manual') {
        ctx.stdout.write(`${p} is not an appendable shell script; Roast ` +
            'left it untouched.\nAdd this line manually:\n\n    ' +
            `${manualLine()}\n`)
        return
    }
    const line = {
        installed:`gate installed: ${p}`,
        appended:`gate appended to existing hook: ${p}`,
        refreshed:`gate refreshed: ${p}`,
        'up-to-date':`gate already up to date: ${p}`,
    }[action]
    ctx.stdout.write(`${line}\nbypass one commit with: ROAST_SKIP=1 git ` +
        'commit ...\n')
}

async function disableHandler (
    _args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const repo = await repoRoot(ctx)
    const { action, status } = await remove(repo, ctx.env)
    await recordDecision(repo, 'declined', ctx.env)
    const line = action === 'removed' ?
        `gate removed from ${status.hookPath}` :
        action === 'preserved' ?
            'gate disabled for this repository; shared dispatcher ' +
                `preserved at ${status.hookPath}` :
            'no Roast gate was installed; recorded the decline'
    ctx.stdout.write(line + '\n')
}

async function statusHandler (
    _args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const repo = await repoRoot(ctx)
    const status = await inspect(repo, ctx.env)
    const decision = status.decision === 'none' ?
        'none recorded' :
        status.decision
    ctx.stdout.write(`repo:     ${status.repo}\n` +
        `gate:     ${summary(status)}\n` +
        `decision: ${decision}\n`)
}

export const gateCommand:CommandDef = {
    command:'gate',
    describe:'Manage the native Git pre-commit review gate',
    subcommands:[
        {
            command:'status',
            describe:'Report gate status for this repository',
            handler:statusHandler,
        },
        {
            command:'enable',
            describe:'Install the pre-commit gate in this repository',
            handler:enableHandler,
        },
        {
            command:'disable',
            describe:'Disable the Roast pre-commit gate in this repository',
            handler:disableHandler,
        },
        settingsCommand,
    ],
}
