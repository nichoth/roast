// pattern: Imperative Shell
import path from 'node:path'
import fs from 'node:fs/promises'
import { git } from '../git/git.js'
import type { GitRunOpts } from '../git/git.js'
import { goTrimSpace } from '../gocompat/strings.js'

export const STATE_DIR = '.roast'

export class NoRecordDirError extends Error {
    constructor () {
        super('resolve record directory: run inside a Git repository')
        this.name = 'NoRecordDirError'
    }
}

export function isValidName (name:string):boolean {
    return name !== '' && name !== '.' && name !== '..' &&
        !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

export async function ensureDir (dir:string):Promise<void> {
    if (!dir) throw new NoRecordDirError()
    const state = path.dirname(dir)
    try {
        await fs.lstat(state)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        await fs.mkdir(state, { recursive:true, mode:0o700 })
        await fs.writeFile(path.join(state, '.gitignore'), '*\n', {
            mode:0o644,
        })
    }
    await fs.mkdir(dir, { recursive:true, mode:0o700 })
}

export async function makeRunDir (
    dir:string,
    runId:string
):Promise<string> {
    if (!isValidName(runId)) {
        throw new Error(`invalid run id ${JSON.stringify(runId)}`)
    }
    await ensureDir(dir)
    const runDir = path.join(dir, runId)
    await fs.mkdir(runDir, { recursive:true, mode:0o700 })
    for (const target of [dir, runDir]) await fs.chmod(target, 0o700)
    return runDir
}

export async function openPrivate (
    file:string,
    flags:string|number
):Promise<fs.FileHandle> {
    const handle = await fs.open(file, flags, 0o600)
    try {
        await handle.chmod(0o600)
        return handle
    } catch (err) {
        await handle.close().catch(() => {})
        throw err
    }
}

export async function writePrivate (
    file:string,
    data:string|Uint8Array
):Promise<void> {
    const handle = await openPrivate(file, 'w')
    try {
        await handle.writeFile(data)
    } finally {
        await handle.close()
    }
}

export async function recordDir (
    cwd:string,
    opts:GitRunOpts = {}
):Promise<string> {
    try {
        const out = await git(cwd, ['rev-parse', '--show-toplevel'], opts)
        const top = goTrimSpace(out.toString())
        return top ? path.join(top, STATE_DIR, 'runs') : ''
    } catch (err) {
        if (opts.signal?.aborted) throw err
        return ''
    }
}
