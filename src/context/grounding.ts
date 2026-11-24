// Quote grounding (spec 05, 2.11): whether a finding's code_quote appears,
// modulo whitespace, in what the finder could have seen for the cited
// file -- the file's content in the reviewed tree, or the file's own
// section of the reviewed diff. Matching is on bytes.
import fs from 'node:fs'
import { git, GitError } from '../git/git.js'
import { decodeName } from '../scope/text.js'
import { gitStream, STREAM_BUFFER, type ContextOpts } from './git.js'
import { ByteBuilder, normalizeWS, WsNormalizer } from './normalize.js'
import { resolveLive, stagedPathCanonical } from './paths.js'
import { pinned, type Tree } from './tree.js'

// The largest file normalized whole and cached.
export const GROUNDING_CACHE_BYTES = 8 * 1024 * 1024

export type Grounder = (file:string, quote:string) => Promise<boolean>

// A NUL (not whitespace) keeps quotes from matching across sides, hunks,
// and sections.
const SEP = Buffer.from(' \u0000 ')
const SENTINEL = Buffer.from('\n\u0000\n')
const DIFF_GIT = Buffer.from('diff --git ')
const NL_DIFF_GIT = Buffer.from('\ndiff --git ')
const OLD_MARK = Buffer.from('--- ')
const NEW_MARK = Buffer.from('+++ ')
const OLD_PREFIX = Buffer.from('a/')
const NEW_PREFIX = Buffer.from('b/')

function hasPrefix (b:Buffer, prefix:Buffer):boolean {
    if (b.length < prefix.length) return false
    for (let i = 0; i < prefix.length; i++) {
        if (b[i] !== prefix[i]) return false
    }
    return true
}

// Calls `fn` with each `\n`-separated line of `b` (Go strings.Split).
function eachLine (b:Buffer, fn:(line:Buffer) => void):void {
    let start = 0
    for (;;) {
        const end = b.indexOf(0x0a, start)
        if (end === -1) {
            fn(b.subarray(start))
            return
        }
        fn(b.subarray(start, end))
        start = end + 1
    }
}

function hexValue (c:number):number {
    if (c >= 0x30 && c <= 0x39) return c - 0x30
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10
    return -1
}

// `\a \b \f \n \r \t \v \\ \"` by escape letter.
const SIMPLE_ESCAPES = new Map<number, number>([
    [0x61, 0x07], [0x62, 0x08], [0x66, 0x0c], [0x6e, 0x0a], [0x72, 0x0d],
    [0x74, 0x09], [0x76, 0x0b], [0x5c, 0x5c], [0x22, 0x22],
])

// Go strconv.Unquote of a double-quoted string, on bytes; null when `b`
// is not exactly one valid quoted string.
export function goUnquote (b:Buffer):Buffer|null {
    if (b.length < 2 || b[0] !== 0x22 || b[b.length - 1] !== 0x22) {
        return null
    }
    const out = new ByteBuilder(b.length)
    const end = b.length - 1
    let i = 1
    while (i < end) {
        const c = b[i]
        if (c === 0x22 || c === 0x0a) return null
        if (c !== 0x5c) {
            out.pushByte(c)
            i++
            continue
        }
        if (i + 1 >= end) return null
        const e = b[i + 1]
        i += 2
        const simple = SIMPLE_ESCAPES.get(e)
        if (simple !== undefined) {
            out.pushByte(simple)
        } else if (e === 0x78 || e === 0x75 || e === 0x55) {
            const n = e === 0x78 ? 2 : e === 0x75 ? 4 : 8
            if (i + n > end) return null
            let v = 0
            for (let k = 0; k < n; k++) {
                const h = hexValue(b[i + k])
                if (h < 0) return null
                v = v * 16 + h
            }
            i += n
            if (e === 0x78) {
                out.pushByte(v)
            } else {
                if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return null
                const enc = Buffer.from(String.fromCodePoint(v))
                out.pushRange(enc, 0, enc.length)
            }
        } else if (e >= 0x30 && e <= 0x37) {
            if (i + 2 > end) return null
            let v = e - 0x30
            for (let k = 0; k < 2; k++) {
                const d = b[i + k] - 0x30
                if (d < 0 || d > 7) return null
                v = v * 8 + d
            }
            if (v > 255) return null
            i += 2
            out.pushByte(v)
        } else {
            return null
        }
    }
    return out.toBuffer()
}

// The repo-relative path from a `--- a/...` or `+++ b/...` header line,
// or null (`/dev/null`, bad quoting, a name that is not UTF-8).
function cutDiffPath (
    line:Buffer,
    marker:Buffer,
    prefix:Buffer
):string|null {
    if (!hasPrefix(line, marker)) return null
    let rest:Buffer|null = line.subarray(marker.length)
    if (rest[0] === 0x22) rest = goUnquote(rest)
    if (rest === null || !hasPrefix(rest, prefix)) return null
    return decodeName(rest.subarray(prefix.length))
}

// The paths one section's headers name. Lines after the first `@@` are
// hunk content and never parsed as headers.
function sectionPaths (section:Buffer):string[] {
    const paths:string[] = []
    let inHunk = false
    eachLine(section, l => {
        if (l[0] === 0x40 && l[1] === 0x40) inHunk = true
        if (inHunk) return
        const old = cutDiffPath(l, OLD_MARK, OLD_PREFIX)
        if (old !== null) {
            paths.push(old)
            return
        }
        const p = cutDiffPath(l, NEW_MARK, NEW_PREFIX)
        if (p !== null && paths[paths.length - 1] !== p) paths.push(p)
    })
    return paths
}

// One section's hunks as a normalized corpus with the old and new sides
// kept apart: context lines go to both, `-` to old, `+` to new.
export function normalizedDiffSides (section:Buffer):Buffer {
    const old = new ByteBuilder(section.length)
    const nu = new ByteBuilder(section.length)
    const oldN = new WsNormalizer()
    const newN = new WsNormalizer()
    let oldAny = false
    let newAny = false
    let inHunk = false
    eachLine(section, l => {
        if (l[0] === 0x40 && l[1] === 0x40) {
            if (oldAny) oldN.writeInto(old, SENTINEL, false)
            if (newAny) newN.writeInto(nu, SENTINEL, false)
            inHunk = true
            return
        }
        if (hasPrefix(l, DIFF_GIT)) {
            inHunk = false
            return
        }
        if (!inHunk || l.length === 0) return
        const text = l.subarray(1)
        switch (l[0]) {
            case 0x20:
                oldN.writeLine(old, text)
                newN.writeLine(nu, text)
                oldAny = newAny = true
                break
            case 0x2d:
                oldN.writeLine(old, text)
                oldAny = true
                break
            case 0x2b:
                newN.writeLine(nu, text)
                newAny = true
                break
            // Anything else ("\ No newline at end of file") is metadata.
        }
    })
    oldN.finish(old)
    newN.finish(nu)
    if (old.length === 0) return nu.toBuffer()
    if (nu.length === 0) return old.toBuffer()
    return Buffer.concat([old.view(), SEP, nu.view()])
}

// Per-file normalized corpora of a unified diff, keyed by both the old
// and new path of each section. A section naming no path contributes
// nothing.
export function splitDiffByFile (diff:Buffer):Map<string, Buffer> {
    const corpora = new Map<string, Buffer>()
    let rest = diff
    while (rest.length > 0) {
        let section = rest
        const i = rest.indexOf(NL_DIFF_GIT)
        if (i >= 0) {
            section = rest.subarray(0, i + 1)
            rest = rest.subarray(i + 1)
        } else {
            rest = rest.subarray(rest.length)
        }
        const paths = sectionPaths(section)
        if (paths.length === 0) continue
        const norm = normalizedDiffSides(section)
        if (norm.length === 0) continue
        for (const p of paths) {
            const prev = corpora.get(p)
            corpora.set(p, prev ? Buffer.concat([prev, SEP, norm]) : norm)
        }
    }
    return corpora
}

interface Source {
    size:number;
    open ():Opened|null;
}

interface Opened {
    chunks:AsyncIterable<Buffer>;
    close ():Promise<void>;
}

// Locates `file` in the reviewed corpus, or null when it is not in it.
async function fileSource (
    repo:string,
    tree:Tree,
    file:string,
    opts:ContextOpts
):Promise<Source|null> {
    if (pinned(tree)) {
        if (!stagedPathCanonical(file)) return null
        const spec = `${tree.oid}:${file}`
        let out:Buffer
        try {
            out = await git(repo, ['cat-file', '-s', spec], opts)
        } catch (err) {
            opts.signal?.throwIfAborted()
            if (err instanceof GitError) return null
            throw err
        }
        const text = out.toString().trim()
        if (!/^[+-]?\d+$/.test(text)) return null
        return {
            size:Number(text),
            open () {
                const s = gitStream(repo, ['cat-file', 'blob', spec], opts)
                return {
                    chunks:s.stdout,
                    async close () {
                        s.kill()
                        await s.done
                    },
                }
            },
        }
    }
    const p = await resolveLive(repo, file, opts)
    if (p === null) return null
    let st:fs.Stats
    try {
        st = await fs.promises.stat(p)
    } catch {
        return null
    }
    if (!st.isFile()) return null
    return {
        size:st.size,
        open () {
            const stream = fs.createReadStream(p, {
                highWaterMark:STREAM_BUFFER,
                signal:opts.signal,
            })
            return {
                chunks:stream,
                async close () { stream.destroy() },
            }
        },
    }
}

// Whether the normalized content of `chunks` contains `nq`, holding one
// read plus a tail of nq's length.
async function streamContains (
    chunks:AsyncIterable<Buffer>,
    nq:Buffer
):Promise<boolean> {
    const n = new WsNormalizer()
    const window = new ByteBuilder(STREAM_BUFFER + nq.length + 1)
    for await (const chunk of chunks) {
        n.writeInto(window, chunk, false)
        if (window.view().includes(nq)) return true
        window.keepTail(nq.length)
    }
    n.finish(window)
    return window.view().includes(nq)
}

// At most `limit` bytes of `chunks`.
async function readCapped (
    chunks:AsyncIterable<Buffer>,
    limit:number
):Promise<Buffer> {
    const parts:Buffer[] = []
    let total = 0
    for await (const chunk of chunks) {
        const room = limit - total
        if (chunk.length >= room) {
            parts.push(chunk.subarray(0, room))
            total = limit
            break
        }
        parts.push(chunk)
        total += chunk.length
    }
    return Buffer.concat(parts, total)
}

// Builds the grounding check for one review. `diff` is the scope's diff
// before fitting, exactly the bytes git printed.
export function newQuoteGrounder (
    repo:string,
    tree:Tree,
    diff:Buffer,
    opts:ContextOpts = {}
):Grounder {
    const diffCorpora = splitDiffByFile(diff)
    const cache = new Map<string, Buffer>()
    const EMPTY = Buffer.alloc(0)

    async function fileMatch (file:string, nq:Buffer):Promise<boolean> {
        const cached = cache.get(file)
        if (cached !== undefined) return cached.includes(nq)
        const src = await fileSource(repo, tree, file, opts)
        const opened = src?.open() ?? null
        if (src === null || opened === null) {
            cache.set(file, EMPTY)
            return false
        }
        try {
            if (src.size > GROUNDING_CACHE_BYTES) {
                return await streamContains(opened.chunks, nq)
            }
            const raw = await readCapped(opened.chunks, GROUNDING_CACHE_BYTES)
            const norm = normalizeWS(raw)
            cache.set(file, norm)
            return norm.includes(nq)
        } catch {
            opts.signal?.throwIfAborted()
            return false
        } finally {
            await opened.close()
            opts.signal?.throwIfAborted()
        }
    }

    return async (file, quote) => {
        opts.signal?.throwIfAborted()
        const nq = normalizeWS(Buffer.from(quote))
        if (nq.length === 0 || nq.includes(0)) return false
        if (await fileMatch(file, nq)) return true
        return diffCorpora.get(file)?.includes(nq) ?? false
    }
}
