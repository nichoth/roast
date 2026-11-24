// A hooks directory shared by two repositories through core.hooksPath
// (spec 12, 5, "Shared dispatcher").
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { ROOT } from '../helpers/spawn.js'
import { inspect, isActive } from '../../src/gate/hook.js'
import {
    git,
    localConfig,
    read,
    scratch,
    writeHook,
    type GateRepo,
} from './helpers.js'
import { CLEAN, commit, newStub, seededRepo } from './exec-helpers.js'

const SCRIPT = fs.readFileSync(
    path.join(ROOT, 'src', 'gate', 'pre-commit.sh'), 'utf8')

const LEGACY = '#!/bin/sh\n# roast-gate-hook: v1\n# legacy\nexit 0\n'

// A roast.gate=enabled from a non-local scope (command-line config from
// the environment), which must never enroll a repository.
const NON_LOCAL_ENABLED = {
    GIT_CONFIG_COUNT:'1',
    GIT_CONFIG_KEY_0:'roast.gate',
    GIT_CONFIG_VALUE_0:'enabled',
}

interface Shared {
    first:GateRepo;
    second:GateRepo;
    hooks:string;
    hook:string;
    sidecar:string;
}

function sharedRepos (t:CleanupTest):Shared {
    const first = seededRepo(t)
    const second = seededRepo(t)
    const hooks = scratch(t)
    for (const r of [first, second]) {
        git(r.dir, r.env, 'config', 'core.hooksPath', hooks)
    }
    return {
        first,
        second,
        hooks,
        hook:path.join(hooks, 'pre-commit'),
        sidecar:path.join(hooks, 'roast-pre-commit'),
    }
}

function gate (r:GateRepo, sub:string) {
    return runRoast(['gate', sub], { cwd:r.dir, env:r.env })
}

test('a shared hook does not review without local consent', async t => {
    for (const decision of ['', 'declined', 'unexpected']) {
        const s = sharedRepos(t)
        t.equal((await gate(s.first, 'enable')).code, 0, 'enable first')
        git(s.second.dir, s.second.env, 'config', '--local', '--unset-all',
            'roast.gate')
        if (decision) {
            git(s.second.dir, s.second.env, 'config', '--local',
                'roast.gate', decision)
        }
        const stub = newStub(t, s.first.dir, s.second.dir)
        const res = commit(s.second, stub,
            { STUB_EXIT:'1', ...NON_LOCAL_ENABLED })
        t.ok(res.ok, `decision=${decision}: commit allowed`)
        t.equal(stub.ran(), '', `decision=${decision}: no review ran`)
        const st = await inspect(s.second.dir,
            { ...s.second.env, ...NON_LOCAL_ENABLED })
        t.ok(st.shared && !isActive(st), 'shared and not active')

        const enrolled = commit(s.first, stub, { STUB_STDOUT:CLEAN })
        t.ok(enrolled.ok, 'enrolled repo commits')
        t.ok(stub.ran() !== '', 'the enrolled repo still reviews')
    }
})

test('disable in one repo preserves the dispatcher for the other',
    async t => {
        for (const foreign of [false, true]) {
            const s = sharedRepos(t)
            if (foreign) writeHook(s.hook, '#!/bin/sh\n# foreign\nexit 0\n')
            t.equal((await gate(s.first, 'enable')).code, 0, 'enable first')
            const before = read(s.hook)
            const res = await gate(s.second, 'disable')
            t.equal(res.code, 0, 'disable exits 0')
            t.equal(read(s.hook), before, 'dispatcher unchanged')
            t.equal(localConfig(s.second, 'roast.gate'), 'declined',
                'second declined')
            if (foreign) t.ok(fs.existsSync(s.sidecar), 'sidecar kept')

            const stub = newStub(t, s.first.dir, s.second.dir)
            const off = commit(s.second, stub, { STUB_EXIT:'1' })
            t.ok(off.ok && stub.ran() === '', 'second does not review')
            const on = commit(s.first, stub, { STUB_STDOUT:CLEAN })
            t.ok(on.ok && stub.ran() !== '', 'first still reviews')
        }
    })

test('disable refreshes a legacy shared dispatcher', async t => {
    const standalone = sharedRepos(t)
    writeHook(standalone.hook, LEGACY)
    let res = await gate(standalone.second, 'disable')
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(standalone.hook), SCRIPT, 'legacy hook refreshed')

    const manual = sharedRepos(t)
    const python = '#!/usr/bin/env python3\n# manual hook\n'
    writeHook(manual.hook, python)
    writeHook(manual.sidecar, LEGACY)
    res = await gate(manual.second, 'disable')
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(manual.sidecar), SCRIPT, 'legacy sidecar refreshed')
    t.equal(read(manual.hook), python, 'manual foreign hook unchanged')
})

test('shared disable never touches a foreign sidecar', async t => {
    const s = sharedRepos(t)
    const theirs = '#!/bin/sh\n# not Roast-owned\nexit 0\n'
    writeHook(s.sidecar, theirs)
    const res = await gate(s.second, 'disable')
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(s.sidecar), theirs, 'foreign sidecar unchanged')
})

test('enable then disable keeps a shared dispatcher', async t => {
    const s = sharedRepos(t)
    t.equal((await gate(s.first, 'enable')).code, 0, 'enable exits 0')
    t.equal((await gate(s.first, 'disable')).code, 0, 'disable exits 0')
    t.equal(read(s.hook), SCRIPT, 'dispatcher still installed')
    const st = await inspect(s.first.dir, s.first.env)
    t.ok(st.ours && st.decision === 'declined' && !isActive(st),
        'ours, declined, inactive')
})
