// Snapshots taken during `roast review` (spec 01, 2.8 steps 10 and 15,
// 2.13; spec 11, "When a review takes snapshots", test plan 16-18).
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import type { RecordedRequest, Script } from '../helpers/inference-server.js'
import {
    approveProjectConfig,
    chatCalls,
    gitIn,
    profileConfig,
    reviewMeta,
    runDirs,
    settingsRepo,
    writeConfig,
    type ReviewRepo,
} from '../helpers/review.js'

const REVIEW = ['review', '--no-verify', '--format', 'json']

async function configure (r:ReviewRepo, over:object):Promise<void> {
    writeConfig(r.dir, profileConfig(r.server.url, over))
    await approveProjectConfig(r)
}

// The config with review.snapshot absent (capture on).
async function snapshotsOn (r:ReviewRepo, over:object = {}):Promise<void> {
    await configure(r, { review:{}, ...over })
}

function snapshotRefs (r:ReviewRepo):string[] {
    return gitIn(r, ['for-each-ref', '--format=%(refname)',
        'refs/roast/snapshots/']).split('\n').filter(Boolean)
}

function rev (r:ReviewRepo, name:string):string {
    return gitIn(r, ['rev-parse', name]).trim()
}

function clearRuns (r:ReviewRepo):void {
    for (const dir of runDirs(r)) fs.rmSync(dir, { recursive:true })
}

test('the default config captures a snapshot with a ref', async t => {
    const r = await settingsRepo(t)
    await snapshotsOn(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    const meta = reviewMeta(r)
    const snap = meta.snapshot
    t.equal(snap.captured, true, 'captured')
    t.equal(snap.ref, `refs/roast/snapshots/${meta.run_id}`, 'ref name')
    t.deepEqual(snapshotRefs(r), [snap.ref], 'the ref exists')
    t.equal(rev(r, snap.ref), snap.commit, 'ref names the commit')
    t.equal(rev(r, `${snap.ref}:index`), snap.index_tree, 'index tree')
    t.equal(rev(r, `${snap.ref}:worktree`), snap.worktree_tree,
        'worktree tree')
    t.equal(snap.head, rev(r, 'HEAD'), 'head')
    t.equal(typeof snap.diff_pair, 'string', 'diff pair')
    t.ok(typeof snap.file_modes === 'string' && snap.file_modes !== '',
        'file modes')
    t.ok(!('reason' in snap), 'no reason when captured')
    t.ok(gitIn(r, ['show', `${snap.worktree_tree}:main.go`])
        .includes('if value < 0'), 'worktree holds the uncommitted edit')
    t.equal(meta.scope.head_oid, snap.head, 'scope head falls back')
})

test('diff_pair follows the scope', async t => {
    const r = await settingsRepo(t)
    await snapshotsOn(r)
    const first = rev(r, 'HEAD')
    fs.writeFileSync(path.join(r.dir, 'other.go'), 'package main\n')
    gitIn(r, ['add', 'other.go', '.roast.json'])
    gitIn(r, ['commit', '-q', '-m', 'second'])

    t.equal((await r.roast([...REVIEW, '--uncommitted-only'])).code, 0,
        'unbased review')
    let meta = reviewMeta(r)
    t.equal(meta.snapshot.diff_pair, 'head..worktree', 'head..worktree')
    t.equal(meta.snapshot.base_tree, rev(r, 'HEAD^{tree}'), 'head tree')
    clearRuns(r)

    t.equal((await r.roast([...REVIEW, '--base', first])).code, 0,
        'based review')
    meta = reviewMeta(r)
    t.equal(meta.snapshot.diff_pair, 'base..worktree', 'base..worktree')
    t.equal(meta.snapshot.base, first, 'base recorded')
    t.equal(meta.snapshot.base_tree, rev(r, `${first}^{tree}`),
        'base tree')
    t.equal(meta.scope.base_oid, first, 'scope base falls back')
    t.equal(rev(r, `${meta.snapshot.ref}^2`), first, 'base parent')
    clearRuns(r)

    gitIn(r, ['add', 'main.go'])
    t.equal((await r.roast([...REVIEW, '--staged'])).code, 0,
        'staged review')
    meta = reviewMeta(r)
    t.equal(meta.snapshot.diff_pair, 'head..index', 'head..index')
    t.equal(meta.snapshot.captured, true, 'captured')
})

test('an untracked denylisted file is excluded with a caveat', async t => {
    const r = await settingsRepo(t)
    await snapshotsOn(r)
    fs.writeFileSync(path.join(r.dir, 'deploy.pem'), 'secret\n')
    t.equal((await r.roast(REVIEW)).code, 0, 'review')
    const meta = reviewMeta(r)
    t.deepEqual(meta.snapshot.excluded_paths, ['deploy.pem'], 'excluded')
    t.ok(meta.caveats.some((c:string) => c.includes('excluded 1')),
        'excluded-count caveat')
    t.ok(fs.existsSync(path.join(r.dir, 'deploy.pem')), 'file kept')
})

test('ROAST_SNAPSHOT=0 does not disable capture', async t => {
    const r = await settingsRepo(t)
    await snapshotsOn(r)
    r.env.ROAST_SNAPSHOT = '0'
    t.equal((await r.roast(REVIEW)).code, 0, 'review')
    t.equal(reviewMeta(r).snapshot.captured, true, 'captured')
    t.equal(snapshotRefs(r).length, 1, 'ref written')
})

// A finder that edits main.go on disk once the review is running (after
// the pin), then asks for it with read_file.
function editThenRead (r:{ dir:string }):Script {
    return (_req, n) => {
        if (n === 0) {
            fs.writeFileSync(path.join(r.dir, 'main.go'),
                'package main // edited after the pin\n')
            return {
                stream:chatCalls([{
                    name:'read_file', args:{ path:'main.go' },
                }]),
            }
        }
        return {
            stream:chatCalls([{
                name:'submit_findings',
                args:{ assessment:'NO_FINDINGS', findings:[] },
            }]),
        }
    }
}

function toolResult (req:RecordedRequest):string {
    const body = req.body as { messages:{ role:string, content:string }[] }
    return body.messages.filter(m => m.role === 'tool')
        .map(m => m.content).join('\n')
}

const INTERACTIVE = { interactive:{ min_diff_lines:0, min_files:0 } }

test('with review.snapshot false the review reads the pinned tree',
    async t => {
        const box = { dir:'' }
        const r = await settingsRepo(t, editThenRead(box))
        box.dir = r.dir
        await configure(r, INTERACTIVE)
        const res = await r.roast([...REVIEW, '--interactive'])
        t.equal(res.code, 0, res.stderr)
        const served = toolResult(r.server.requests[1])
        t.ok(served.includes('if value < 0'), 'pinned content served')
        t.ok(!served.includes('edited after the pin'), 'not the live file')
        t.equal(reviewMeta(r).snapshot.captured, false, 'no snapshot')
        t.deepEqual(snapshotRefs(r), [], 'no ref')
    })

test('with no HEAD the review reads the pinned tree', async t => {
    const box = { dir:'' }
    const r = await settingsRepo(t, editThenRead(box))
    box.dir = r.dir
    await snapshotsOn(r, INTERACTIVE)
    // Unborn HEAD: the branch is gone, main.go stays staged.
    gitIn(r, ['update-ref', '-d', 'HEAD'])
    const res = await r.roast([...REVIEW, '--interactive'])
    t.equal(res.code, 0, res.stderr)
    const served = toolResult(r.server.requests[1])
    t.ok(served.includes('if value < 0'), 'pinned content served')
    t.ok(!served.includes('edited after the pin'), 'not the live file')
    const meta = reviewMeta(r)
    t.equal(meta.snapshot.captured, false, 'no replayable snapshot')
    t.ok(meta.snapshot.reason.includes('unborn HEAD'), 'reason')
    t.deepEqual(snapshotRefs(r), [], 'no ref')
})

test('a usage error after capture leaves no snapshot ref', async t => {
    const r = await settingsRepo(t)
    await snapshotsOn(r)
    const mode = await r.roast([...REVIEW, '--mode', 'poetry'])
    t.equal(mode.code, 2, 'invalid --mode is a usage error')
    t.deepEqual(snapshotRefs(r), [], 'no ref after invalid --mode')
    t.deepEqual(runDirs(r), [], 'no run record')

    await snapshotsOn(r, { limits:{ max_prompt_bytes:10 } })
    const big = await r.roast(REVIEW)
    t.equal(big.code, 2, 'prompt over the ceiling is a usage error')
    t.deepEqual(snapshotRefs(r), [], 'no ref after the prompt ceiling')
    t.equal(r.server.requests.length, 0, 'no request sent')
})

test('a finder failure after run-record init keeps the ref', async t => {
    const r = await settingsRepo(t, () => ({ status:400, body:'bad' }))
    await snapshotsOn(r, { limits:{ max_attempts:1 } })
    const res = await r.roast(REVIEW)
    t.ok(res.code !== 0, 'review fails')
    const meta = reviewMeta(r)
    t.equal(meta.snapshot.captured, true, 'captured')
    t.deepEqual(snapshotRefs(r), [meta.snapshot.ref], 'ref kept')
})
