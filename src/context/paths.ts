// Path confinement (spec 05, 2.3). Every model-supplied path is untrusted:
// live reads go through resolveUnderRepo / resolveLive, pinned-tree reads
// through stagedPathCanonical.
import fs from 'node:fs'
import path from 'node:path'
import { git, GitError } from '../git/git.js'
import { denylisted } from '../snapshot/denylist.js'
import type { ContextOpts } from './git.js'

// realpath of `p`, or null when it does not resolve.
function realpath (p:string):string|null {
    try {
        return fs.realpathSync(p)
    } catch {
        return null
    }
}

function repoRoot (repo:string):string {
    return realpath(repo) ?? repo
}

// Resolves symlinks on the deepest existing ancestor of `p`; the missing
// tail is dropped.
export function resolveDeepest (p:string):string {
    for (;;) {
        const resolved = realpath(p)
        if (resolved !== null) return resolved
        const parent = path.dirname(p)
        if (parent === p) return p
        p = parent
    }
}

// `abs` relative to `root`, '.' when they are equal.
function relTo (root:string, abs:string):string {
    return path.relative(root, abs) || '.'
}

// Whether `abs`, taken relative to `root`, has a `.git` segment in any
// case: case-insensitive file systems open `.GIT/config` too.
function inGitDir (root:string, abs:string):boolean {
    return relTo(root, abs).split('/')
        .some(seg => seg.toLowerCase() === '.git')
}

// The single chokepoint for model-supplied live paths: the absolute path
// under the repository, or null for an empty, absolute, escaping, or
// `.git` path (before or after symlink resolution).
export function resolveUnderRepo (repo:string, userPath:string):string|null {
    if (userPath === '' || path.isAbsolute(userPath)) return null
    const root = repoRoot(repo)
    // path.join cleans lexically, like Go filepath.Join; drop the trailing
    // slash Go Clean drops too.
    let candidate = path.join(root, userPath)
    if (candidate.length > 1 && candidate.endsWith('/')) {
        candidate = candidate.slice(0, -1)
    }
    const resolved = resolveDeepest(candidate)
    if (resolved !== root && !resolved.startsWith(root + '/')) return null
    if (inGitDir(root, candidate) || inGitDir(root, resolved)) return null
    return candidate
}

async function tracked (
    repo:string,
    rel:string,
    opts:ContextOpts
):Promise<boolean> {
    try {
        const out = await git(repo, ['ls-files', '-z', '--cached', '--', rel],
            { ...opts, extraEnv:{ GIT_LITERAL_PATHSPECS:'1' } })
        return out.length > 0
    } catch {
        opts.signal?.throwIfAborted()
        return false
    }
}

// Whether `rel` belongs to the corpus a review serves: not ignored, and
// not an untracked file matching the secret denylist. Fails closed.
async function liveCorpusAllows (
    repo:string,
    rel:string,
    opts:ContextOpts
):Promise<boolean> {
    if (rel === '.') return true
    if (denylisted(rel) && !(await tracked(repo, rel, opts))) return false
    // check-ignore refuses literal pathspecs, so the `./` prefix is what
    // keeps a leading `:` from being read as pathspec magic. Exit 1 is
    // "not ignored"; 0 is ignored, anything else an error.
    try {
        await git(repo, ['check-ignore', '-q', '--', './' + rel],
            { ...opts, extraEnv:{ GIT_LITERAL_PATHSPECS:'0' } })
        return false
    } catch (err) {
        opts.signal?.throwIfAborted()
        return err instanceof GitError && err.exitCode === 1
    }
}

// resolveUnderRepo plus the corpus rules a pinned tree enforces by
// construction, applied to the path as given and to its symlink target.
export async function resolveLive (
    repo:string,
    userPath:string,
    opts:ContextOpts = {}
):Promise<string|null> {
    const p = resolveUnderRepo(repo, userPath)
    if (p === null) return null
    const root = repoRoot(repo)
    const targets = [p]
    const target = resolveDeepest(p)
    if (target !== p) targets.push(target)
    for (const abs of targets) {
        if (!(await liveCorpusAllows(repo, relTo(root, abs), opts))) {
            return null
        }
    }
    return p
}

// Whether `p` would land in Git's revision grammar instead of naming the
// pinned-tree entry `p` (stage selectors, `:/` search, `./` aliases).
// Only the canonical index spelling is accepted.
function stagedPathIsMagic (p:string):boolean {
    if (p === '' || p.startsWith(':')) return true
    if (p.length > 1 && p[1] === ':' && p[0] >= '0' && p[0] <= '3') {
        return true
    }
    return p.split('/').some(seg => seg === '' || seg === '.' || seg === '..')
}

export function stagedPathCanonical (p:string):boolean {
    return !stagedPathIsMagic(p)
}
