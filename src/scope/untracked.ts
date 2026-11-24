// Untracked files as new-file diff sections (spec 04, 2.10).
import fs from 'node:fs/promises'
import path from 'node:path'
import { SECTION_OMITTED_MARKER } from './constants.js'

const NL = 0x0a

export interface Synthesized {
    // Empty when the file is not synthesized (not a regular file, or
    // unreadable).
    block:Buffer;
    cut:boolean;
}

const NONE:Synthesized = { block:Buffer.alloc(0), cut:false }

// Renders an untracked file as a new-file section of about maxSection
// bytes at most. Content past maxSection + 1 bytes is never read, and
// symlinks are never followed.
export async function synthesizeNewFileDiff (
    repo:string,
    relpath:string,
    maxSection:number,
    signal?:AbortSignal
):Promise<Synthesized> {
    const full = path.join(repo, relpath)
    let data:Buffer
    try {
        const info = await fs.lstat(full)
        if (!info.isFile()) return NONE
        data = await readAtMost(full, maxSection + 1)
    } catch (err) {
        if (signal?.aborted) throw err
        return NONE
    }
    signal?.throwIfAborted()
    let cut = data.length > maxSection
    const lines:Buffer[] = []
    let pos = 0
    while (pos <= data.length) {
        const nl = data.indexOf(NL, pos)
        const end = nl === -1 ? data.length : nl
        lines.push(data.subarray(pos, end))
        if (nl === -1) break
        pos = nl + 1
    }
    if (lines.length > 0 && lines[lines.length - 1].length === 0) {
        lines.pop()
    }
    const header = Buffer.from(`diff --git a/${relpath} b/${relpath}\n` +
        `new file mode 100644\n--- /dev/null\n+++ b/${relpath}\n`)
    const body:Buffer[] = []
    let bodyLen = 0
    for (const line of lines) {
        if (header.length + bodyLen + line.length + 2 > maxSection) {
            cut = true
            break
        }
        body.push(Buffer.from('+'), line, Buffer.from('\n'))
        bodyLen += line.length + 2
    }
    const parts = [
        header,
        Buffer.from(`@@ -0,0 +1,${body.length / 3} @@\n`),
        ...body,
    ]
    if (cut) parts.push(Buffer.from(SECTION_OMITTED_MARKER(maxSection)))
    return { block:Buffer.concat(parts), cut }
}

const READ_CHUNK = 64 * 1024

// Reads up to `max` bytes, in chunks, so a small file costs a small
// buffer.
async function readAtMost (file:string, max:number):Promise<Buffer> {
    const fh = await fs.open(file, 'r')
    try {
        const parts:Buffer[] = []
        let total = 0
        while (total < max) {
            const buf = Buffer.alloc(Math.min(READ_CHUNK, max - total))
            const { bytesRead } = await fh.read(buf, 0, buf.length, null)
            if (bytesRead === 0) break
            parts.push(buf.subarray(0, bytesRead))
            total += bytesRead
        }
        return Buffer.concat(parts)
    } finally {
        await fh.close()
    }
}
