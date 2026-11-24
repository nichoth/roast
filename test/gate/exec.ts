// The installed hook driven through a real `git commit` (spec 12, 5,
// "Hook execution"), with a shell stub at node_modules/.bin/roast so no
// model is called. The hook is installed with `roast gate enable`, so
// these prove the TS install path writes a working hook.
//
// ROAST_TEST_SKIP_GATE_TIMEOUT=1 skips the tests that sleep.
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { git, scratch, writeHook } from './helpers.js'
import {
    BLOCKING,
    CLEAN,
    commit,
    enable,
    logLine,
    newStub,
    projectRoast,
    seededRepo,
} from './exec-helpers.js'

const SKIP_SLOW = process.env.ROAST_TEST_SKIP_GATE_TIMEOUT === '1'

test('the gate reviews only the path-scoped commit content', async t => {
    const r = seededRepo(t)
    await enable(t, r)
    const s = newStub(t, r.dir)
    const { ok } = commit(r, s, { STUB_STDOUT:CLEAN })
    t.ok(ok, 'commit succeeds')
    const seen = s.ran()
    t.equal(logLine(seen, 'NAMES: '), 'b.txt', 'scope is exactly b.txt')
    t.ok(seen.includes('b-IN-THIS-COMMIT'), 'sees the committed content')
    t.ok(!seen.includes('a-STAGED-NOT-COMMITTED'),
        'does not see staged content outside the commit')
    t.equal(git(r.dir, r.env, 'diff', '--cached', '--name-only'), 'a.txt',
        'a.txt is still staged')
})

test('findings block the commit and reach the user', async t => {
    const r = seededRepo(t)
    await enable(t, r)
    const s = newStub(t, r.dir)
    const { ok, out } = commit(r, s, {
        STUB_STDOUT:BLOCKING,
        STUB_STDERR:'MARKER-R-abc123',
        STUB_EXIT:'1',
    })
    t.ok(!ok, 'commit blocked')
    t.ok(out.includes('MARKER-R-abc123'), 'the stub stderr is shown')
    t.equal(git(r.dir, r.env, 'rev-list', '--count', 'HEAD'), '1',
        'nothing committed')
})

test('ROAST_SKIP bypasses the gate entirely', async t => {
    const r = seededRepo(t)
    await enable(t, r)
    const s = newStub(t, r.dir)
    const { ok } = commit(r, s, { ROAST_SKIP:'1', STUB_EXIT:'1' })
    t.ok(ok, 'commit succeeds')
    t.equal(s.ran(), '', 'no review ran')
})

test('operational failures allow the commit', async t => {
    const cases:[string, Record<string, string>][] = [
        ['empty stdout, exit 0', { STUB_EXIT:'0' }],
        ['empty stdout, exit 3', { STUB_EXIT:'3' }],
        ['exit 4', {
            STUB_STDOUT:CLEAN,
            STUB_STDERR:'MARKER-unreachable',
            STUB_EXIT:'4',
        }],
        ['exit 2', {
            STUB_STDERR:'MARKER-untrusted', STUB_EXIT:'2',
        }],
    ]
    for (const [name, extra] of cases) {
        const r = seededRepo(t)
        await enable(t, r)
        const s = newStub(t, r.dir)
        const { ok, out } = commit(r, s, extra)
        t.ok(ok, `${name}: commit allowed`)
        t.ok(s.ran() !== '', `${name}: the review ran`)
        if (extra.STUB_STDERR) {
            t.ok(out.includes(extra.STUB_STDERR), `${name}: stderr shown`)
        }
    }
})

test('a missing project roast allows the commit', async t => {
    const r = seededRepo(t)
    await enable(t, r)
    // A roast on PATH must never stand in for the project one.
    const bin = scratch(t)
    const onPath = newStub(t, bin)
    fs.renameSync(projectRoast(bin), path.join(bin, 'roast'))
    const { ok } = commit(r, onPath, {
        PATH:`${bin}:${r.env.PATH ?? ''}`,
        STUB_EXIT:'1',
        STUB_STDOUT:BLOCKING,
    })
    t.ok(ok, 'commit allowed')
    t.equal(onPath.ran(), '', 'no roast from PATH ran')
})

test('failing gate settings allow the commit without a review',
    async t => {
        const r = seededRepo(t)
        await enable(t, r)
        const s = newStub(t, r.dir)
        const { ok, out } = commit(r, s, {
            STUB_SETTINGS_EXIT:'2',
            STUB_SETTINGS_STDERR:'MARKER-no-config',
            STUB_EXIT:'1',
            STUB_STDOUT:BLOCKING,
        })
        t.ok(ok, 'commit allowed')
        t.ok(out.includes('MARKER-no-config'), 'settings stderr shown')
        t.equal(s.ran(), '', 'no review ran')
    })

test('severity comes from gate settings, not the environment',
    async t => {
        const r = seededRepo(t)
        await enable(t, r)
        const s = newStub(t, r.dir)
        const { ok } = commit(r, s, {
            STUB_STDOUT:CLEAN,
            STUB_SEVERITY:'MEDIUM',
            ROAST_GATE_SEVERITY:'CRITICAL',
        })
        t.ok(ok, 'commit succeeds')
        t.ok(logLine(s.ran(), 'ARGS: ').includes('--max-severity MEDIUM'),
            'the review threshold is the settings severity')
    })

if (!SKIP_SLOW) {
    test('a review past the timeout allows the commit', async t => {
        const r = seededRepo(t)
        await enable(t, r)
        const s = newStub(t, r.dir)
        const started = Date.now()
        const { ok } = commit(r, s, {
            STUB_SLEEP:'10',
            STUB_STDOUT:BLOCKING,
            STUB_EXIT:'1',
            STUB_TIMEOUT:'1',
        })
        t.ok(ok, 'commit allowed')
        t.ok(Date.now() - started < 9000, 'the review was cut short')
    })

    test('the timeout comes from gate settings, not the environment',
        async t => {
            const r = seededRepo(t)
            await enable(t, r)
            const s = newStub(t, r.dir)
            const { ok } = commit(r, s, {
                STUB_SLEEP:'3',
                STUB_STDOUT:BLOCKING,
                STUB_EXIT:'1',
                STUB_TIMEOUT:'0',
                ROAST_GATE_TIMEOUT:'1',
            })
            t.ok(!ok, 'the review ran to completion and blocked')
        })
}

test('the appended block runs alongside a foreign hook', async t => {
    const r = seededRepo(t)
    const marker = path.join(scratch(t), 'foreign-ran')
    writeHook(r.hook, `#!/bin/sh\ntouch "${marker}"\n`)
    await enable(t, r)
    const s = newStub(t, r.dir)

    let res = commit(r, s, {
        STUB_STDOUT:BLOCKING,
        STUB_STDERR:'MARKER-R-deadbe',
        STUB_EXIT:'1',
    })
    t.ok(!res.ok, 'blocking review fails the commit')
    t.ok(res.out.includes('MARKER-R-deadbe'), 'findings shown')

    res = commit(r, s, { STUB_STDOUT:CLEAN })
    t.ok(res.ok, 'clean review commits')
    t.ok(fs.existsSync(marker), 'the foreign hook ran too')
})

test('the block runs in a foreign hook that exits early', async t => {
    const r = seededRepo(t)
    writeHook(r.hook, '#!/bin/sh\nexit 0\n')
    await enable(t, r)
    const s = newStub(t, r.dir)
    const { ok } = commit(r, s, { STUB_STDOUT:BLOCKING, STUB_EXIT:'1' })
    t.ok(!ok, 'commit blocked')
    t.ok(s.ran() !== '', 'the review ran')
})

test('a non-executable hook does not run', async t => {
    const r = seededRepo(t)
    writeHook(r.hook, '#!/bin/sh\nmake lint\n')
    await enable(t, r)
    fs.chmodSync(r.hook, 0o644)
    const status = await runRoast(['gate', 'status'],
        { cwd:r.dir, env:r.env })
    t.equal(status.code, 0, 'status exits 0')
    const s = newStub(t, r.dir)
    const { ok } = commit(r, s, { STUB_EXIT:'1' })
    t.ok(ok, 'commit succeeds')
    t.equal(s.ran(), '', 'git skipped the hook')
})
