// Review snapshots (spec 11): the worktree pin, the replayable capture
// under refs/roast/snapshots/, its deletion, and revision lookups. The
// live index and the working tree are never written.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { git } from '../git/git.js'
import { denylistedUntrackedRaw } from './denylist.js'

export const REF_PREFIX = 'refs/roast/snapshots/'
export const DEFAULT_REF_RETENTION_MS = 30 * 24 * 3600 * 1000

// Added to commit-tree only: capture works without user.email and never
// attributes Roast's object to the user. Dates are not overridden.
const IDENTITY:Record<string, string> = {
    GIT_AUTHOR_NAME:'roast',
    GIT_AUTHOR_EMAIL:'roast@localhost',
    GIT_COMMITTER_NAME:'roast',
    GIT_COMMITTER_EMAIL:'roast@localhost',
}

export interface Pin {
    tree:string;
    excluded:string[];
}

export interface Snapshot {
    ref:string;
    commit:string;
    indexTree:string;
    worktreeTree:string;
    head:string;
    base:string;
    excluded:string[];
}

export interface SnapshotOpts {
    signal?:AbortSignal;
    // The environment git runs with (and GIT_INDEX_FILE is read from);
    // process.env when absent.
    env?:NodeJS.ProcessEnv;
}

export interface PinOptions extends SnapshotOpts {
    // Omitted means the default denylist; empty disables filtering.
    denylist?:readonly string[];
}

export interface CaptureOptions extends PinOptions {
    runId:string;
    headOid:string;
    baseOid:string;
    // An index tree already pinned by the caller (staged reviews).
    indexTree?:string;
    // A worktree pin already taken by the caller.
    worktree?:Pin|null;
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function wrap (prefix:string, err:unknown):Error {
    return new Error(`${prefix}: ${message(err)}`, { cause:err })
}

async function run (
    repo:string,
    args:readonly string[],
    opts:SnapshotOpts,
    extra?:{ env?:Record<string, string>, input?:Buffer|string }
):Promise<string> {
    const out = await git(repo, args, {
        signal:opts.signal,
        env:opts.env,
        extraEnv:extra?.env,
        input:extra?.input,
    })
    return out.toString('utf8').trim()
}

// Runs a git step, wrapping a failure with `prefix` unless aborted.
async function step (
    prefix:string,
    opts:SnapshotOpts,
    fn:() => Promise<string>
):Promise<string> {
    try {
        return await fn()
    } catch (err) {
        opts.signal?.throwIfAborted()
        throw wrap(prefix, err)
    }
}

// The index a review reads: GIT_INDEX_FILE from `env` (relative values
// against the toplevel `repo`), else `<gitDir>/index`.
export function liveIndexPath (
    repo:string,
    gitDir:string,
    env:NodeJS.ProcessEnv
):string {
    const live = env.GIT_INDEX_FILE ?? ''
    if (live === '') return path.join(gitDir, 'index')
    return path.isAbsolute(live) ? live : path.join(repo, live)
}

// Copies an index byte for byte to `dst` (mode 0600, truncating). A
// missing source writes nothing: git treats it as an empty index.
export async function copyIndex (src:string, dst:string):Promise<void> {
    let data:Buffer
    try {
        data = await fs.readFile(src)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw wrap(`read ${src}`, err)
    }
    let fh:fs.FileHandle
    try {
        fh = await fs.open(dst, 'w', 0o600)
    } catch (err) {
        throw wrap(`create ${dst}`, err)
    }
    try {
        await fh.writeFile(data)
    } catch (err) {
        throw wrap('copy index', err)
    } finally {
        await fh.close()
    }
}

function gitDirOf (repo:string, opts:SnapshotOpts):Promise<string> {
    return step('resolve git dir', opts,
        () => run(repo, ['rev-parse', '--absolute-git-dir'], opts))
}

async function withTempDir<T> (
    prefix:string,
    fn:(dir:string) => Promise<T>
):Promise<T> {
    let tmp:string
    try {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    } catch (err) {
        throw wrap('temp dir', err)
    }
    try {
        return await fn(tmp)
    } finally {
        await fs.rm(tmp, { recursive:true, force:true })
    }
}

// Pin steps 3-7 inside `tmp`: the worktree written through a private
// copy of the live index, with denylisted untracked paths excluded.
async function writeWorktree (
    repo:string,
    live:string,
    tmp:string,
    opts:PinOptions
):Promise<Pin> {
    const idx = path.join(tmp, 'worktree')
    await copyIndex(live, idx)
    const excluded = await denylistedUntrackedRaw(repo, {
        patterns:opts.denylist, signal:opts.signal, env:opts.env,
    })
    const env = { GIT_INDEX_FILE:idx }
    // Pathspecs go through stdin so names that are not valid UTF-8 keep
    // their raw bytes. The positive `.` is required: an exclude-only
    // pathspec matches nothing. `literal` keeps metacharacters in names
    // from widening.
    const NUL = Buffer.from([0])
    const input = Buffer.concat([Buffer.from('.'), NUL,
        ...excluded.flatMap(p => [
            Buffer.from(':(exclude,literal)'), p.raw, NUL])])
    const args = ['add', '-A', '--pathspec-from-file=-',
        '--pathspec-file-nul']
    await step('git add -A (snapshot index)', opts,
        () => run(repo, args, opts, { env, input }))
    const tree = await step('write-tree (worktree)', opts,
        () => run(repo, ['write-tree'], opts, { env }))
    return { tree, excluded:excluded.map(p => p.name) }
}

// Writes the working tree, as a review sees it, into one unreferenced
// tree object. Needs no HEAD and leaves the live index untouched.
export async function pinWorktree (
    repo:string,
    opts:PinOptions = {}
):Promise<Pin> {
    const gitDir = await gitDirOf(repo, opts)
    const live = liveIndexPath(repo, gitDir, opts.env ?? process.env)
    return withTempDir('roast-pin-',
        tmp => writeWorktree(repo, live, tmp, opts))
}

// Records a replayable snapshot: index and worktree trees joined in one
// composite tree, committed on HEAD (and a differing base), and pointed
// at by refs/roast/snapshots/<runId>. Throws rather than returning a
// partial snapshot.
export async function capture (
    repo:string,
    opts:CaptureOptions
):Promise<Snapshot> {
    if (opts.runId === '') throw new Error('snapshot: empty run id')
    if (opts.headOid === '') {
        throw new Error('repository has no commits; an unborn HEAD ' +
            'cannot be restored, so no replayable snapshot is possible')
    }
    const gitDir = await gitDirOf(repo, opts)
    const live = liveIndexPath(repo, gitDir, opts.env ?? process.env)
    return withTempDir('roast-snapshot-', async tmp => {
        let indexTree = opts.indexTree ?? ''
        if (indexTree === '') {
            const idx = path.join(tmp, 'index')
            await copyIndex(live, idx)
            indexTree = await step('write-tree (index)', opts,
                () => run(repo, ['write-tree'], opts,
                    { env:{ GIT_INDEX_FILE:idx } }))
        }
        const worktree = opts.worktree?.tree ?
            opts.worktree :
            await writeWorktree(repo, live, tmp, opts)
        const composite = await step('mktree', opts, () => run(repo,
            ['mktree'], opts, {
                input:`040000 tree ${indexTree}\tindex\n` +
                    `040000 tree ${worktree.tree}\tworktree\n`,
            }))
        const parents = ['-p', opts.headOid]
        if (opts.baseOid !== '' && opts.baseOid !== opts.headOid) {
            parents.push('-p', opts.baseOid)
        }
        const commit = await step('commit-tree', opts, () => run(repo,
            ['commit-tree', composite, ...parents,
                '-m', `roast run ${opts.runId}`],
            opts, { env:IDENTITY }))
        const ref = REF_PREFIX + opts.runId
        await step(`update-ref ${ref}`, opts,
            () => run(repo, ['update-ref', ref, commit], opts))
        return {
            ref,
            commit,
            indexTree,
            worktreeTree:worktree.tree,
            head:opts.headOid,
            base:opts.baseOid,
            excluded:[...worktree.excluded],
        }
    })
}

// Deletes a run's snapshot ref (the review's cleanup before its run
// record exists).
export async function deleteSnapshot (
    repo:string,
    runId:string,
    opts:SnapshotOpts = {}
):Promise<void> {
    if (runId === '') throw new Error('delete snapshot: empty run id')
    const ref = REF_PREFIX + runId
    await step(`delete ${ref}`, opts,
        () => run(repo, ['update-ref', '-d', ref], opts))
}

async function verify (
    repo:string,
    rev:string,
    opts:SnapshotOpts
):Promise<string> {
    try {
        return await run(repo, ['rev-parse', '--verify', '--quiet', rev],
            opts)
    } catch {
        opts.signal?.throwIfAborted()
        return ''
    }
}

// A snapshot from its ref alone: trees from the composite, head and base
// from the commit's parents (best effort). `excluded` is not recoverable.
export async function load (
    repo:string,
    runId:string,
    opts:SnapshotOpts = {}
):Promise<Snapshot> {
    const ref = REF_PREFIX + runId
    const commit = await verify(repo, `${ref}^{commit}`, opts)
    if (commit === '') {
        throw new Error(`no snapshot ref ${ref} in ${repo} (run predates ` +
            'snapshots, was pruned, or lives in another clone)')
    }
    const tree = (name:string):Promise<string> =>
        step(`snapshot ${ref} has no ${name}/ tree`, opts, () => run(repo,
            ['rev-parse', '--verify', '--quiet', `${ref}:${name}`],
            opts))
    const indexTree = await tree('index')
    const worktreeTree = await tree('worktree')
    return {
        ref,
        commit,
        indexTree,
        worktreeTree,
        head:await verify(repo, `${ref}^1`, opts),
        base:await verify(repo, `${ref}^2`, opts),
        excluded:[],
    }
}

// `opts` with GIT_INDEX_FILE removed from the child environment, so an
// inherited index (inside a hook, say) never replaces a worktree's own.
function withoutIndexFile (opts:SnapshotOpts):SnapshotOpts {
    const env = { ...(opts.env ?? process.env) }
    delete env.GIT_INDEX_FILE
    return { ...opts, env }
}

// Materializes a snapshot into a detached linked worktree at `dir`
// (resolved against the working directory once): disk holds the
// worktree tree, the index holds the index tree. A failure after
// `worktree add` removes the half-built worktree before rethrowing.
export async function restore (
    repo:string,
    runId:string,
    dir:string,
    opts:SnapshotOpts = {}
):Promise<Snapshot> {
    const o = withoutIndexFile(opts)
    const abs = path.resolve(dir)
    const snap = await load(repo, runId, o)
    if (snap.head === '') {
        throw new Error(`snapshot ${snap.ref} records no HEAD commit; ` +
            'it cannot be restored to a meaningful baseline')
    }
    await step('git worktree add', o, () => run(repo, ['worktree', 'add',
        '--detach', '--no-checkout', abs, snap.head], o))
    try {
        await step('read-tree (worktree)', o,
            () => run(abs, ['read-tree', snap.worktreeTree], o))
        await step('checkout-index', o,
            () => run(abs, ['checkout-index', '-a', '-f'], o))
        await step('read-tree (index)', o,
            () => run(abs, ['read-tree', snap.indexTree], o))
    } catch (err) {
        await removeWorktree(repo, abs, o).catch(() => {})
        throw err
    }
    return snap
}

// `worktree remove --force`, falling back to deleting `dir` and pruning
// the worktree list; fails only when the prune fails too.
export async function removeWorktree (
    repo:string,
    dir:string,
    opts:SnapshotOpts = {}
):Promise<void> {
    const o = withoutIndexFile(opts)
    let removeErr:unknown
    try {
        await run(repo, ['worktree', 'remove', '--force', dir], o)
        return
    } catch (err) {
        o.signal?.throwIfAborted()
        removeErr = err
    }
    await fs.rm(dir, { recursive:true, force:true }).catch(() => {})
    try {
        await run(repo, ['worktree', 'prune'], o)
    } catch {
        throw wrap(`worktree remove ${dir}`, removeErr)
    }
}

export interface Pruned {
    ref:string;
    runId:string;
    ageMs:number;
    deleted:boolean;
}

export interface PruneOpts extends SnapshotOpts {
    // The clock, in milliseconds since the epoch.
    now?:() => number;
}

// Deletes (or, dry, lists) snapshot refs at least `olderThanMs` old;
// zero or negative means the default retention. Refs of unknown age (a
// non-commit has no committer date) are never deleted. Only refs are
// touched: no run records, no gc.
export async function prune (
    repo:string,
    olderThanMs:number,
    dryRun:boolean,
    opts:PruneOpts = {}
):Promise<Pruned[]> {
    const threshold = olderThanMs <= 0 ?
        DEFAULT_REF_RETENTION_MS :
        olderThanMs
    const out = await step(`for-each-ref ${REF_PREFIX}`, opts,
        () => run(repo, ['for-each-ref',
            '--format=%(refname)%09%(committerdate:unix)', REF_PREFIX],
        opts))
    const now = (opts.now ?? Date.now)()
    const pruned:Pruned[] = []
    for (const line of out.split('\n')) {
        const tab = line.indexOf('\t')
        if (line.trim() === '' || tab === -1) continue
        const ref = line.slice(0, tab)
        if (!ref.startsWith(REF_PREFIX)) continue
        const ts = line.slice(tab + 1).trim()
        if (!/^[+-]?[0-9]+$/.test(ts)) continue
        const ageMs = now - Number(ts) * 1000
        if (ageMs < threshold) continue
        if (!dryRun) {
            await step(`delete ${ref}`, opts,
                () => run(repo, ['update-ref', '-d', ref], opts))
        }
        pruned.push({
            ref,
            runId:ref.slice(REF_PREFIX.length),
            ageMs,
            deleted:!dryRun,
        })
    }
    return pruned
}

// The commit `rev` names, '' when it does not resolve.
export function revOid (
    repo:string,
    rev:string,
    opts:SnapshotOpts = {}
):Promise<string> {
    return verify(repo, `${rev}^{commit}`, opts)
}

export function headOid (
    repo:string,
    opts:SnapshotOpts = {}
):Promise<string> {
    return revOid(repo, 'HEAD', opts)
}

// The tree `rev` names, '' when it does not resolve.
export function treeOid (
    repo:string,
    rev:string,
    opts:SnapshotOpts = {}
):Promise<string> {
    return verify(repo, `${rev}^{tree}`, opts)
}
