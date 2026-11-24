// `roast skill install|status`: install or inspect the bundled agent skill
// in the project's or the user's agent skill directories.
import type { Argv } from 'yargs'
import { gitRoot } from '../git/git.js'
import {
    inspect,
    install,
    installationTargets,
    type InstallationTarget,
    type SkillStatus,
} from '../skill/skill.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { UsageError } from './errors.js'

// Where skill commands operate: --dir wins, then --global selects the
// user-level directories, and otherwise the project's agent skill
// directories at the Git toplevel.
export async function skillTargets (
    dir:string,
    global:boolean,
    ctx:RunContext
):Promise<InstallationTarget[]> {
    const opts = { env:ctx.env }
    if (dir || global) return installationTargets(dir, '', opts)
    let root:string
    try {
        root = await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        const msg = err instanceof Error ? err.message : String(err)
        throw new UsageError(
            `${msg}; run inside a project or pass --global`, { cause:err })
    }
    return installationTargets('', root, opts)
}

function stringFlag (args:CommandArgs, name:string):string {
    const v = args[name]
    return typeof v === 'string' ? v : ''
}

function flagsFor (args:CommandArgs):{ dir:string, global:boolean } {
    return { dir:stringFlag(args, 'dir'), global:args.global === true }
}

async function installHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const { dir, global } = flagsFor(args)
    const force = args.force === true
    const targets = await skillTargets(dir, global, ctx)
    const before:SkillStatus[] = []
    for (const target of targets) {
        const status = await inspect(target.path)
        if (status.state === 'stale' && !force) {
            throw new Error(`${target.harness} skill files differ (${
                status.stale.join(', ')}); re-run with --force to overwrite`)
        }
        before.push(status)
    }
    for (const [i, target] of targets.entries()) {
        const after = await install(target.path, force)
        const prior = before[i].state
        const what = prior === 'symlink' ?
            'symlink (development install), left unchanged' :
            prior === 'up_to_date' ?
                'already up to date' :
                `installed (${after.state})`
        ctx.stdout.write(`${target.harness}\t${what}\t${target.path}\n`)
    }
}

async function statusHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const { dir, global } = flagsFor(args)
    for (const target of await skillTargets(dir, global, ctx)) {
        const status = await inspect(target.path)
        let line = `${target.harness}\t${status.state}\t${status.path}`
        if (status.stale.length > 0) line += `\t${status.stale.join(',')}`
        ctx.stdout.write(line + '\n')
    }
}

export const skillCommand:CommandDef = {
    command:'skill',
    describe:'Manage the Roast agent skill',
    subcommands:[
        {
            command:'install',
            describe:'Install the Roast agent skill',
            builder:(y:Argv) => y
                .option('dir', {
                    type:'string',
                    describe:'install only below this parent skills ' +
                        'directory; /roast is appended',
                })
                .option('global', {
                    type:'boolean',
                    describe:'install into the user-level skill ' +
                        'directories instead of the project',
                })
                .option('force', {
                    type:'boolean',
                    describe:'overwrite installed skill files that differ',
                }),
            handler:installHandler,
        },
        {
            command:'status',
            describe:'Report the Roast agent skill installation status',
            builder:(y:Argv) => y
                .option('global', {
                    type:'boolean',
                    describe:'inspect the user-level skill directories ' +
                        'instead of the project',
                })
                .option('dir', {
                    type:'string',
                    describe:'inspect only below this parent skills ' +
                        'directory; /roast is appended',
                }),
            handler:statusHandler,
        },
    ],
}
