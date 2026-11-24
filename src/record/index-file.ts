// pattern: Imperative Shell
import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { ensureDir, openPrivate } from './dir.js'
import type { Report } from '../render/render.js'
import { runLine, priorLine, type PriorSighting } from './index-line.js'
import { rfc3339Local, compareBytes } from './json.js'
import type { Finding } from '../review/types.js'
import { fingerprint } from '../review/fingerprint.js'

export type { PriorSighting } from './index-line.js'

export async function appendRunLine (
    dir:string,
    report:Report,
    repo:string,
    argv:readonly string[]|null,
    now:Date = new Date()
):Promise<void> {
    if (!dir) return
    try {
        await ensureDir(dir)
        const line = runLine(report, path.resolve(repo), argv, now)
        const file = path.join(dir,
            `runs-${rfc3339Local(now).slice(0, 7)}.jsonl`)
        const handle = await openPrivate(file, 'a')
        try {
            await handle.writeFile(line)
        } finally {
            await handle.close()
        }
    } catch { /* The monthly index is strictly best effort. */ }
}

async function scanFile (
    file:string,
    repo:string,
    targets:ReadonlySet<string>,
    out:Map<string, PriorSighting>
):Promise<void> {
    const stream = createReadStream(file)
    let pending = Buffer.alloc(0)
    const max = 4 * 1024 * 1024
    try {
        for await (const chunk of stream) {
            pending = Buffer.concat([pending, chunk])
            let end:number
            while ((end = pending.indexOf(10)) !== -1) {
                if (end >= max) return
                priorLine(pending.subarray(0, end).toString(),
                    repo, targets, out)
                pending = pending.subarray(end + 1)
            }
            if (pending.length >= max) return
        }
        if (pending.length) priorLine(pending.toString(), repo, targets, out)
    } catch {
        // Unreadable monthly files do not block older files.
    } finally {
        stream.destroy()
    }
}

export async function seenBefore (
    dir:string,
    repoDir:string,
    findings:readonly Finding[],
    lookbackFiles:number = 3
):Promise<Map<string, PriorSighting>> {
    const out = new Map<string, PriorSighting>()
    if (!dir || !findings.length) return out
    const targets = new Set(findings.map(fingerprint))
    let entries
    try {
        entries = await fs.readdir(dir, { withFileTypes:true })
    } catch { return out }
    const files = entries.filter(e => !e.isDirectory() &&
        e.name.startsWith('runs-') && e.name.endsWith('.jsonl'))
        .map(e => e.name).sort((a, b) => compareBytes(b, a))
        .slice(0, lookbackFiles <= 0 ? 3 : lookbackFiles)
    for (const file of files) {
        await scanFile(path.join(dir, file), path.resolve(repoDir),
            targets, out)
        if (out.size === targets.size) break
    }
    return out
}
