// The list_files tool body (spec 05, 2.9). The live tree asks Git for its
// file list instead of walking the disk, so ignored files never surface.
import fs from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import path from 'node:path'
import { git, GitError } from '../git/git.js'
import { compareBytes, decodePaths } from '../scope/text.js'
import { denylistedUntracked } from '../snapshot/denylist.js'
import type { ContextOpts } from './git.js'
import { globstarMatch } from './glob.js'
import { resolveLive, stagedPathCanonical } from './paths.js'
import { TOOL_OUTPUT_CAP } from './read-file.js'
import { pinned, type Tree } from './tree.js'

// Max entries in one result.
export const LIST_FILES_CAP = 500
// Max pattern length in bytes.
export const LIST_PATTERN_MAX = 256

// Go's exec error text: `exit status N`, without stderr.
function execError (err:unknown):string {
    if (err instanceof GitError) {
        return err.exitCode === null ?
            'signal: killed' :
            `exit status ${err.exitCode}`
    }
    return err instanceof Error ? err.message : String(err)
}

function basename (p:string):string {
    const i = p.lastIndexOf('/')
    return i === -1 ? p : p.slice(i + 1)
}

function hidden (rel:string):boolean {
    return rel.split('/').some(seg => seg.startsWith('.'))
}

function matches (pattern:string, rel:string):boolean {
    return globstarMatch(pattern, rel) ||
        (!pattern.includes('/') && globstarMatch(pattern, basename(rel)))
}

// Bounded accumulation: `add` returns false once the result is full.
class ListMatches {
    readonly list:string[] = []
    private bytes = 0
    private count = 0

    add (rel:string):boolean {
        if (this.count >= LIST_FILES_CAP) {
            this.list.push(`... (truncated at ${LIST_FILES_CAP} matches)`)
            return false
        }
        const n = Buffer.byteLength(rel) + 1
        if (this.bytes + n > TOOL_OUTPUT_CAP) {
            this.list.push(`... (truncated at ${TOOL_OUTPUT_CAP} bytes ` +
                `after ${this.count} matches)`)
            return false
        }
        this.list.push(rel)
        this.bytes += n
        this.count++
        return true
    }
}

function realRoot (repo:string):string {
    try {
        return fs.realpathSync(repo)
    } catch {
        return repo
    }
}

async function listLive (
    repo:string,
    dir:string,
    pattern:string,
    opts:ContextOpts
):Promise<ListMatches|{ error:string }> {
    const outside = {
        error:`directory '${dir}' is outside the ` +
        'repository or invalid'
    }
    const abs = await resolveLive(repo, dir, opts)
    if (abs === null) return outside
    const st = await stat(abs).catch(() => null)
    if (!st?.isDirectory()) {
        return { error:`${dir} does not exist or is not a directory` }
    }
    const root = realRoot(repo)
    const relDir = path.relative(root, abs) || '.'
    if (relDir.startsWith('..') || path.isAbsolute(relDir)) return outside
    const args = ['ls-files', '-z', '--cached', '--others',
        '--exclude-standard']
    if (relDir !== '.') args.push('--', relDir)
    let out:Buffer
    let denied:Set<string>
    try {
        out = await git(repo, args,
            { ...opts, extraEnv:{ GIT_LITERAL_PATHSPECS:'1' } })
        denied = new Set(await denylistedUntracked(repo, opts))
    } catch (err) {
        opts.signal?.throwIfAborted()
        return { error:`list working tree failed: ${execError(err)}` }
    }
    const seen = new Set<string>()
    const keep:string[] = []
    for (const rel of decodePaths(out).paths) {
        if (rel === '' || hidden(rel) || seen.has(rel)) continue
        seen.add(rel)
        if (denied.has(rel) || !matches(pattern, rel)) continue
        const lst = await lstat(path.join(root, rel)).catch(() => null)
        if (!lst?.isFile()) continue
        keep.push(rel)
    }
    keep.sort(compareBytes)
    const acc = new ListMatches()
    for (const rel of keep) {
        if (!acc.add(rel)) break
    }
    return acc
}

async function listPinned (
    repo:string,
    tree:Tree,
    dir:string,
    pattern:string,
    opts:ContextOpts
):Promise<ListMatches|{ error:string }> {
    if (dir !== '.' && (!stagedPathCanonical(dir) || dir.endsWith('/'))) {
        return {
            error:`directory '${dir}' is outside the repository or ` +
            'invalid'
        }
    }
    let out:Buffer
    try {
        out = await git(repo, ['ls-tree', '-r', '-z', '--full-tree',
            tree.oid], opts)
    } catch (err) {
        opts.signal?.throwIfAborted()
        return { error:`list captured tree failed: ${execError(err)}` }
    }
    const prefix = dir === '.' ? '' : dir + '/'
    const acc = new ListMatches()
    for (const record of decodePaths(out).paths) {
        const tab = record.indexOf('\t')
        if (tab === -1) continue
        const [mode, type] = record.slice(0, tab).split(' ')
        const rel = record.slice(tab + 1)
        if ((mode !== '100644' && mode !== '100755') || type !== 'blob') {
            continue
        }
        if (!rel.startsWith(prefix) || hidden(rel)) continue
        if (!matches(pattern, rel)) continue
        if (!acc.add(rel)) break
    }
    return acc
}

export async function listFiles (
    repo:string,
    tree:Tree,
    args:Record<string, unknown>,
    signal:AbortSignal,
    opts:ContextOpts = {}
):Promise<Record<string, unknown>> {
    const runOpts:ContextOpts = { ...opts, signal }
    const dir = typeof args.directory === 'string' && args.directory !== '' ?
        args.directory :
        '.'
    const pattern = typeof args.pattern === 'string' && args.pattern !== '' ?
        args.pattern :
        '*'
    if (Buffer.byteLength(pattern) > LIST_PATTERN_MAX) {
        return { error:`pattern exceeds ${LIST_PATTERN_MAX} bytes` }
    }
    const res = pinned(tree) ?
        await listPinned(repo, tree, dir, pattern, runOpts) :
        await listLive(repo, dir, pattern, runOpts)
    if ('error' in res) return res
    return {
        directory:dir,
        // Go encodes an empty match list as null.
        matches:res.list.length === 0 ? null : res.list,
        pattern,
    }
}
