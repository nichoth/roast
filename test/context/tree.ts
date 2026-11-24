import { test } from '@substrate-system/tapzero'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { newQuoteGrounder } from '../../src/context/grounding.js'
import { numberedSnippet } from '../../src/context/snippet.js'
import {
    LIVE_TREE,
    pinIndexTree,
    pinned,
    pinnedWorktree,
    staged,
} from '../../src/context/tree.js'
import { newRepo, tempDir } from '../scope/helpers.js'

const signal = new AbortController().signal

test('tree predicates', t => {
    t.ok(!pinned(LIVE_TREE) && !staged(LIVE_TREE), 'live tree')
    const wt = pinnedWorktree('abc')
    t.ok(pinned(wt) && !staged(wt) && wt.worktree, 'captured worktree')
    t.ok(!pinned(pinnedWorktree('')), 'an empty oid is the live tree')
    t.ok(staged({ oid:'abc', worktree:false }), 'index tree')
})

test('pinIndexTree pins the index without changing it', async t => {
    const repo = newRepo()
    repo.write('f.go', 'package p\n// committed\n')
    repo.commitAll()
    repo.write('f.go', 'package p\nvar stagedOnlySymbol = 1\n')
    repo.git('add', 'f.go')
    repo.write('f.go', 'package p\nvar unstagedOnlySymbol = 2\n')
    const indexFile = path.join(repo.dir, '.git', 'index')
    const status = repo.git('status', '--porcelain')
    const before = fs.readFileSync(indexFile)

    const tree = await pinIndexTree(repo.dir, signal, { env:repo.env })
    t.ok(staged(tree), 'an index tree')
    t.ok(fs.readFileSync(indexFile).equals(before), 'the index is unchanged')
    t.equal(repo.git('status', '--porcelain'), status, 'status unchanged')
    t.equal(tree.oid, repo.git('write-tree').trim(),
        'the oid is the index tree')

    const opts = { env:repo.env }
    const snippet = await numberedSnippet(repo.dir, 'f.go', 120000, tree,
        opts)
    t.ok(snippet.includes('stagedOnlySymbol'), 'staged snippet serves index')
    t.ok(!snippet.includes('unstagedOnlySymbol'),
        'staged snippet does not serve the worktree')

    const g = newQuoteGrounder(repo.dir, tree, Buffer.alloc(0), opts)
    t.ok(await g('f.go', 'var stagedOnlySymbol = 1'),
        'staged content grounds')
    t.ok(!(await g('f.go', 'var unstagedOnlySymbol = 2')),
        'unstaged content does not ground')
    const live = newQuoteGrounder(repo.dir, LIVE_TREE, Buffer.alloc(0), opts)
    t.ok(await live('f.go', 'var unstagedOnlySymbol = 2'),
        'the live grounder reads the worktree')

    const deleted = await numberedSnippet(repo.dir, 'gone.go', 1000, tree,
        opts)
    t.ok(!deleted.includes('```'), 'an absent index path has no content')
    repo.cleanup()
})

test('staged grounder admits the staged diff', async t => {
    const repo = newRepo()
    const tree = await pinIndexTree(repo.dir, signal, { env:repo.env })
    const diff = Buffer.from('diff --git a/f.go b/f.go\n--- a/f.go\n' +
        '+++ b/f.go\n@@ -1,2 +1,2 @@\n-removedSymbol := 1\n' +
        '+addedSymbol := 2\n')
    const g = newQuoteGrounder(repo.dir, tree, diff, { env:repo.env })
    t.ok(await g('f.go', 'removedSymbol := 1'), 'deleted code grounds')
    repo.cleanup()
})

test('readers agree on the GIT_INDEX_FILE index', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package p\n// a-committed\n')
    repo.write('b.go', 'package p\n// b-committed\n')
    repo.commitAll()
    repo.write('a.go', 'package p\nvar liveIndexSymbol = 1\n')
    repo.git('add', 'a.go')

    const alt = path.join(tempDir('roast-ctx-idx-'), 'next-index')
    const env = { ...repo.env, GIT_INDEX_FILE:alt }
    const altGit = (...args:string[]) => execGit(repo.dir, env, args)
    altGit('read-tree', 'HEAD')
    repo.write('b.go', 'package p\nvar commitIndexSymbol = 1\n')
    altGit('add', 'b.go')
    repo.write('b.go', 'package p\nvar worktreeSymbol = 1\n')

    const tree = await pinIndexTree(repo.dir, signal, { env })
    const opts = { env }
    const snippet = await numberedSnippet(repo.dir, 'b.go', 120000, tree,
        opts)
    t.ok(snippet.includes('commitIndexSymbol'), 'snippet sees the index')
    t.ok(!snippet.includes('worktreeSymbol'), 'not the worktree')
    const aSnippet = await numberedSnippet(repo.dir, 'a.go', 120000, tree,
        opts)
    t.ok(!aSnippet.includes('liveIndexSymbol'), 'not the live index')

    const g = newQuoteGrounder(repo.dir, tree, Buffer.alloc(0), opts)
    t.ok(await g('b.go', 'var commitIndexSymbol = 1'), 'grounder agrees')
    t.ok(!(await g('b.go', 'var worktreeSymbol = 1')),
        'worktree does not ground')
    t.ok(!(await g('a.go', 'var liveIndexSymbol = 1')),
        'live index does not ground')
    repo.cleanup()
})

test('index writes after pinning are invisible', async t => {
    const repo = newRepo()
    repo.write('f.go', 'package p\n// committed\n')
    repo.commitAll()
    repo.write('f.go', 'package p\nvar pinnedSymbol = 1\n')
    repo.git('add', 'f.go')
    const tree = await pinIndexTree(repo.dir, signal, { env:repo.env })
    repo.write('new.go', 'package p\nvar concurrentlyAddedSymbol = 1\n')
    repo.git('add', 'new.go')
    repo.write('f.go', 'package p\nvar driftedSymbol = 1\n')
    repo.git('add', 'f.go')

    const opts = { env:repo.env }
    const snippet = await numberedSnippet(repo.dir, 'f.go', 120000, tree,
        opts)
    t.ok(snippet.includes('pinnedSymbol') &&
        !snippet.includes('driftedSymbol'), 'snippet stays on the pin')
    const added = await numberedSnippet(repo.dir, 'new.go', 120000, tree,
        opts)
    t.ok(!added.includes('concurrentlyAddedSymbol'),
        'a file staged later is absent')
    const g = newQuoteGrounder(repo.dir, tree, Buffer.alloc(0), opts)
    t.ok(await g('f.go', 'var pinnedSymbol = 1'), 'pinned content grounds')
    t.ok(!(await g('f.go', 'var driftedSymbol = 1')),
        'later content does not')
    t.ok(!(await g('new.go', 'var concurrentlyAddedSymbol = 1')),
        'a later file does not')
    repo.cleanup()
})

test('captured-worktree readers ignore later checkout edits', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package p\nvar committedSymbol = 1\n')
    repo.commitAll()
    repo.write('a.go', 'package p\nvar capturedSymbol = 1\n')
    repo.write('new.go', 'package p\nvar capturedUntrackedSymbol = 1\n')
    // Capture through a temporary index, leaving the real one alone.
    const idx = path.join(tempDir('roast-ctx-cap-'), 'index')
    const env = { ...repo.env, GIT_INDEX_FILE:idx }
    execGit(repo.dir, env, ['read-tree', 'HEAD'])
    execGit(repo.dir, env, ['add', '-A'])
    const tree = pinnedWorktree(
        execGit(repo.dir, env, ['write-tree']).trim())

    repo.write('a.go', 'package p\nvar driftedSymbol = 1\n')
    repo.write('new.go', 'package p\nvar driftedUntrackedSymbol = 1\n')

    const opts = { env:repo.env }
    const snippet = await numberedSnippet(repo.dir, 'a.go', 120000, tree,
        opts)
    t.ok(snippet.includes('capturedSymbol') &&
        !snippet.includes('driftedSymbol'), 'snippet reads the capture')
    const g = newQuoteGrounder(repo.dir, tree, Buffer.alloc(0), opts)
    t.ok(await g('a.go', 'var capturedSymbol = 1'), 'captured grounds')
    t.ok(!(await g('a.go', 'var driftedSymbol = 1')), 'drift does not')
    t.ok(await g('new.go', 'var capturedUntrackedSymbol = 1'),
        'captured untracked file grounds')
    repo.cleanup()
})

function execGit (dir:string, env:NodeJS.ProcessEnv, args:string[]):string {
    return execFileSync('git', ['-C', dir, ...args],
        { env, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'] })
}
