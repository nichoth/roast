import { test } from '@substrate-system/tapzero'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stagedContent } from '../../src/context/blob.js'
import { newQuoteGrounder } from '../../src/context/grounding.js'
import { resolveLive } from '../../src/context/paths.js'
import { numberedSnippet } from '../../src/context/snippet.js'
import {
    LIVE_TREE,
    pinIndexTree,
    pinnedWorktree,
    type Tree,
} from '../../src/context/tree.js'
import { denylistedUntracked } from '../../src/snapshot/denylist.js'
import { newRepo, tempDir, type TestRepo } from '../scope/helpers.js'

const SECRETS = ['FAKETOKEN', 'GITIGNORED_SECRET', 'DENYLISTED_SECRET',
    'repositoryformatversion']

const BLOCKED = ['.git/config', '.GIT/config', '.Git/HEAD',
    'gitlink/config', '.env', 'build/out.go', 'credentials.json',
    './.git/config', 'a/../.git/config']

const SERVED = ['a.go', 'new.go', 'id_test.go']

// A live working tree holding everything a pinned tree leaves out.
function liveFixture ():TestRepo {
    const repo = newRepo()
    repo.write('.gitignore', '.env\nbuild/\n')
    repo.write('a.go', 'package a\n\nfunc A() {}\n')
    repo.write('id_test.go', 'package a\n\nfunc TrackedDenylistShape() {}\n')
    repo.commitAll()
    repo.git('config', 'remote.origin.url',
        'https://user:FAKETOKEN@example.com/x/y')
    repo.write('.env', 'API_TOKEN=GITIGNORED_SECRET\n')
    repo.write('build/out.go', 'package build // GITIGNORED_SECRET\n')
    repo.write('credentials.json', '{"token":"DENYLISTED_SECRET"}\n')
    repo.write('new.go', 'package a\n\nfunc New() {}\n')
    fs.symlinkSync('.git', path.join(repo.dir, 'gitlink'))
    return repo
}

// The captured worktree, built with plumbing the way the snapshot area
// does: tracked plus untracked, non-ignored, non-denylisted files.
async function captureWorktree (repo:TestRepo):Promise<Tree> {
    const idx = path.join(tempDir('roast-ctx-cap-'), 'index')
    const env = { ...repo.env, GIT_INDEX_FILE:idx }
    const run = (...args:string[]) => execFileSync('git',
        ['-C', repo.dir, ...args], { env, encoding:'utf8' })
    run('read-tree', 'HEAD')
    const denied = await denylistedUntracked(repo.dir, { env:repo.env })
    const others = run('ls-files', '-z', '--others', '--exclude-standard')
        .split('\u0000')
        .filter(p => p !== '' && !denied.includes(p))
    if (others.length > 0) run('add', '--', ...others)
    return pinnedWorktree(run('write-tree').trim())
}

function leaks (s:string):string[] {
    return SECRETS.filter(secret => s.includes(secret))
}

test('the live tree serves only the review corpus', async t => {
    const repo = liveFixture()
    const opts = { env:repo.env }
    const g = newQuoteGrounder(repo.dir, LIVE_TREE, Buffer.alloc(0), opts)
    for (const p of BLOCKED) {
        t.equal(await resolveLive(repo.dir, p, opts), null,
            `resolveLive refuses ${p}`)
        const s = await numberedSnippet(repo.dir, p, 10000, LIVE_TREE, opts)
        t.deepEqual(leaks(s), [], `numberedSnippet(${p}) leaks nothing`)
        t.ok(!s.includes('```'), `numberedSnippet(${p}) shows no content`)
    }
    t.ok(!(await g('.git/config',
        'url = https://user:FAKETOKEN@example.com/x/y')),
    'a .git quote does not ground')
    t.ok(!(await g('.GIT/config', 'repositoryformatversion = 0')),
        'a case-folded .git quote does not ground')
    t.ok(!(await g('gitlink/config', 'repositoryformatversion = 0')),
        'a .git symlink quote does not ground')
    t.ok(!(await g('.env', 'API_TOKEN=GITIGNORED_SECRET')),
        'an ignored file does not ground')
    t.ok(!(await g('build/out.go', 'package build // GITIGNORED_SECRET')),
        'an ignored directory does not ground')
    t.ok(!(await g('credentials.json', '"token":"DENYLISTED_SECRET"')),
        'an untracked denylisted file does not ground')
    for (const p of SERVED) {
        t.ok(await resolveLive(repo.dir, p, opts) !== null,
            `resolveLive serves ${p}`)
        const s = await numberedSnippet(repo.dir, p, 10000, LIVE_TREE, opts)
        t.ok(s.includes('```'), `numberedSnippet(${p}) shows content`)
    }
    t.ok(await g('new.go', 'func New() {}'), 'untracked non-ignored grounds')
    t.ok(await g('id_test.go', 'func TrackedDenylistShape() {}'),
        'a tracked denylist-shaped file grounds')
    repo.cleanup()
})

test('what the live guard blocks is what pinning leaves out', async t => {
    const repo = liveFixture()
    const opts = { env:repo.env }
    const tree = await captureWorktree(repo)
    const candidates = [...BLOCKED, ...SERVED, '.gitignore']
    for (const p of candidates) {
        const live = await resolveLive(repo.dir, p, opts) !== null
        const blob = await stagedContent(repo.dir, tree, p, opts)
        t.equal(blob !== null, live,
            `${p}: pinned ${blob !== null}, live ${live}`)
    }
    repo.cleanup()
})

test('pinned reads reject revision magic', async t => {
    const repo = newRepo()
    repo.write('foo.go', 'package p\nvar Real = 1\n')
    repo.commitAll()
    const opts = { env:repo.env }
    const tree = await pinIndexTree(repo.dir, new AbortController().signal,
        opts)
    const g = newQuoteGrounder(repo.dir, tree, Buffer.alloc(0), opts)
    for (const bad of ['0:foo.go', '1:foo.go', '/foo.go', ':foo.go', '',
        './foo.go', '../foo.go', 'sub/../foo.go', 'sub//foo.go',
        'foo.go/.']) {
        t.equal(await stagedContent(repo.dir, tree, bad, opts), null,
            `stagedContent(${JSON.stringify(bad)}) is absent`)
        const s = await numberedSnippet(repo.dir, bad, 1000, tree, opts)
        t.ok(!s.includes('var Real'), `snippet(${JSON.stringify(bad)})`)
        t.ok(!(await g(bad, 'var Real = 1')),
            `grounder(${JSON.stringify(bad)}) does not ground`)
    }
    t.ok(await stagedContent(repo.dir, tree, 'foo.go', opts) !== null,
        'the canonical path is served')
    t.ok(await g('foo.go', 'var Real = 1'), 'the canonical path grounds')
    repo.cleanup()
})
