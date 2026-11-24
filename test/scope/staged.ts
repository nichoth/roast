import { test } from '@substrate-system/tapzero'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { build, isEmpty } from '../../src/scope/index.js'
import { newRepo, tempDir } from './helpers.js'

test('staged mode reads only the index', async t => {
    const repo = newRepo()
    repo.write('file.go', 'package p\n// v1\n')
    repo.commitAll()
    repo.write('file.go', 'package p\n// v2\n')
    repo.git('add', '.')
    repo.write('file.go', 'package p\n// v3\n')
    repo.write('untracked.go', 'package u\n')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(s.diff.includes('+// v2'), 'staged content')
    t.ok(!s.diff.includes('v3'), 'no worktree-only edit')
    t.deepEqual([...s.files], ['file.go'], 'no untracked files')
    t.ok(s.staged, 'staged flag')
    t.equal(s.stagedTreeOID, '', 'no pinned tree')
    repo.cleanup()
})

test('staged mode honors an alternate GIT_INDEX_FILE', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package p\n// a-v1\n')
    repo.write('b.go', 'package p\n// b-v1\n')
    repo.commitAll()
    repo.write('a.go', 'package p\n// a-v2-staged-not-committed\n')
    repo.write('b.go', 'package p\n// b-v2-in-this-commit\n')
    repo.git('add', 'a.go')

    // What git hands a hook for `git commit b.go`.
    const dir = tempDir('roast-alt-index-')
    const altEnv = { ...repo.env, GIT_INDEX_FILE:path.join(dir, 'next') }
    const altGit = (...args:string[]) => execFileSync('git',
        ['-C', repo.dir, ...args], { env:altEnv })
    altGit('read-tree', 'HEAD')
    altGit('add', 'b.go')

    const s = await build(repo.dir, { stagedOnly:true, env:altEnv })
    t.deepEqual([...s.files], ['b.go'], 'only the alternate index')
    t.ok(s.diff.includes('b-v2-in-this-commit'), 'commit content')
    t.ok(!s.diff.includes('a-v2-staged-not-committed'),
        'shared index content does not leak')
    repo.cleanup()
})

test('staged mode with a pinned tree diffs against that tree', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package p\n')
    repo.commitAll()
    repo.write('a.go', 'package p\n// pinned\n')
    repo.git('add', '.')
    const tree = repo.git('write-tree').trim()
    repo.write('a.go', 'package p\n// later\n')
    repo.write('b.go', 'package b\n')
    repo.git('add', '.')
    const s = await build(repo.dir, {
        stagedOnly:true,
        stagedTreeOID:tree,
        env:repo.env,
    })
    t.ok(s.diff.includes('+// pinned'), 'pinned content')
    t.ok(!s.diff.includes('later'), 'later staging ignored')
    t.deepEqual([...s.files], ['a.go'], 'pinned files')
    t.equal(s.stagedTreeOID, tree, 'echoes the tree')
    repo.cleanup()
})

test('a repository with no commits diffs against the empty tree',
    async t => {
        const repo = newRepo({ commit:false })
        repo.write('staged.go', 'package p\n')
        repo.git('add', '.')
        repo.write('untracked.go', 'package u\n')
        const staged = await build(repo.dir, {
            stagedOnly:true,
            env:repo.env,
        })
        t.ok(!isEmpty(staged), 'staged review not empty')
        t.deepEqual([...staged.files], ['staged.go'], 'staged files')
        t.equal(staged.notes.length, 1, 'no-commits note')

        const all = await build(repo.dir, { env:repo.env })
        t.deepEqual([...all.files], ['staged.go', 'untracked.go'],
            'staged and untracked')
        t.equal(all.base, '', 'no base')
        t.ok(all.notes.some(n => n.includes('no commits')),
            'no-commits note')
        t.ok(!all.notes.some(n => n.includes('base')),
            'no base lookup happened')
        repo.cleanup()
    })

test('base fallback notes', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package p\n')
    repo.commitAll()
    repo.write('a.go', 'package p\n// changed\n')

    const onMain = await build(repo.dir, { env:repo.env })
    t.equal(onMain.base, 'main', 'falls back to main')
    t.ok(onMain.notes.some(n => n.includes('main')), 'using-base note')

    const missing = await build(repo.dir, {
        base:'nonexistent-ref-abc123',
        env:repo.env,
    })
    t.equal(missing.base, '', 'no base')
    t.ok(missing.notes.some(n => n.includes('nonexistent-ref-abc123')),
        'no-usable-base note names the requested ref')
    t.ok(!isEmpty(missing), 'uncommitted changes still reviewed')

    const explicit = await build(repo.dir, { base:'main', env:repo.env })
    t.deepEqual([...explicit.notes], [], 'no note for an explicit base')

    repo.cleanup()
})

test('no usable base when no candidate resolves', async t => {
    // One commit on a non-default branch: not even HEAD~1 resolves.
    const repo = newRepo({ commit:false })
    repo.write('a.go', 'package p\n')
    repo.commitAll()
    repo.git('branch', '-m', 'main', 'feature')
    repo.write('a.go', 'package p\n// changed\n')
    const none = await build(repo.dir, { env:repo.env })
    t.equal(none.base, '', 'no base resolves')
    t.ok(none.notes.some(n => n.includes('HEAD~1')),
        'note lists the candidates')
    t.deepEqual([...none.files], ['a.go'], 'uncommitted change')
    repo.cleanup()
})
