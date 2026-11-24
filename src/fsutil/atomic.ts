// Atomic file replacement: write a fresh temp file beside the target, then
// rename it over the target. Used for the trust record, stored
// credentials, hook scripts, and run records.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export interface AtomicWriteOpts {
    // Final file mode, applied with fchmod before the rename. Default 0o600.
    mode?:number;
    // Temp name is `<tempPrefix><random><tempSuffix>` in the target's
    // directory. Default prefix `.<basename>.roast-`, suffix empty.
    tempPrefix?:string;
    tempSuffix?:string;
    // When set, the parent is created with `mkdir -p` and this mode.
    dirMode?:number;
    // Also chmod an existing parent to `dirMode` (credentials tighten a
    // shared state directory to 0o700).
    chmodDir?:boolean;
    // When set, every failure is `<errorPrefix>: <cause>`. Otherwise each
    // step names itself: `create temp file for <path>: ...`, `write <tmp>:
    // ...`, `chmod <tmp>: ...`, `close <tmp>: ...`, `replace <path>: ...`.
    errorPrefix?:string;
}

const MAX_TRIES = 100

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function isCode (err:unknown, code:string):boolean {
    return (err as NodeJS.ErrnoException)?.code === code
}

export async function writeFileAtomic (
    target:string,
    body:string|Uint8Array,
    opts:AtomicWriteOpts = {}
):Promise<void> {
    const dir = path.dirname(target)
    const prefix = opts.tempPrefix ?? `.${path.basename(target)}.roast-`
    const suffix = opts.tempSuffix ?? ''
    const mode = opts.mode ?? 0o600

    // Runs one step, mapping its failure to the configured message.
    async function step<T> (label:string, fn:() => Promise<T>):Promise<T> {
        try {
            return await fn()
        } catch (err) {
            const text = opts.errorPrefix ?
                `${opts.errorPrefix}: ${message(err)}` :
                `${label}: ${message(err)}`
            throw new Error(text, { cause:err })
        }
    }

    if (opts.dirMode !== undefined) {
        const dirMode = opts.dirMode
        await step(`mkdir ${dir}`, async () => {
            await fs.mkdir(dir, { recursive:true, mode:dirMode })
            if (opts.chmodDir) await fs.chmod(dir, dirMode)
        })
    }

    const [handle, tmp] = await step(`create temp file for ${target}`,
        async ():Promise<[fs.FileHandle, string]> => {
            for (let i = 0; ; i++) {
                const name = prefix + randomBytes(8).toString('hex') + suffix
                const tmp = path.join(dir, name)
                try {
                    return [await fs.open(tmp, 'wx', 0o600), tmp]
                } catch (err) {
                    if (!isCode(err, 'EEXIST') || i + 1 >= MAX_TRIES) {
                        throw err
                    }
                }
            }
        })

    let closed = false
    try {
        await step(`write ${tmp}`, () => handle.writeFile(body))
        await step(`chmod ${tmp}`, () => handle.chmod(mode))
        closed = true
        await step(`close ${tmp}`, () => handle.close())
        await step(`replace ${target}`, () => fs.rename(tmp, target))
    } catch (err) {
        if (!closed) await handle.close().catch(() => {})
        await fs.rm(tmp, { force:true }).catch(() => {})
        throw err
    }
}
