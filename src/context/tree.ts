// The reviewed tree (spec 05, 2.2): live working tree, pinned index tree,
// or captured worktree tree. Every reader in this area takes one Tree.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../git/git.js'
import { copyIndex, liveIndexPath } from '../snapshot/snapshot.js'
import type { ContextOpts } from './git.js'

export type Tree = {
    // '' means the live working tree.
    readonly oid:string;
    // true: captured worktree; false with an oid: index tree.
    readonly worktree:boolean;
}

export const LIVE_TREE:Tree = Object.freeze({ oid:'', worktree:false })

export function pinned (t:Tree):boolean {
    return t.oid !== ''
}

export function staged (t:Tree):boolean {
    return pinned(t) && !t.worktree
}

export function pinnedWorktree (oid:string):Tree {
    return { oid, worktree:oid !== '' }
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// Writes the current index (honoring GIT_INDEX_FILE) into a tree object
// through a temporary copy, without touching the live index, any ref, or
// any commit. `opts.env` is the environment git runs with (and the one
// GIT_INDEX_FILE is read from); process.env when absent.
export async function pinIndexTree (
    repo:string,
    signal:AbortSignal,
    opts:Omit<ContextOpts, 'signal'> = {}
):Promise<Tree> {
    const runOpts = { signal, env:opts.env }
    let gitDir:string
    try {
        gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'],
            runOpts)).toString().trim()
    } catch (err) {
        signal.throwIfAborted()
        throw new Error(`resolve git dir: ${message(err)}`, { cause:err })
    }
    const live = liveIndexPath(repo, gitDir, opts.env ?? process.env)

    let tmp:string
    try {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roast-pin-'))
    } catch (err) {
        throw new Error(`temp dir: ${message(err)}`, { cause:err })
    }
    try {
        const idx = path.join(tmp, 'index')
        await copyIndex(live, idx)
        let oid:string
        try {
            oid = (await git(repo, ['write-tree'], {
                ...runOpts,
                extraEnv:{ GIT_INDEX_FILE:idx },
            })).toString().trim()
        } catch (err) {
            signal.throwIfAborted()
            throw new Error(`write-tree: ${message(err)}`, { cause:err })
        }
        return { oid, worktree:false }
    } finally {
        await fs.rm(tmp, { recursive:true, force:true })
    }
}
