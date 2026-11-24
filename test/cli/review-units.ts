// Lower seams of the review command: exit selection (spec 01, 2.2),
// resolution helpers (2.8 step 11, 2.14), and the snapshot decision
// (2.13).
import { test } from '../helpers/test.js'
import { reviewExitError } from '../../src/cli/review.js'
import {
    configInt,
    flagOrConfig,
    flagOrConfigDuration,
    flagOrConfigInt,
    resolveLangs,
} from '../../src/cli/resolve.js'
import {
    type Capture,
    type SnapshotDeps,
    captureSnapshot,
} from '../../src/cli/snapshot-meta.js'
import { ExitSignal, UsageError, exitCode } from '../../src/cli/errors.js'

test('a finalize failure wins over the severity gate', t => {
    const failure = new Error('finalize run report: disk full')
    const err = reviewExitError(failure, 3, 4, false)
    t.equal(err, failure, 'finalize error returned')
    t.equal(exitCode(err), 4, 'exit 4')
    t.equal(exitCode(reviewExitError(failure, 0, 4, true)), 4,
        'also over partial')
    const gate = reviewExitError(null, 3, 3, true)
    t.ok(gate instanceof ExitSignal && gate.code === 1, 'gate exits 1')
    const partial = reviewExitError(null, 3, 2, true)
    t.ok(partial instanceof ExitSignal && partial.code === 4,
        'partial exits 4')
    t.equal(reviewExitError(null, -1, 4, false), null, 'no gate: clean')
    t.equal(reviewExitError(null, 0, -1, false), null,
        'INFO gate without findings: clean')
})

test('resolveLangs', t => {
    t.deepEqual(resolveLangs(['go'], ['a.go'], 'prose'), [], 'prose')
    t.deepEqual(resolveLangs([], ['a.go'], 'code'), ['go'], 'classified')
    t.deepEqual(resolveLangs(['none'], ['a.go'], 'code'), [], 'none')
    t.deepEqual(resolveLangs(['web', 'go'], [], 'mixed'), ['web', 'go'],
        'flag order kept')
    for (const bad of [['none', 'go'], ['go', 'none'], ['cobol'],
        ['Go']]) {
        let err:unknown
        try {
            resolveLangs(bad, [], 'code')
        } catch (e) {
            err = e
        }
        t.ok(err instanceof UsageError, `${bad.join(',')} is a usage error`)
    }
})

test('flag -> config -> default resolution', t => {
    t.equal(configInt(undefined, 7), 7, 'unset config falls back')
    t.equal(configInt(0, 7), 0, 'explicit 0 counts as set')
    t.equal(flagOrConfig(undefined, undefined, 4), 4, 'default')
    t.equal(flagOrConfig(undefined, 2, 4), 2, 'config')
    t.equal(flagOrConfig(0, 2, 4), 0, 'flag 0 wins')
    t.equal(flagOrConfigInt(true, 0, 9, 4), 0, 'changed flag')
    t.equal(flagOrConfigInt(false, 0, 9, 4), 9, 'unchanged flag')
    t.equal(flagOrConfigInt(false, 0, undefined, 4), 4, 'fallback')
    t.equal(flagOrConfigDuration(true, 0n, 5n, 6n), 0n, 'duration flag')
    t.equal(flagOrConfigDuration(false, 0n, 0n, 6n), 0n, 'config 0')
    t.equal(flagOrConfigDuration(false, 0n, undefined, 6n), 6n,
        'duration default')
})

const SCOPE = { headOID:'', base:'', staged:false, survey:false }

function deps (capture?:() => Promise<Capture>):SnapshotDeps&{
    calls:string[],
} {
    const calls:string[] = []
    return {
        calls,
        capture () {
            calls.push('capture')
            return capture ? capture() : Promise.reject(new Error('no'))
        },
        async headOID () {
            calls.push('head')
            return 'h'.repeat(40)
        },
        async revOID (_repo, rev) {
            calls.push(`rev ${rev}`)
            return 'b'.repeat(40)
        },
        async treeOID (_repo, rev) {
            calls.push(`tree ${rev}`)
            return `tree-of-${rev}`
        },
    }
}

test('captureSnapshot: disabled branch', async t => {
    const d = deps()
    const res = await captureSnapshot(false, '/repo', 'run', SCOPE, '',
        null, d)
    t.deepEqual(res.meta, {
        captured:false, reason:'disabled by review.snapshot',
    }, 'disabled meta')
    t.equal(res.caveats.length, 1, 'one caveat')
    t.deepEqual(d.calls, [], 'nothing resolved or captured')
})

test('captureSnapshot: failure and diff pairs', async t => {
    const failed = await captureSnapshot(true, '/repo', 'run',
        { ...SCOPE, base:'main' }, '', null, deps())
    t.equal(failed.meta.captured, false, 'not captured')
    t.equal(failed.meta.reason, 'no', 'reason is the error')
    t.equal(failed.meta.head, 'h'.repeat(40), 'head recorded')
    t.equal(failed.meta.base, 'b'.repeat(40), 'base recorded')
    t.equal(failed.caveats.length, 1, 'failure caveat')
    const snap = (excluded:string[]):Capture => ({
        ref:'refs/roast/run',
        commit:'c',
        indexTree:'i',
        worktreeTree:'w',
        head:'h',
        base:'b',
        excluded,
    })
    const cases:[object, string, string][] = [
        [{ staged:true }, 'head..index', `tree ${'h'.repeat(40)}`],
        [{ survey:true }, 'head', `tree ${'h'.repeat(40)}`],
        [{}, 'head..worktree', `tree ${'h'.repeat(40)}`],
        [{ base:'main' }, 'base..worktree', `tree ${'b'.repeat(40)}`],
    ]
    for (const [over, pair, treeCall] of cases) {
        const d = deps(async () => snap(['.env']))
        const res = await captureSnapshot(true, '/repo', 'run',
            { ...SCOPE, ...over }, '', null, d)
        t.equal(res.meta.diff_pair, pair, `diff pair ${pair}`)
        t.ok(d.calls.includes(treeCall), `base tree from ${treeCall}`)
        t.deepEqual(res.meta.excluded_paths, ['.env'], 'excluded paths')
        t.equal(res.caveats.length, 1, 'excluded caveat')
    }
})
