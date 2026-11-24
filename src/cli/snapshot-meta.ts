// The snapshot capture decision for a review (spec 01, 2.13). The
// snapshot area's functions are injected so the decision is testable
// without Git.
import type { GitRunOpts } from '../git/git.js'
import type { SnapshotMeta } from '../record/meta-types.js'
import type { Scope } from '../scope/index.js'
import {
    type Pin,
    capture,
    headOid,
    revOid,
    treeOid,
} from '../snapshot/snapshot.js'

// A pinned worktree tree (snapshot area pinWorktree); null when none.
export type WorktreePin = Pin|null

export interface CaptureOptions {
    runId:string;
    headOID:string;
    baseOID:string;
    indexTree:string;
    worktree:WorktreePin;
}

export interface Capture {
    ref:string;
    commit:string;
    indexTree:string;
    worktreeTree:string;
    head:string;
    base:string;
    excluded:string[];
}

export interface SnapshotDeps {
    capture (repo:string, opts:CaptureOptions):Promise<Capture>;
    // Each resolves '' when the revision does not resolve.
    headOID (repo:string):Promise<string>;
    revOID (repo:string, rev:string):Promise<string>;
    treeOID (repo:string, rev:string):Promise<string>;
}

export const DISABLED_REASON = 'disabled by review.snapshot'
export const DISABLED_CAVEAT =
    'Git snapshot capture was disabled; this run cannot be replayed.'
export const FILE_MODES = 'regular and executable files plus symlinks; ' +
    'empty directories are not represented'

export function defaultSnapshotDeps (opts:GitRunOpts):SnapshotDeps {
    const o = { env:opts.env, signal:opts.signal }
    return {
        capture:(repo, c) => capture(repo, {
            runId:c.runId,
            headOid:c.headOID,
            baseOid:c.baseOID,
            indexTree:c.indexTree,
            worktree:c.worktree,
            ...o,
        }),
        headOID:repo => headOid(repo, o),
        revOID:(repo, rev) => revOid(repo, rev, o),
        treeOID:(repo, rev) => treeOid(repo, rev, o),
    }
}

export interface SnapshotDecision {
    meta:SnapshotMeta;
    caveats:string[];
}

export async function captureSnapshot (
    enabled:boolean,
    repo:string,
    runId:string,
    scope:Pick<Scope, 'headOID'|'base'|'staged'|'survey'>,
    indexTree:string,
    pin:WorktreePin,
    deps:SnapshotDeps
):Promise<SnapshotDecision> {
    if (!enabled) {
        return {
            meta:{ captured:false, reason:DISABLED_REASON },
            caveats:[DISABLED_CAVEAT],
        }
    }
    const head = scope.headOID || await deps.headOID(repo)
    const base = scope.base !== '' ? await deps.revOID(repo, scope.base) : ''
    let snap:Capture
    try {
        snap = await deps.capture(repo, {
            runId, headOID:head, baseOID:base, indexTree, worktree:pin,
        })
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        return {
            meta:{ captured:false, reason, head, base },
            caveats:[`Git snapshot capture failed: ${reason}`],
        }
    }
    const diffPair = scope.staged ? 'head..index' :
        scope.survey ? 'head' :
            scope.base === '' ? 'head..worktree' : 'base..worktree'
    const meta:SnapshotMeta = {
        captured:true,
        ref:snap.ref,
        commit:snap.commit,
        index_tree:snap.indexTree,
        worktree_tree:snap.worktreeTree,
        head:snap.head,
        base:snap.base,
        diff_pair:diffPair,
        file_modes:FILE_MODES,
        excluded_paths:[...snap.excluded],
    }
    const src = diffPair === 'base..worktree' ? base : head
    if (src !== '') meta.base_tree = await deps.treeOID(repo, src)
    const caveats = snap.excluded.length > 0 ?
        [`snapshot excluded ${snap.excluded.length} denylisted untracked ` +
            'path(s)'] :
        []
    return { meta, caveats }
}
