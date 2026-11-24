// Provider failures and cancellation through `roast review` (spec 01,
// 2.2, 2.3, 2.8 cancellation notes; spec.md change 22).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { ROOT } from '../helpers/spawn.js'
import type { Script } from '../helpers/inference-server.js'
import {
    requestRecorder,
    runDirs,
    settingsRepo,
    type ReviewRepo,
} from '../helpers/review.js'
import { CancelledError } from '../../src/cli/errors.js'

const REVIEW = ['review', '--no-verify', '--format', 'json',
    '--error-format', 'json']

function lastError (stderr:string):Record<string, unknown> {
    const line = stderr.trim().split('\n').pop() ?? ''
    return JSON.parse(line)
}

function initializedOnly (t:{ ok (v:unknown, m:string):void },
    r:ReviewRepo):void {
    const dirs = runDirs(r)
    t.ok(dirs.length === 1, 'run directory initialized')
    t.ok(fs.existsSync(path.join(dirs[0], 'meta.json')), 'meta written')
    t.ok(!fs.existsSync(path.join(dirs[0], 'result.json.gz')),
        'no result artifact')
}

test('a provider 401 exits 3 with category auth', async t => {
    const r = await settingsRepo(t, () => ({
        status:401,
        body:'{"error":{"message":"bad key"}}',
        headers:{ 'content-type':'application/json' },
    }))
    const res = await r.roast(REVIEW)
    t.equal(res.code, 3, 'exit 3')
    t.equal(lastError(res.stderr).error_category, 'auth', 'auth category')
    initializedOnly(t, r)
})

test('a provider 500 after retries exits 4 with category endpoint',
    async t => {
        const r = await settingsRepo(t, () => ({
            status:500,
            body:'{"error":{"message":"boom"}}',
            headers:{
                'content-type':'application/json', 'retry-after-ms':'1',
            },
        }))
        const requests = requestRecorder(r)
        const res = await r.roast([...REVIEW, '--max-attempts', '2'])
        t.equal(res.code, 4, 'exit 4')
        t.equal(lastError(res.stderr).error_category, 'endpoint',
            'endpoint category')
        t.ok(requests().length >= 2, 'retried')
        initializedOnly(t, r)
    })

// A fake that accepts requests and never answers.
function hang (pending:Set<() => void>):Script {
    return () => res => new Promise<void>(resolve => {
        pending.add(() => {
            res.destroy()
            resolve()
        })
    })
}

test('aborting io.signal during the finder exits 5', async t => {
    const pending = new Set<() => void>()
    t.cleanup(() => { for (const f of pending) f() })
    const r = await settingsRepo(t, hang(pending))
    const controller = new AbortController()
    const requests = requestRecorder(r)
    const running = r.roast(REVIEW, { signal:controller.signal })
    while (requests().length === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    controller.abort(new CancelledError())
    const res = await running
    t.equal(res.code, 5, 'exit 5')
    t.equal(lastError(res.stderr).error_category, 'cancelled', 'cancelled')
})

interface Spawned {
    code:number|null;
    sent:number;
}

// Spawns the built CLI and sends SIGINT once `ready()` holds; with
// `twice`, a second SIGINT follows 100 ms later.
async function spawnReview (
    r:ReviewRepo,
    env:Record<string, string>,
    ready:() => boolean,
    twice:boolean
):Promise<Spawned> {
    const requests = requestRecorder(r)
    const child = spawn(process.execPath, [
        path.join(ROOT, 'dist', 'cli.js'), 'review', '--no-verify',
        '--format', 'json',
    ], { cwd:r.dir, env, stdio:['ignore', 'pipe', 'pipe'] })
    const closed = new Promise<number|null>(resolve => {
        child.on('close', code => resolve(code))
    })
    const started = Date.now()
    while (!ready() && Date.now() - started < 20_000) {
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    child.kill('SIGINT')
    if (twice) {
        await new Promise(resolve => setTimeout(resolve, 100))
        child.kill('SIGINT')
    }
    return { code:await closed, sent:requests().length }
}

async function survivors (r:ReviewRepo):Promise<string[]> {
    // Give a child that is still exiting a moment to finish.
    await new Promise(resolve => setTimeout(resolve, 800))
    return execFileSync('ps', ['-A', '-o', 'command'])
        .toString().split('\n').filter(l => l.includes(r.dir))
}

test('the built CLI: one SIGINT during the finder exits 5', async t => {
    const pending = new Set<() => void>()
    t.cleanup(() => { for (const f of pending) f() })
    const r = await settingsRepo(t, hang(pending))
    const res = await spawnReview(r, r.env,
        () => r.server.requests.length > 0, false)
    t.equal(res.sent, 1, 'the finder request was in flight')
    t.equal(res.code, 5, 'exit 5')
    t.deepEqual(await survivors(r), [], 'no child process remains')
})

// A `git` that stalls on `diff` and takes 300 ms to exit on SIGTERM, so
// the review is still winding down when the second SIGINT arrives.
function slowGit (r:ReviewRepo):{ env:Record<string, string>, marker:string } {
    const bin = path.join(path.dirname(r.dir), 'slow-bin')
    fs.mkdirSync(bin)
    const marker = path.join(bin, 'stalled')
    const real = execFileSync('sh', ['-c', 'command -v git'], {
        env:r.env,
    }).toString().trim()
    fs.writeFileSync(path.join(bin, 'git'), [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  if [ "$a" = diff ]; then',
        '    sleep 10 & p=$!',
        '    trap \'sleep 0.3; kill $p; exit 1\' TERM',
        `    : > '${marker}'`,
        '    wait $p',
        '    exit 1',
        '  fi',
        'done',
        `exec '${real}' "$@"`,
        '',
    ].join('\n'), { mode:0o755 })
    return { env:{ ...r.env, PATH:`${bin}:${r.env.PATH}` }, marker }
}

test('the built CLI: a second SIGINT exits 130', async t => {
    const r = await settingsRepo(t)
    const { env, marker } = slowGit(r)
    const res = await spawnReview(r, env, () => fs.existsSync(marker), true)
    t.ok(fs.existsSync(marker), 'git was stalled')
    t.equal(res.code, 130, 'exit 130')
    t.equal(res.sent, 0, 'nothing sent')
    t.deepEqual(await survivors(r), [], 'no child process remains')
})
