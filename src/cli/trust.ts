// `roast trust` and the review-time trust check (spec 03, 2.7 to 2.9).
// A config that sends code or credentials anywhere but a built-in
// provider's standard endpoint and key variable, or that replaces a
// prompt, must be approved for this clone before anything is sent.
import type { Argv } from 'yargs'
import type { ProjectConfig } from '../config/load.js'
import {
    type TrustProjection,
    requiresApproval,
    trustHash,
    trustProjection,
} from '../config/trust.js'
import { gitRoot } from '../git/git.js'
import { line } from '../textsafe/textsafe.js'
import { approve, isApproved } from '../trust/trust.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { loadProjectConfig } from './config.js'
import { UsageError } from './errors.js'
import { interactiveTerminals, promptNoDefault } from './terminal.js'

const QUESTION = 'Trust this project config?'
const APPROVED = 'Approved for this clone.\n'

export const NOT_APPROVED = 'the project config names endpoints, ' +
    'credential variables, or prompt files that are not approved for this ' +
    'clone; review and approve them with `npx roast trust`'

export const LEGACY_APPROVAL = 'this clone\'s approvals were recorded by ' +
    'an older Roast and are no longer accepted; review and approve the ' +
    'project config again with `npx roast trust`'

// What requireTrust may touch: the CLI context without its command
// details.
export type TrustIo = Pick<RunContext,
    'stdin'|'stderr'|'lines'|'env'|'signal'>

// Prints every security-relevant value of the projection, each escaped to
// one line so config text cannot add lines or terminal escapes.
export function writeTrustSummary (
    out:NodeJS.WritableStream,
    p:TrustProjection
):void {
    let text = 'This project config sends code and credentials to:\n'
    for (const profile of p.profiles) {
        const credential = profile.credentialEnv === '' ?
            '(none named)' :
            line(profile.credentialEnv)
        text += `  ${line(profile.selector)}: profile ` +
            `${line(profile.profile)}\n` +
            `    endpoint:   ${line(profile.endpoint)}\n` +
            `    protocol:   ${line(profile.protocol)}\n` +
            `    credential: ${credential}\n`
    }
    if (p.promptOverrides.length > 0) {
        text += 'and replaces prompts with these files:\n'
        for (const o of p.promptOverrides) {
            text += `  ${line(o.name)}: ${line(o.path)}\n`
        }
    }
    out.write(text)
}

// Fails unless the config needs no approval or this clone approved it.
// On terminals it asks inline (on stderr); elsewhere it never reads
// stdin. A trust record that cannot be read is not a usage error.
export async function requireTrust (
    dir:string,
    cfg:ProjectConfig,
    io:TrustIo
):Promise<void> {
    const p = trustProjection(cfg)
    if (!requiresApproval(p)) return
    const hash = trustHash(p)
    const opts = { env:io.env as NodeJS.ProcessEnv, signal:io.signal }
    const state = await isApproved(dir, hash, opts)
    if (state === 'approved') return
    if (!interactiveTerminals(io.stdin, io.stderr)) {
        throw new UsageError(state === 'legacy' ?
            LEGACY_APPROVAL :
            NOT_APPROVED)
    }
    if (state === 'legacy') {
        io.stderr.write('The existing approvals for this clone came from ' +
            'an older Roast and are no longer accepted.\n')
    }
    writeTrustSummary(io.stderr, p)
    if (!await promptNoDefault(io.stderr, io.lines, QUESTION)) {
        throw new UsageError('project config not approved; nothing ' +
            'recorded and nothing sent')
    }
    await approve(dir, hash, opts)
    io.stderr.write(APPROVED)
}

async function trustHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    let root:string
    try {
        root = await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        throw new UsageError('not inside a git repository', { cause:err })
    }
    const explicit = typeof args.config === 'string' ? args.config : ''
    const cfg = await loadProjectConfig(explicit, ctx)
    const p = trustProjection(cfg)
    writeTrustSummary(ctx.stdout, p)
    if (!requiresApproval(p)) {
        ctx.stdout.write('Only default provider endpoints and key ' +
            'variables are used; no approval is needed.\n')
        return
    }
    if (args.yes !== true &&
        !await promptNoDefault(ctx.stdout, ctx.lines, QUESTION)) {
        throw new UsageError('not approved; nothing recorded')
    }
    await approve(root, trustHash(p), {
        env:ctx.env as NodeJS.ProcessEnv,
        signal:ctx.signal,
    })
    ctx.stdout.write(APPROVED)
}

export const trustCommand:CommandDef = {
    command:'trust',
    describe:'Approve the project config\'s endpoints and credentials',
    builder:(y:Argv) => y
        .option('config', {
            type:'string',
            describe:'project config file (default: nearest .roast.jsonc)',
        })
        .option('yes', {
            type:'boolean',
            describe:'record approval without asking',
        }),
    handler:trustHandler,
}
