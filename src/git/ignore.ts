// pattern: Imperative Shell
import { constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { goTrimSpace } from '../gocompat/strings.js'

function fail (text:string, err:unknown):Error {
    const msg = err instanceof Error ? err.message : String(err)
    return new Error(`${text}: ${msg}`, { cause:err })
}

async function readIgnoreFile (file:string):Promise<Buffer> {
    const handle = await fs.open(file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
        if (!(await handle.stat()).isFile()) {
            throw new Error('not a regular file')
        }
        return await handle.readFile()
    } finally {
        await handle.close()
    }
}

export async function appendIgnoreEntries (
    repo:string,
    entries:ReadonlyMap<string, ReadonlySet<string>>
):Promise<{ path:string, added:boolean }> {
    const file = path.join(repo, '.gitignore')
    let data:Buffer = Buffer.alloc(0)
    try {
        data = await readIgnoreFile(file)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw fail(`read ${file}`, err)
        }
    }
    const lines = new Set(data.toString('utf8').split('\n')
        .map(goTrimSpace))
    const missing = [...entries].filter(([, equivalent]) =>
        ![...equivalent].some(line => lines.has(line)))
    if (missing.length === 0) {
        return { path:file, added:false }
    }
    let addition = missing.map(([entry]) => entry + '\n').join('')
    if (data.length > 0 && data[data.length - 1] !== 0x0a) {
        addition = '\n' + addition
    }
    let handle:FileHandle
    try {
        handle = await fs.open(file,
            constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
                constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644)
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

