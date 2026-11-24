// The snapshot module against real temporary Git repositories (spec 11,
// test plan items 1-3, 5-8, 10-12).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import {
    REF_PREFIX,
    capture,
    deleteSnapshot,
    headOid,
    pinWorktree,
    revOid,
    treeOid,
} from '../../src/snapshot/snapshot.js'
import { newRepo, type TestRepo } from '../scope/helpers.js'

function repoFor (t:CleanupTest, opts:{ commit?:boolean } = {}):TestRepo {
    const r = newRepo(opts)
    t.cleanup(() => r.cleanup())
    return r
}

function head (r:TestRepo):string {
    return r.git('rev-parse', 'HEAD').trim()
}

// The shared "messy repo": a clean committed file, a staged modification,
// an unstaged modification, an unstaged deletion, untracked files (plain,
// executable, symlink), an ignored secret, and an untracked deploy.pem.
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

function indexBytes (r:TestRepo):Buffer {
    return fs.readFileSync(path.join(r.dir, '.git', 'index'))
}

// Paths in a tree, recursively.
function treePaths (r:TestRepo, tree:string):string[] {
    return r.git('ls-tree', '-r', '--name-only', '-z', tree)
        .split('\0').filter(Boolean)
}

test('capture leaves the source status and live index unchanged',
    async t => {
        const r = messyRepo(t)
        const status = r.git('status', '--porcelain')
        const index = indexBytes(r)
        const snap = await capture(r.dir, {
            runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
        })
        t.equal(snap.ref, REF_PREFIX + 'run-1', 'ref name')
        t.equal(r.git('rev-parse', snap.ref).trim(), snap.commit,
            'ref points at the commit')
        t.ok(indexBytes(r).equals(index), 'live index byte-identical')
        t.equal(r.git('status', '--porcelain'), status, 'status unchanged')
    })

test('the worktree tree omits ignored and denylisted untracked files',
    async t => {
        const r = messyRepo(t)
        const snap = await capture(r.dir, {
            runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
        })
        const paths = treePaths(r, snap.worktreeTree)
        t.ok(paths.includes('untracked.go'), 'untracked file captured')
        t.ok(!paths.includes('secret.txt'), 'ignored secret omitted')
        t.ok(!paths.includes('deploy.pem'), 'deploy.pem omitted')
        t.ok(!paths.includes('deleted.go'), 'deletion captured')
        t.deepEqual(snap.excluded, ['deploy.pem'], 'excluded list')
        t.ok(fs.existsSync(path.join(r.dir, 'deploy.pem')),
            'deploy.pem stays on disk')
        const mode = r.git('ls-tree', snap.worktreeTree, 'run.sh')
        t.ok(mode.startsWith('100755'), 'exec bit kept')
        const link = r.git('ls-tree', snap.worktreeTree, 'link.go')
        t.ok(link.startsWith('120000'), 'symlink kept')
        const idx = treePaths(r, snap.indexTree)
        t.ok(idx.includes('deleted.go'), 'index tree keeps deleted.go')
        t.ok(!idx.includes('untracked.go'), 'index tree has no untracked')
    })

test('an untracked file literally named *.key is excluded literally',
    async t => {
        const r = repoFor(t)
        // A tracked .key file is not denylisted; a glob exclude would
        // still skip its edit.
        r.write('tracked.key', 'old\n')
        r.commitAll('tracked key')
        r.write('tracked.key', 'new\n')
        r.write('*.key', 'secret\n')
        r.write('keep.go', 'package keep\n')
        const pin = await pinWorktree(r.dir, { env:r.env })
        const paths = treePaths(r, pin.tree)
        t.ok(paths.includes('keep.go'), 'keep.go captured')
        t.ok(!paths.includes('*.key'), '*.key excluded')
        t.deepEqual(pin.excluded, ['*.key'], 'excluded list')
        t.equal(r.git('show', `${pin.tree}:tracked.key`), 'new\n',
            'tracked edit captured')
    })

test('denylisted untracked names that are not valid UTF-8 are excluded',
    async t => {
        const r = repoFor(t)
        const name = (s:string):Buffer => Buffer.concat([
            Buffer.from(r.dir + '/'), Buffer.from([0xff]), Buffer.from(s)])
        try {
            fs.writeFileSync(name('.pem'), 'secret key\n')
            fs.mkdirSync(name('dir'))
            fs.writeFileSync(Buffer.concat([name('dir'),
                Buffer.from('/.env')]), 'TOKEN=1\n')
        } catch {
            // Some file systems (APFS) refuse such names; Linux runs it.
            t.ok(true, 'skipped: file system refuses non-UTF-8 names')
            return
        }
        r.write('keep.go', 'package keep\n')
        const snap = await capture(r.dir, {
            runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
        })
        const listed = execFileSync('git', ['-C', r.dir, 'ls-tree', '-r',
            '--name-only', '-z', snap.worktreeTree], { env:r.env })
        const names = listed.toString('latin1').split('\0')
            .filter(Boolean)
        t.deepEqual(names, ['keep.go'], 'only keep.go captured')
        t.equal(snap.excluded.length, 2, 'both secrets reported')
        t.ok(snap.excluded.every(p => p.startsWith('�')),
            'reported with a replacement character')
    })

function refs (r:TestRepo):string {
    return r.git('for-each-ref', '--format=%(refname)', REF_PREFIX).trim()
}

// A live index with an unmerged entry for conflict.txt.
function unmergedRepo (t:CleanupTest):TestRepo {
    const r = repoFor(t)
    r.write('conflict.txt', 'base\n')
    r.commitAll('base')
    r.git('checkout', '-q', '-b', 'other')
    r.write('conflict.txt', 'other\n')
    r.commitAll('other')
    r.git('checkout', '-q', 'main')
    r.write('conflict.txt', 'main\n')
    r.commitAll('main')
    try {
        r.git('merge', '-q', 'other')
    } catch {
        // The conflict is the point.
    }
    t.ok(r.git('ls-files', '-u').trim() !== '', 'index is unmerged')
    return r
}

test('capture fails on an unmerged index and writes no ref', async t => {
    const r = unmergedRepo(t)
    let err:Error|null = null
    try {
        await capture(r.dir, {
            runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
        })
    } catch (e) {
        err = e as Error
    }
    t.ok(err?.message.startsWith('write-tree (index): '), 'index error')
    t.equal(refs(r), '', 'no ref')
})

test('capture refuses an unborn HEAD and writes no ref', async t => {
    const r = repoFor(t, { commit:false })
    r.write('a.go', 'package a\n')
    t.equal(await headOid(r.dir, { env:r.env }), '', 'no HEAD')
    let err:Error|null = null
    try {
        await capture(r.dir, {
            runId:'run-1', headOid:'', baseOid:'', env:r.env,
        })
    } catch (e) {
        err = e as Error
    }
    t.ok(err?.message.includes('unborn HEAD'), 'unborn error')
    t.equal(refs(r), '', 'no ref')
})

test('capture parents: HEAD first, base second only when it differs',
    async t => {
        const r = repoFor(t)
        const base = head(r)
        r.write('b.go', 'package b\n')
        r.commitAll('second')
        const tip = head(r)
        r.write('b.go', 'package b // edit\n')
        const two = await capture(r.dir, {
            runId:'two', headOid:tip, baseOid:base, env:r.env,
        })
        t.equal(r.git('rev-list', '--parents', '-n1', two.commit).trim(),
            `${two.commit} ${tip} ${base}`, 'HEAD then base')
        t.equal(two.base, base, 'base recorded')
        const one = await capture(r.dir, {
            runId:'one', headOid:tip, baseOid:tip, env:r.env,
        })
        t.equal(r.git('rev-list', '--parents', '-n1', one.commit).trim(),
            `${one.commit} ${tip}`, 'same base adds no parent')
        t.equal(r.git('log', '-1', '--format=%s', one.commit).trim(),
            'roast run one', 'commit message')
        t.equal(await revOid(r.dir, 'refs/roast/snapshots/one',
            { env:r.env }), one.commit, 'revOid resolves the ref')
        t.equal(await treeOid(r.dir, 'HEAD', { env:r.env }),
            r.git('rev-parse', 'HEAD^{tree}').trim(), 'treeOid')
    })

test('snapshot objects survive git gc --prune=now', async t => {
    const r = messyRepo(t)
    const snap = await capture(r.dir, {
        runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
    })
    r.git('gc', '-q', '--prune=now')
    for (const oid of [snap.commit, snap.indexTree, snap.worktreeTree]) {
        t.ok(r.git('cat-file', '-t', oid).trim() !== '', `kept ${oid}`)
    }
    t.ok(r.git('cat-file', '-p', `${snap.worktreeTree}:untracked.go`)
        .includes('untracked'), 'untracked blob kept')
})

test('capture honors GIT_INDEX_FILE as the live index', async t => {
    const r = repoFor(t)
    r.write('a.txt', 'a\n')
    r.write('b.txt', 'b\n')
    r.git('add', 'a.txt')
    const alt = path.join(r.dir, '.git', 'alt-index')
    execFileSync('git', ['-C', r.dir, 'read-tree', 'HEAD'],
        { env:{ ...r.env, GIT_INDEX_FILE:alt } })
    execFileSync('git', ['-C', r.dir, 'add', 'b.txt'],
        { env:{ ...r.env, GIT_INDEX_FILE:alt } })
    // Relative to the toplevel.
    const env = { ...r.env, GIT_INDEX_FILE:'.git/alt-index' }
    const snap = await capture(r.dir, {
        runId:'run-1', headOid:head(r), baseOid:'', env,
    })
    const paths = treePaths(r, snap.indexTree)
    t.ok(paths.includes('b.txt'), 'alternate index staged b.txt')
    t.ok(!paths.includes('a.txt'), 'live .git/index not used')
})

test('a pin and a capture given that pin record the same tree',
    async t => {
        const r = messyRepo(t)
        const pin = await pinWorktree(r.dir, { env:r.env })
        // Edits after the pin must not reach the capture.
        r.write('untracked.go', 'package untracked // later\n')
        const snap = await capture(r.dir, {
            runId:'run-1',
            headOid:head(r),
            baseOid:'',
            worktree:pin,
            env:r.env,
        })
        t.equal(snap.worktreeTree, pin.tree, 'same worktree tree')
        t.deepEqual(snap.excluded, pin.excluded, 'same excluded list')
        const own = await capture(r.dir, {
            runId:'run-2', headOid:head(r), baseOid:'', env:r.env,
        })
        t.ok(own.worktreeTree !== pin.tree, 'an unpinned capture reads now')
    })

test('pinWorktree works without HEAD', async t => {
    const r = repoFor(t, { commit:false })
    r.write('a.go', 'package a\n')
    const pin = await pinWorktree(r.dir, { env:r.env })
    t.deepEqual(treePaths(r, pin.tree), ['a.go'], 'worktree pinned')
    t.equal(refs(r), '', 'no ref')
})

test('pinWorktree resolves an unmerged index in a private copy',
    async t => {
        const r = unmergedRepo(t)
        const index = indexBytes(r)
        const pin = await pinWorktree(r.dir, { env:r.env })
        t.ok(r.git('show', `${pin.tree}:conflict.txt`).includes('<<<<<<<'),
            'conflicted file pinned as on disk')
        t.ok(indexBytes(r).equals(index), 'live index untouched')
        t.ok(r.git('ls-files', '-u').trim() !== '', 'still unmerged')
    })

test('capture uses roast identity without user.email', async t => {
    const r = repoFor(t)
    r.write('a.go', 'package a\n')
    const env = { ...r.env }
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[k]
    // No user.email anywhere, and no guessing from the host name.
    fs.writeFileSync(r.globalConfig, '[user]\n\tuseConfigOnly = true\n')
    const snap = await capture(r.dir, {
        runId:'run-1', headOid:head(r), baseOid:'', env,
    })
    t.equal(r.git('log', '-1', '--format=%an <%ae>|%cn <%ce>', snap.commit)
        .trim(), 'roast <roast@localhost>|roast <roast@localhost>',
    'author and committer')
})

test('deleteSnapshot removes the ref', async t => {
    const r = repoFor(t)
    await capture(r.dir, {
        runId:'run-1', headOid:head(r), baseOid:'', env:r.env,
    })
    t.ok(refs(r) !== '', 'ref written')
    await deleteSnapshot(r.dir, 'run-1', { env:r.env })
    t.equal(refs(r), '', 'ref deleted')
})
