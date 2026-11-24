// Loading, restoring, and pruning snapshots against real temporary Git
// repositories (spec 11, test plan items 1 and 9).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import {
    REF_PREFIX,
    capture,
    DEFAULT_REF_RETENTION_MS,
    headOid,
    load,
    prune,
    restore,
} from '../../src/snapshot/snapshot.js'
import { newRepo, type TestRepo } from '../scope/helpers.js'
import { fakeGit } from '../context/tools-helpers.js'

function repoFor (t:CleanupTest):TestRepo {
    const r = newRepo()
    t.cleanup(() => r.cleanup())
    return r
}

// The shared "messy repo" of spec 11's test plan: a clean committed
// file, a staged modification, an unstaged modification, an unstaged
// deletion, untracked files (plain, executable, symlink), an ignored
// secret, and an untracked deploy.pem.
function messyRepo (t:CleanupTest):TestRepo {
    const r = repoFor(t)
    r.write('clean.go', 'package clean\n')
    r.write('staged.go', 'package staged\n')
    r.write('unstaged.go', 'package unstaged\n')
    r.write('deleted.go', 'package deleted\n')
    r.write('.gitignore', 'secret.txt\n')
    r.commitAll('base')
    r.write('staged.go', 'package staged // staged edit\n')
    r.git('add', 'staged.go')
    r.write('unstaged.go', 'package unstaged // unstaged edit\n')
    fs.rmSync(path.join(r.dir, 'deleted.go'))
    r.write('untracked.go', 'package untracked\n')
    r.write('run.sh', '#!/bin/sh\necho hi\n')
    fs.chmodSync(path.join(r.dir, 'run.sh'), 0o755)
    fs.symlinkSync('clean.go', path.join(r.dir, 'link.go'))
    r.write('secret.txt', 'ignored secret\n')
    r.write('deploy.pem', '-----BEGIN KEY-----\n')
    return r
}

// A destination inside a fresh temp directory, plus cleanup that
// unregisters the worktree.
function destFor (t:CleanupTest, r:TestRepo):string {
    const parent = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'roast-restore-test-')))
    const dest = path.join(parent, 'out')
    t.cleanup(() => {
        try {
            r.git('worktree', 'remove', '--force', dest)
        } catch {
            // Never registered.
        }
        fs.rmSync(parent, { recursive:true, force:true })
    })
    return dest
}

function gitBytes (dir:string, env:NodeJS.ProcessEnv,
    ...args:string[]):Buffer {
    return execFileSync('git', ['-C', dir, ...args], { env })
}

function head (r:TestRepo):string {
    return r.git('rev-parse', 'HEAD').trim()
}

async function errorOf (fn:() => Promise<unknown>):Promise<Error|null> {
    try {
        await fn()
    } catch (err) {
        return err as Error
    }
    return null
}

test('load of a missing ref fails', async t => {
    const r = repoFor(t)
    const err = await errorOf(() => load(r.dir, 'nope', { env:r.env }))
    t.ok(err?.message.startsWith(`no snapshot ref ${REF_PREFIX}nope in `),
        'missing ref error')
})

test('load returns head and base from the parents', async t => {
    const r = repoFor(t)
    const base = head(r)
    r.write('b.go', 'package b\n')
    r.commitAll('second')
    const tip = head(r)
    r.write('b.go', 'package b // edit\n')
    r.write('deploy.pem', 'secret\n')
    const snap = await capture(r.dir, {
        runId:'run-1', headOid:tip, baseOid:base, env:r.env,
    })
    const got = await load(r.dir, 'run-1', { env:r.env })
    t.equal(got.ref, snap.ref, 'ref')
    t.equal(got.commit, snap.commit, 'commit')
    t.equal(got.indexTree, snap.indexTree, 'index tree')
    t.equal(got.worktreeTree, snap.worktreeTree, 'worktree tree')
    t.equal(got.head, tip, 'head is the first parent')
    t.equal(got.base, base, 'base is the second parent')
    t.deepEqual(got.excluded, [], 'excluded is not recoverable')

    await capture(r.dir, {
        runId:'run-2', headOid:tip, baseOid:'', env:r.env,
    })
    t.equal((await load(r.dir, 'run-2', { env:r.env })).base, '',
        'no second parent means no base')
})

// Git before 2.43 has no rev-parse --end-of-options and rejects it.
const OLD_REV_PARSE = 'case " $* " in\n' +
    '  *" rev-parse "*" --end-of-options "*) ' +
    'echo "fatal: bad revision" >&2; exit 128 ;;\n' +
    'esac'

test('capture and load work on Git without rev-parse --end-of-options',
    async t => {
        const r = repoFor(t)
        const fake = fakeGit(r, OLD_REV_PARSE)
        t.cleanup(() => fake.cleanup())
        const tip = await headOid(r.dir, { env:fake.env })
        t.equal(tip, head(r), 'HEAD resolved')
        const snap = await capture(r.dir, {
            runId:'run-1', headOid:tip, baseOid:'', env:fake.env,
        })
        const got = await load(r.dir, 'run-1', { env:fake.env })
        t.equal(got.commit, snap.commit, 'snapshot loaded')
        t.equal(got.head, tip, 'head parent resolved')
    })

test('restore reproduces the reviewed state', async t => {
    const r = messyRepo(t)
    await capture(r.dir, {
        runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
    })
    const dest = destFor(t, r)
    const snap = await restore(r.dir, 'run-1', dest, { env:r.env })
    t.equal(snap.head, head(r), 'restored identity')
    for (const args of [['diff', '--cached', 'HEAD'], ['diff', 'HEAD']]) {
        t.ok(gitBytes(dest, r.env, ...args)
            .equals(gitBytes(r.dir, r.env, ...args)),
        `${args.join(' ')} identical`)
    }
    const status = (dir:string):string[] => gitBytes(dir, r.env,
        'status', '--porcelain').toString().split('\n').filter(Boolean)
    t.deepEqual(status(dest),
        status(r.dir).filter(l => !l.endsWith('deploy.pem')),
        'status matches except the denylisted file')
    t.ok(status(r.dir).some(l => l.endsWith('deploy.pem')),
        'source shows deploy.pem')
    t.equal(fs.readFileSync(path.join(dest, 'untracked.go'), 'utf8'),
        'package untracked\n', 'untracked content')
    t.ok((fs.statSync(path.join(dest, 'run.sh')).mode & 0o111) !== 0,
        'exec bit survives')
    t.ok(fs.lstatSync(path.join(dest, 'link.go')).isSymbolicLink(),
        'symlink is a symlink')
    t.ok(!fs.existsSync(path.join(dest, 'deploy.pem')), 'no deploy.pem')
    t.ok(!fs.existsSync(path.join(dest, 'secret.txt')), 'no ignored file')
})

test('restore ignores an inherited GIT_INDEX_FILE', async t => {
    const r = messyRepo(t)
    await capture(r.dir, {
        runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
    })
    const dest = destFor(t, r)
    const bogus = path.join(r.dir, 'no-such-dir', 'index')
    await restore(r.dir, 'run-1', dest,
        { env:{ ...r.env, GIT_INDEX_FILE:bogus } })
    t.ok(!fs.existsSync(bogus), 'bogus index never written')
    const own = gitBytes(dest, r.env, 'rev-parse', '--path-format=absolute',
        '--git-path', 'index').toString().trim()
    t.ok(fs.existsSync(own), 'the worktree has its own index')
    const args = ['diff', '--cached', 'HEAD']
    t.ok(gitBytes(dest, r.env, ...args)
        .equals(gitBytes(r.dir, r.env, ...args)), 'own index is staged')
})

test('a failed restore leaves no registered worktree', async t => {
    const r = repoFor(t)
    const tip = head(r)
    // A hand-made snapshot whose worktree entry is a blob: worktree add
    // succeeds, then read-tree fails.
    const blob = r.git('rev-parse', 'HEAD:README.md').trim()
    const tree = r.git('rev-parse', 'HEAD^{tree}').trim()
    const composite = execFileSync('git', ['-C', r.dir, 'mktree'], {
        env:r.env,
        input:`040000 tree ${tree}\tindex\n100644 blob ${blob}\tworktree\n`,
    }).toString().trim()
    const commit = r.git('commit-tree', composite, '-p', tip, '-m', 'x')
        .trim()
    r.git('update-ref', REF_PREFIX + 'bad', commit)
    const dest = destFor(t, r)
    const err = await errorOf(
        () => restore(r.dir, 'bad', dest, { env:r.env }))
    t.ok(err?.message.startsWith('read-tree (worktree): '),
        'read-tree failure')
    const list = r.git('worktree', 'list', '--porcelain')
        .split('\n').filter(l => l.startsWith('worktree '))
    t.deepEqual(list, [`worktree ${r.dir}`], 'only the main worktree')
})

const DAY_MS = 24 * 3600 * 1000

// A snapshot ref whose commit is dated `days` ago, made like a capture
// but with the author and committer dates backdated.
function backdatedRef (r:TestRepo, runId:string, days:number):void {
    const snap = r.git('rev-parse', `${REF_PREFIX}fresh^{tree}`).trim()
    const secs = Math.floor((Date.now() - days * DAY_MS) / 1000)
    const date = `@${secs} +0000`
    const commit = execFileSync('git', ['-C', r.dir, 'commit-tree', snap,
        '-p', head(r), '-m', `roast run ${runId}`], {
        env:{ ...r.env, GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date },
    }).toString().trim()
    r.git('update-ref', REF_PREFIX + runId, commit)
}

function hasRef (r:TestRepo, ref:string):boolean {
    return r.git('for-each-ref', '--format=%(refname)', ref).trim() === ref
}

test('prune deletes only refs at least the threshold old', async t => {
    const r = repoFor(t)
    await capture(r.dir, {
        runId:'fresh', headOid:head(r), baseOid:'', env:r.env,
    })
    backdatedRef(r, 'old', 60)
    const old = REF_PREFIX + 'old'

    const dry = await prune(r.dir, 30 * DAY_MS, true, { env:r.env })
    t.equal(dry.length, 1, 'one ref selected')
    t.equal(dry[0]?.ref, old, 'the old ref')
    t.equal(dry[0]?.runId, 'old', 'run id')
    t.equal(dry[0]?.deleted, false, 'dry run deletes nothing')
    t.ok((dry[0]?.ageMs ?? 0) >= 60 * DAY_MS - 1000, 'age')
    t.ok(hasRef(r, old), 'old ref still exists')

    const real = await prune(r.dir, 30 * DAY_MS, false, { env:r.env })
    t.deepEqual(real.map(p => [p.ref, p.deleted]), [[old, true]],
        'old ref deleted')
    t.ok(!hasRef(r, old), 'old ref gone')
    t.equal((await load(r.dir, 'fresh', { env:r.env })).ref,
        REF_PREFIX + 'fresh', 'fresh snapshot still loads')
})

test('prune: exactly at the threshold is pruned; non-commits skipped',
    async t => {
        const r = repoFor(t)
        await capture(r.dir, {
            runId:'fresh', headOid:head(r), baseOid:'', env:r.env,
        })
        const blob = r.git('rev-parse', 'HEAD:README.md').trim()
        r.git('update-ref', REF_PREFIX + 'blob', blob)
        const commitSecs = Number(r.git('log', '-1', '--format=%ct',
            REF_PREFIX + 'fresh').trim())
        const now = commitSecs * 1000 + 5000
        const got = await prune(r.dir, 5000, true,
            { env:r.env, now:() => now })
        t.deepEqual(got.map(p => [p.runId, p.ageMs]), [['fresh', 5000]],
            'the ref at the threshold, not the blob')
        const under = await prune(r.dir, 5001, true,
            { env:r.env, now:() => now })
        t.deepEqual(under, [], 'one millisecond under is kept')
        // Age 5s under 30 days: kept once zero or negative means 30 days.
        const later = now - 10000 + DEFAULT_REF_RETENTION_MS
        for (const d of [0, -1]) {
            t.deepEqual(await prune(r.dir, d, true,
                { env:r.env, now:() => later }), [],
            `${d} falls back to 30 days`)
        }
    })
