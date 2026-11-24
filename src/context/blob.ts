// Blob reads from a pinned tree (spec 05, 2.4). The path must already be
// the canonical index spelling; anything else is absent.
import { git, GitError } from '../git/git.js'
import { gitCapped, type ContextOpts } from './git.js'
import { stagedPathCanonical } from './paths.js'
import type { Tree } from './tree.js'

// The tree's blob for `relpath`, or null when the path is not canonical or
// not in the tree.
export async function stagedContent (
    repo:string,
    tree:Tree,
    relpath:string,
    opts:ContextOpts = {}
):Promise<Buffer|null> {
    if (!stagedPathCanonical(relpath)) return null
    try {
        return await git(repo, ['cat-file', 'blob', `${tree.oid}:${relpath}`],
            opts)
    } catch (err) {
        opts.signal?.throwIfAborted()
        if (err instanceof GitError) return null
        throw err
    }
}

export interface CeilingContent {
    content:Buffer;
    // The blob held more than the ceiling; only the first part was read.
    truncated:boolean;
}

// At most `ceiling` bytes of the tree's blob, streamed: the child is
// killed once the ceiling is exceeded. null as for stagedContent.
export async function stagedContentCeiling (
    repo:string,
    tree:Tree,
    relpath:string,
    ceiling:number,
    opts:ContextOpts = {}
):Promise<CeilingContent|null> {
    if (!stagedPathCanonical(relpath)) return null
    const res = await gitCapped(repo,
        ['cat-file', 'blob', `${tree.oid}:${relpath}`], ceiling, opts)
    if (!res.ok) return null
    return { content:res.out, truncated:res.truncated }
}
