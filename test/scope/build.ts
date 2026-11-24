import { test } from '@substrate-system/tapzero'
import { build, isEmpty } from '../../src/scope/index.js'
import { newRepo, sectionPaths } from './helpers.js'

test('excludes filter both the diff text and files', async t => {
    const repo = newRepo()
    repo.write('keep.go', 'package p\n')
    repo.write('skip.go', 'package p\n')
    repo.commitAll()
    repo.write('keep.go', 'package p\n// changed\n')
    repo.write('skip.go', 'package p\n// changed\n')
    repo.git('add', '.')
    const s = await build(repo.dir, {
        stagedOnly:true,
        excludes:['skip.go'],
        env:repo.env,
    })
    t.deepEqual([...s.files], ['keep.go'], 'files')
    t.ok(!s.diff.includes('skip.go'), 'excluded file not in diff')
    t.deepEqual(sectionPaths(s.diff), ['keep.go'], 'diff sections')
    t.ok(s.staged, 'staged flag')
    t.equal(s.base, '', 'no base in staged mode')
    repo.cleanup()
})

test('untracked synthesis honors paths and excludes', async t => {
    const repo = newRepo()
    repo.write('include.go', 'package p\n')
    repo.write('exclude.go', 'package p\n')
    repo.write('node_modules/dep.js', '// lib\n')
    repo.write('other/x.go', 'package x\n')
    const s = await build(repo.dir, {
        excludes:['exclude.go'],
        env:repo.env,
    })
    t.deepEqual([...s.files], ['include.go', 'other/x.go'],
        'excludes and default ignores applied to untracked')
    t.ok(s.diff.includes('+package p\n'), 'synthesized content')
    const narrowed = await build(repo.dir, {
        paths:['other'],
        env:repo.env,
    })
    t.deepEqual([...narrowed.files], ['other/x.go'],
        'a bare directory path selects its subtree')
    repo.cleanup()
})

test('scope unset equals explicit diff', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package a\n')
    repo.commitAll()
    repo.write('a.go', 'package a\n// edit\n')
    repo.write('new.go', 'package n\n')
    const unset = await build(repo.dir, { env:repo.env })
    const explicit = await build(repo.dir, { scope:'diff', env:repo.env })
    t.equal(unset.diff, explicit.diff, 'same diff')
    t.deepEqual(unset.files, explicit.files, 'same files')
    t.deepEqual(unset.notes, explicit.notes, 'same notes')
    t.ok(unset.diffBytes.equals(explicit.diffBytes), 'same bytes')
    t.deepEqual([...unset.files], ['a.go', 'new.go'], 'files')
    t.ok(!isEmpty(unset), 'not empty')
    repo.cleanup()
})

test('an unknown scope is an error', async t => {
    const repo = newRepo()
    for (const scope of ['branch', 'bogus']) {
        let err:unknown
        try {
            await build(repo.dir, { scope, env:repo.env })
        } catch (e) {
            err = e
        }
        t.ok(err instanceof Error, `${scope} rejects`)
        t.ok((err as Error).message.includes(`"${scope}"`),
            'names the scope')
    }
    repo.cleanup()
})

test('a clean repository is empty', async t => {
    const repo = newRepo()
    const s = await build(repo.dir, { env:repo.env })
    t.ok(isEmpty(s), 'empty')
    t.deepEqual([...s.files], [], 'no files')
    repo.cleanup()
})
