// File context for the prompts (spec 05, 2.5 and 2.6): numbered,
// middle-truncated snippets of reviewed files. Content is decoded with
// U+FFFD replacement only here, where it becomes model-facing text.
import fs from 'node:fs/promises'
import path from 'node:path'
import { stagedContentCeiling } from './blob.js'
import type { ContextOpts } from './git.js'
import { resolveLive, stagedPathCanonical } from './paths.js'
import { pinned, staged, type Tree } from './tree.js'

const EM = '\u2014'

// The snippet size each file gets in buildFileContext.
export const FILE_SNIPPET_BYTES = 120000

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// Splits on `\n`, dropping one trailing empty element.
function splitLines (b:Buffer):Buffer[] {
    if (b.length === 0) return []
    const lines:Buffer[] = []
    let start = 0
    for (;;) {
        const end = b.indexOf(0x0a, start)
        if (end === -1) {
            if (start < b.length) lines.push(b.subarray(start))
            return lines
        }
        lines.push(b.subarray(start, end))
        start = end + 1
    }
}

function numbered (n:number, line:Buffer):string {
    return `${String(n).padStart(5)}  ${line.toString('utf8')}`
}

interface Read {
    content:Buffer;
    header:string;
}

// The pinned blob, or a notice string.
async function readPinned (
    repo:string,
    relpath:string,
    ceiling:number,
    tree:Tree,
    opts:ContextOpts
):Promise<Read|string> {
    const res = await stagedContentCeiling(repo, tree, relpath, ceiling, opts)
    if (res === null) {
        return staged(tree) ?
            `### ${relpath}\n(not in the index ${EM} staged deletion?)\n` :
            `### ${relpath}\n(not in the captured worktree)\n`
    }
    let header = ''
    if (res.truncated) {
        const corpus = staged(tree) ? 'staged blob' : 'captured worktree blob'
        header = `### ${relpath} (${corpus} exceeds ${ceiling} bytes; ` +
            `only the first ${ceiling} were read ${EM} true tail NOT ` +
            'shown below)'
    }
    return { content:res.content, header }
}

// The live file, or a notice string.
async function readLive (
    repo:string,
    relpath:string,
    ceiling:number
):Promise<Read|string> {
    const p = path.join(repo, relpath)
    let size:number
    try {
        const st = await fs.stat(p)
        if (!st.isFile()) throw new Error('not a regular file')
        size = st.size
    } catch {
        return `### ${relpath}\n(deleted or not a regular file)\n`
    }
    try {
        if (size <= ceiling) return { content:await fs.readFile(p), header:'' }
        const fh = await fs.open(p, 'r')
        try {
            const buf = Buffer.alloc(ceiling)
            let n = 0
            while (n < ceiling) {
                const { bytesRead } = await fh.read(buf, n, ceiling - n, n)
                if (bytesRead === 0) break
                n += bytesRead
            }
            return {
                content:buf.subarray(0, n),
                header:`### ${relpath} (file is ${size} bytes; only the ` +
                    `first ${ceiling} were read ${EM} true tail NOT shown ` +
                    'below)',
            }
        } finally {
            await fh.close()
        }
    } catch (err) {
        return `### ${relpath}\n(read error: ${message(err)})\n`
    }
}

// One file with real 1-indexed line numbers, middle-truncated to about
// maxBytes so both ends stay visible. Problems render as a notice; only
// an abort rejects.
export async function numberedSnippet (
    repo:string,
    relpath:string,
    maxBytes:number,
    tree:Tree,
    opts:ContextOpts = {}
):Promise<string> {
    const invalid =
        `### ${relpath}\n(path is outside the repository or invalid)\n`
    if (pinned(tree)) {
        if (!stagedPathCanonical(relpath)) return invalid
    } else if ((await resolveLive(repo, relpath, opts)) === null) {
        return invalid
    }
    const ceiling = 8 * maxBytes
    const read = pinned(tree) ?
        await readPinned(repo, relpath, ceiling, tree, opts) :
        await readLive(repo, relpath, ceiling)
    opts.signal?.throwIfAborted()
    if (typeof read === 'string') return read
    const { content } = read
    const lines = splitLines(content)

    if (content.length <= maxBytes) {
        let out = `### ${relpath}\n\`\`\`\n`
        lines.forEach((l, i) => { out += numbered(i + 1, l) + '\n' })
        return out + '```\n'
    }

    const headBudget = Math.trunc(maxBytes * 0.66)
    let used = 0
    let headLast = 0
    for (let i = 0; i < lines.length; i++) {
        const cost = lines[i].length + 1
        if (used + cost > headBudget) break
        used += cost
        headLast = i + 1
    }
    const tailBudget = maxBytes - headBudget
    used = 0
    let tailStart = lines.length
    // Compares a 0-based index with a 1-based line number, as Go does: the
    // line right after the head is never in the tail.
    for (let i = lines.length - 1; i > headLast; i--) {
        const cost = lines[i].length + 1
        if (used + cost > tailBudget) break
        used += cost
        tailStart = i
    }
    const tailFirst = tailStart + 1

    const header = read.header || `### ${relpath} (${lines.length} lines, ` +
        `${content.length} bytes ${EM} middle truncated)`
    const out = [header, '```']
    for (let i = 0; i < headLast; i++) out.push(numbered(i + 1, lines[i]))
    if (tailFirst > headLast + 1) {
        out.push(`       ... (${tailFirst - headLast - 1} lines omitted; ` +
            'real line numbers continue below)')
    }
    for (let i = tailStart; i < lines.length; i++) {
        out.push(numbered(i + 1, lines[i]))
    }
    out.push('```', '')
    return out.join('\n')
}

// Numbered snippets for `files` within `budget` bytes. A file that does
// not fit renders as an omission notice and the next file is tried.
export async function buildFileContext (
    repo:string,
    files:readonly string[],
    budget:number,
    tree:Tree,
    opts:ContextOpts = {}
):Promise<string> {
    if (files.length === 0) return '(no files)'
    const chunks:string[] = []
    let used = 0
    for (const f of files) {
        const snippet = await numberedSnippet(repo, f, FILE_SNIPPET_BYTES,
            tree, opts)
        const size = Buffer.byteLength(snippet)
        if (used + size > budget) {
            chunks.push(`### ${f}\n(omitted ${EM} context budget exceeded)\n`)
            continue
        }
        chunks.push(snippet)
        used += size
    }
    return chunks.join('\n')
}
