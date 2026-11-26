// `roast ignore` (spec 12, 2.13): adds the run-record state directory to
// the toplevel .gitignore. `init` reuses ensureStateIgnored.
import { gitRoot } from '../git/git.js'
import { appendIgnoreEntries } from '../git/ignore.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { UsageError } from './errors.js'

// Roast's project-local state directory at the Git toplevel.
const STATE_DIR = '.roast'

export const STATE_IGNORE_ENTRY = `/${STATE_DIR}/`

// Lines that already ignore the toplevel state directory.
const EQUIVALENT = new Set([
    `/${STATE_DIR}/`, `/${STATE_DIR}`, `${STATE_DIR}/`, STATE_DIR,
])

export async function ensureStateIgnored (
    repo:string
):Promise<{ path:string, added:boolean }> {
    return appendIgnoreEntries(repo, new Map([
        [STATE_IGNORE_ENTRY, EQUIVALENT],
    ]))
}

async function ignoreHandler (
    _args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    let repo:string
    try {
        repo = await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        const msg = err instanceof Error ? err.message : String(err)
        throw new UsageError(msg, { cause:err })
    }
    const { path:file, added } = await ensureStateIgnored(repo)
    ctx.stdout.write(added ?
        `added ${STATE_IGNORE_ENTRY} to ${file}\n` :
        `${file} already ignores ${STATE_IGNORE_ENTRY}\n`)
}

export const ignoreCommand:CommandDef = {
    command:'ignore',
    describe:`Add ${STATE_IGNORE_ENTRY} to the toplevel .gitignore`,
    handler:ignoreHandler,
}
