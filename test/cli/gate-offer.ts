// The gate offer before a review (spec 01, 2.9; spec 12, 2.11), driven
// through the in-process CLI against the fake inference server. Outcomes
// are observed through local git config and hook files.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test, type CleanupTest } from '../helpers/test.js'
import { ROOT } from '../helpers/spawn.js'
import { simulateTerminals } from '../helpers/terminal.js'
import {
    type ReviewRepo,
    approveProjectConfig,
    profileConfig,
    requestRecorder,
    settingsRepo,
    writeConfig,
} from '../helpers/review.js'
import { tempDir } from '../helpers/repo.js'
import { ISOLATED_GIT, git, writeHook } from '../gate/helpers.js'

const SCRIPT = fs.readFileSync(
    path.join(ROOT, 'src', 'gate', 'pre-commit.sh'), 'utf8')

const REVIEW = ['review', '--quick', '--format', 'json']

interface OfferRepo extends ReviewRepo {
    hook:string;
    // A local git config value, '' when unset.
    local (key:string):string;
}

async function offerRepo (
    t:CleanupTest,
    opts:{ config?:object|null, approve?:boolean } = {}
):Promise<OfferRepo> {
    const r = await settingsRepo(t, undefined, opts)
    Object.assign(r.env, ISOLATED_GIT)
    return {
        ...r,
        hook:path.join(r.dir, '.git', 'hooks', 'pre-commit'),
        local:(key:string) => {
            try {
                return git(r.dir, r.env, 'config', '--local', '--get', key)
            } catch {
                return ''
            }
        },
    }
}

test('a yes on a terminal installs the gate and the review runs',
    async t => {
        simulateTerminals(t, true)
        const r = await offerRepo(t)
        const requests = requestRecorder(r)
        const res = await r.roast(REVIEW, { stdin:'y\n' })
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        t.equal(r.local('roast.gate'), 'enabled', 'records enabled')
        t.equal(fs.readFileSync(r.hook, 'utf8'), SCRIPT, 'hook installed')
        t.ok(requests().length > 0, 'the review reached the fake server')
    })

// A stdin that answers `y` and counts how often it was read.
function countingStdin ():{ stdin:Readable, reads:() => number } {
    let reads = 0
    const stdin = new Readable({
        read () {
            reads++
            this.push('y\n')
            this.push(null)
        },
    })
    return { stdin, reads:() => reads }
}

// Every local roast.* key and value.
function gateKeys (r:OfferRepo):string {
    try {
        return git(r.dir, r.env, 'config', '--local', '--get-regexp',
            '^roast\\.')
    } catch {
        return ''
    }
}

test('a no is remembered and never asked again', async t => {
    simulateTerminals(t, true)
    const r = await offerRepo(t)
    const res = await r.roast(REVIEW, { stdin:'n\n' })
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(r.local('roast.gate'), 'declined', 'records declined')
    t.ok(!fs.existsSync(r.hook), 'no hook')
    const again = countingStdin()
    const second = await r.roast(REVIEW, { stdin:again.stdin })
    t.equal(second.code, 0, 'second review exits 0')
    t.equal(again.reads(), 0, 'the offer reads no stdin')
    t.ok(!fs.existsSync(r.hook), 'still no hook')
})

test('without terminals the offer is a one-time hint', async t => {
    simulateTerminals(t, false)
    const r = await offerRepo(t)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(r.local('roast.gate-notice'), 'sent', 'notice recorded')
    t.equal(r.local('roast.gate'), '', 'no decision')
    t.ok(!fs.existsSync(r.hook), 'no hook')
    const before = gateKeys(r)
    t.equal((await r.roast(REVIEW)).code, 0, 'second review exits 0')
    t.equal(gateKeys(r), before, 'config unchanged')
    t.ok(!fs.existsSync(r.hook), 'still no hook')
})

test('GIT_INDEX_FILE suppresses the offer', async t => {
    for (const terminals of [false, true]) {
        simulateTerminals(t, terminals)
        const r = await offerRepo(t)
        r.env.GIT_INDEX_FILE = path.join(r.dir, '.git', 'index')
        const stdin = countingStdin()
        await r.roast(REVIEW, { stdin:stdin.stdin })
        t.equal(gateKeys(r), '', 'no roast.gate keys')
        t.equal(stdin.reads(), 0, 'no prompt')
        t.ok(!fs.existsSync(r.hook), 'no hook')
    }
})

test('gate.offer false neither prompts nor hints', async t => {
    for (const terminals of [false, true]) {
        simulateTerminals(t, terminals)
        const r = await offerRepo(t, { approve:false })
        writeConfig(r.dir, profileConfig(r.server.url,
            { gate:{ offer:false } }))
        await approveProjectConfig(r)
        const stdin = countingStdin()
        const res = await r.roast(REVIEW, { stdin:stdin.stdin })
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        t.equal(stdin.reads(), 0, 'no prompt')
        t.equal(gateKeys(r), '', 'notice not consumed')
        t.ok(!fs.existsSync(r.hook), 'no hook')
    }
})

test('ROAST_NO_HOOK does not stop the offer', async t => {
    simulateTerminals(t, false)
    const r = await offerRepo(t)
    r.env.ROAST_NO_HOOK = '1'
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(r.local('roast.gate-notice'), 'sent', 'hinted')
})

test('bare roast offers the gate too', async t => {
    simulateTerminals(t, false)
    const r = await offerRepo(t)
    const res = await r.roast(['--quick', '--format', 'json'])
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(r.local('roast.gate-notice'), 'sent', 'hinted')
})

test('only a toplevel config gets an offer', async t => {
    simulateTerminals(t, false)
    const sub = await offerRepo(t, { config:null })
    const dir = path.join(sub.dir, 'pkg')
    writeConfig(dir, profileConfig(sub.server.url))
    await approveProjectConfig(sub, [], dir)
    const res = await sub.roast(REVIEW, { cwd:dir })
    t.equal(res.code, 0, `subdirectory config reviews ${res.stderr}`)
    t.equal(gateKeys(sub), '', 'no offer for a subdirectory config')

    for (const format of ['json', 'markdown']) {
        const top = await offerRepo(t)
        const out = await top.roast(['review', '--quick', '--format', format])
        t.equal(out.code, 0, `exits 0 ${out.stderr}`)
        t.equal(top.local('roast.gate-notice'), 'sent',
            `offer under --format ${format}`)
    }

    const quiet = await offerRepo(t)
    const out = await quiet.roast([...REVIEW, '--error-format', 'json'])
    t.equal(out.code, 0, `exits 0 ${out.stderr}`)
    t.equal(gateKeys(quiet), '', 'no offer under --error-format json')
})

test('a toplevel config that fails to load gives no offer', async t => {
    simulateTerminals(t, false)
    const r = await offerRepo(t)
    writeConfig(r.dir, profileConfig(r.server.url,
        { gate:{ offer:'no' } }))
    const res = await r.roast(REVIEW)
    t.equal(res.code, 2, 'the review reports the config error')
    t.equal(gateKeys(r), '', 'no offer')
    t.ok(!fs.existsSync(r.hook), 'no hook')
})

const LEGACY = '#!/bin/sh\n# roast-gate-hook: v1\n# legacy\nexit 0\n'

// Points the repo at a hooks directory outside it (core.hooksPath) that
// already holds an old Roast dispatcher; returns the dispatcher path.
function sharedLegacyHook (t:CleanupTest, r:OfferRepo):string {
    const hooks = tempDir('roast-shared-hooks-')
    t.cleanup(hooks.remove)
    git(r.dir, r.env, 'config', 'core.hooksPath', hooks.dir)
    const hook = path.join(hooks.dir, 'pre-commit')
    writeHook(hook, LEGACY)
    return hook
}

test('a declined repo gets a stale shared dispatcher refreshed', async t => {
    simulateTerminals(t, true)
    const r = await offerRepo(t)
    git(r.dir, r.env, 'config', '--local', 'roast.gate', 'declined')
    const hook = sharedLegacyHook(t, r)
    const sidecar = path.join(path.dirname(hook), 'roast-pre-commit')
    writeHook(sidecar, LEGACY)
    const stdin = countingStdin()
    const res = await r.roast(REVIEW, { stdin:stdin.stdin })
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(fs.readFileSync(hook, 'utf8'), SCRIPT, 'dispatcher refreshed')
    t.equal(fs.readFileSync(sidecar, 'utf8'), SCRIPT, 'sidecar refreshed')
    t.equal(r.local('roast.gate'), 'declined', 'still declined')
    t.equal(stdin.reads(), 0, 'not asked')
})

test('an inherited shared gate is not adopted', async t => {
    for (const terminals of [false, true]) {
        simulateTerminals(t, terminals)
        const r = await offerRepo(t)
        const hook = sharedLegacyHook(t, r)
        const res = await r.roast(REVIEW, { stdin:'' })
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        t.equal(fs.readFileSync(hook, 'utf8'), SCRIPT,
            'dispatcher refreshed')
        t.equal(r.local('roast.gate'), terminals ? 'declined' : '',
            terminals ? 'end of input declines' : 'roast.gate stays unset')
    }
})

test('a failed bootstrap does not change the exit code', async t => {
    simulateTerminals(t, true)
    const r = await offerRepo(t)
    const hooks = path.dirname(r.hook)
    fs.mkdirSync(hooks, { recursive:true })
    fs.chmodSync(hooks, 0o555)
    t.cleanup(() => fs.chmodSync(hooks, 0o755))
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW, { stdin:'y\n' })
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.ok(!fs.existsSync(r.hook), 'no hook')
    t.ok(requests().length > 0, 'the review still ran')
})
