// Rename compaction (spec 04, 2.8). Diffs run with --no-renames so
// excludes apply to both sides of a move; this collapses delete+add pairs
// whose two paths both survived the excludes into git's rename form.
import { PATCH_FLAGS } from './constants.js'
import { diffArgs, git, gitPatch, type GitRunOpts } from './git.js'
import { pairPath } from './patch.js'
import { decodeName, splitNul } from './text.js'

export type SectionKind = 'other'|'deleted'|'added'

export interface DiffSection {
    bytes:Buffer;
    path:string;
    kind:SectionKind;
}

const SECTION_START = Buffer.from('\ndiff --git ')
const NL = 0x0a

// Each section runs up to and including the newline before the next
// `diff --git ` line; leading text is its own section.
export function splitSections (diff:Buffer):DiffSection[] {
    const out:DiffSection[] = []
    let start = 0
    while (start < diff.length) {
        const next = diff.indexOf(SECTION_START, start + 1)
        const end = next === -1 ? diff.length : next + 1
        out.push(classify(diff.subarray(start, end)))
        start = end
    }
    return out
}

// Calls `fn` with each line (decoded, without newline) until it returns
// true.
function eachLine (
    buf:Buffer,
    from:number,
    fn:(line:string) => boolean
):void {
    let pos = from
    while (pos < buf.length) {
        const nl = buf.indexOf(NL, pos)
        const end = nl === -1 ? buf.length : nl
        if (fn(buf.subarray(pos, end).toString('utf8'))) return
        pos = end + 1
    }
}

export function classify (bytes:Buffer):DiffSection {
    const other:DiffSection = { bytes, path:'', kind:'other' }
    const nl = bytes.indexOf(NL)
    const header = bytes.subarray(0, nl === -1 ? bytes.length : nl)
        .toString('utf8')
    if (!header.startsWith('diff --git ')) return other
    const pair = header.slice('diff --git '.length)
    if (pair.startsWith('"')) return other
    const path = pairPath(pair)
    if (path === null) return other
    let result = other
    if (nl === -1) return other
    eachLine(bytes, nl + 1, line => {
        if (line.startsWith('@@') || line.startsWith('--- ')) return true
        if (line.startsWith('deleted file mode ')) {
            result = { bytes, path, kind:'deleted' }
            return true
        }
        if (line.startsWith('new file mode ')) {
            result = { bytes, path, kind:'added' }
            return true
        }
        return false
    })
    return result
}

// The `rename from` / `rename to` paths of a section, read before its
// first hunk. Quoted paths are left uncollapsed.
export function renameOf (bytes:Buffer):{ from:string, to:string }|null {
    let from = ''
    let to = ''
    eachLine(bytes, 0, line => {
        if (line.startsWith('@@')) return true
        if (line.startsWith('rename from ')) {
            from = line.slice('rename from '.length)
        } else if (line.startsWith('rename to ')) {
            to = line.slice('rename to '.length)
        }
        return false
    })
    if (from === '' || to === '' || from.startsWith('"') ||
        to.startsWith('"')) {
        return null
    }
    return { from, to }
}

export function renameNote (notes:string[], n:number):string[] {
    if (n === 0) return notes
    return [...notes, `collapsed ${n} moved file(s) to git's rename form ` +
        '(both paths in scope)']
}

// Collapses accepted moves. Any git failure leaves the diff unchanged,
// except an abort, which rejects.
export async function compactRenames (
    repo:string,
    ref:readonly string[],
    spec:readonly string[],
    diff:Buffer,
    maxSection:number,
    opts:GitRunOpts = {}
):Promise<{ diff:Buffer, renamed:number }> {
    const unchanged = { diff, renamed:0 }
    const sections = splitSections(diff)
    const deleted = new Set<string>()
    const added = new Set<string>()
    for (const s of sections) {
        if (s.kind === 'deleted') deleted.add(s.path)
        if (s.kind === 'added') added.add(s.path)
    }
    if (deleted.size === 0 || added.size === 0) return unchanged

    const args = (...extra:string[]) => diffArgs('-M', ...PATCH_FLAGS,
        ...extra, ...ref, ...spec)
    const accepted = new Set<string>()
    const key = (from:string, to:string) => `${from}\0${to}`
    try {
        const status = await git(repo, args('--name-status', '-z'), opts)
        acceptRenames(status, deleted, added, (from, to) => {
            accepted.add(key(from, to))
        })
    } catch (err) {
        if (opts.signal?.aborted) throw err
        return unchanged
    }
    if (accepted.size === 0) return unchanged

    let full:Buffer
    try {
        full = (await gitPatch(repo, args(), maxSection, opts)).out
    } catch (err) {
        if (opts.signal?.aborted) throw err
        return unchanged
    }
    const paired = new Set<string>()
    const renamed:Buffer[] = []
    for (const sec of splitSections(full)) {
        const r = renameOf(sec.bytes)
        if (r === null || !accepted.has(key(r.from, r.to))) continue
        paired.add(r.from)
        paired.add(r.to)
        renamed.push(sec.bytes)
        if (sec.bytes[sec.bytes.length - 1] !== NL) {
            renamed.push(Buffer.from('\n'))
        }
    }
    if (paired.size === 0) return unchanged

    const out:Buffer[] = []
    let outLen = 0
    let last = -1
    for (const s of sections) {
        if (s.kind !== 'other' && paired.has(s.path)) continue
        out.push(s.bytes)
        outLen += s.bytes.length
        if (s.bytes.length > 0) last = s.bytes[s.bytes.length - 1]
    }
    if (outLen > 0 && last !== NL) out.push(Buffer.from('\n'))
    return {
        diff:Buffer.concat([...out, ...renamed]),
        renamed:paired.size / 2,
    }
}

// Walks `--name-status -z` output as whole records, so a path such as
// `README.md` is never read as a status. Names that are not valid UTF-8
// are skipped silently.
function acceptRenames (
    status:Buffer,
    deleted:ReadonlySet<string>,
    added:ReadonlySet<string>,
    accept:(from:string, to:string) => void
):void {
    // An invalid name decodes to null rather than shifting the walk.
    const fields = splitNul(status).map(decodeName)
    let i = 0
    while (i < fields.length) {
        const code = fields[i] ?? ''
        if (!code.startsWith('R') && !code.startsWith('C')) {
            i += 2
            continue
        }
        if (i + 2 >= fields.length) break
        const from = fields[i + 1]
        const to = fields[i + 2]
        i += 3
        if (!code.startsWith('R') || from === null || to === null) continue
        if (deleted.has(from) && added.has(to)) accept(from, to)
    }
}
