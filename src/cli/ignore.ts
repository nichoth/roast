// `roast ignore` (spec 12, 2.13): adds the run-record state directory to
// the toplevel .gitignore. `init` reuses ensureStateIgnored.
import fs from 'node:fs/promises'
import path from 'node:path'
import { gitRoot } from '../git/git.js'
import { goTrimSpace } from '../gocompat/strings.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { UsageError } from './errors.js'

// Roast's project-local state directory at the Git toplevel.
const STATE_DIR = '.roast'

export const STATE_IGNORE_ENTRY = `/${STATE_DIR}/`

// Lines that already ignore the toplevel state directory.
const EQUIVALENT = new Set([
    `/${STATE_DIR}/`, `/${STATE_DIR}`, `${STATE_DIR}/`, STATE_DIR,
])

function fail (text:string, err:unknown):Error {
    const msg = err instanceof Error ? err.message : String(err)
    return new Error(`${text}: ${msg}`, { cause:err })
}

// Appends STATE_IGNORE_ENTRY to <repo>/.gitignore unless an equivalent
// line is present, creating the file and terminating an unterminated last
// line first. Reports the path and whether the file changed.
export async function ensureStateIgnored (
    repo:string
):Promise<{ path:string, added:boolean }> {
    const file = path.join(repo, '.gitignore')
    let data = Buffer.alloc(0)
    try {
        data = await fs.readFile(file)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw fail(`read ${file}`, err)
        }
    }
    const lines = data.toString('utf8').split('\n')
    if (lines.some(line => EQUIVALENT.has(goTrimSpace(line)))) {
        return { path:file, added:false }
    }
    let addition = `${STATE_IGNORE_ENTRY}\n`
    if (data.length > 0 && data[data.length - 1] !== 0x0a) {
        addition = '\n' + addition
    }
    let handle:fs.FileHandle
    try {
        handle = await fs.open(file, 'a', 0o644)
    } catch (err) {
        throw fail(`open ${file}`, err)
    }
    try {
        await handle.write(addition)
    } catch (err) {
        await handle.close().catch(() => {})
        throw fail(`append ${file}`, err)
    }
    try {
        await handle.close()
    } catch (err) {
        throw fail(`close ${file}`, err)
    }
    return { path:file, added:true }
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
