import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { LIVE_TREE } from '../../src/context/tree.js'
import { newRepo } from '../scope/helpers.js'
import { allTrees, call } from './tools-helpers.js'

function matches (r:Record<string, unknown>):string[] {
    return Array.isArray(r.matches) ? r.matches as string[] : []
}

test('list_files skips hidden directories and files', async t => {
    const repo = newRepo()
    repo.write('a.go', 'a\n')
    repo.write('.hidden/b.go', 'b\n')
    repo.write('sub/.dot/c.go', 'c\n')
    repo.write('sub/.d.go', 'd\n')
    repo.write('sub/e.go', 'e\n')
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const r = await call(repo, tree, 'list_files', {})
        t.equal(r.error, undefined, `${name}: no error`)
        t.deepEqual(matches(r).filter(m => m.endsWith('.go')).sort(),
            ['a.go', 'sub/e.go'], `${name}: hidden entries skipped`)
        t.equal(r.directory, '.', `${name}: default directory`)
        t.equal(r.pattern, '*', `${name}: default pattern`)
        const sub = await call(repo, tree, 'list_files',
            { directory:'sub' })
        t.deepEqual(matches(sub), ['sub/e.go'], `${name}: a directory`)
    }
    repo.cleanup()
})

test('list_files: ** matches at every depth', async t => {
    const repo = newRepo()
    repo.write('root_test.go', 'x\n')
    repo.write('one/one_test.go', 'x\n')
    repo.write('one/two/two_test.go', 'x\n')
    repo.write('one/two/code.go', 'x\n')
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const r = await call(repo, tree, 'list_files',
            { pattern:'**/*_test.go' })
        t.deepEqual(matches(r).sort(), ['one/one_test.go',
            'one/two/two_test.go', 'root_test.go'], `${name}: globstar`)
        const base = await call(repo, tree, 'list_files',
            { pattern:'*.go' })
        t.ok(matches(base).includes('one/two/code.go'),
            `${name}: a slash-free pattern matches the basename`)
        const none = await call(repo, tree, 'list_files',
            { pattern:'*.nothing' })
        t.equal(none.matches, null, `${name}: no matches is null`)
        const long = await call(repo, tree, 'list_files',
            { pattern:'x'.repeat(257) })
        t.ok(typeof long.error === 'string', `${name}: a long pattern`)
    }
    repo.cleanup()
})

test('list_files caps at 500 entries with a marker', async t => {
    const repo = newRepo()
    for (let i = 0; i < 600; i++) {
        repo.write(`many/f${String(i).padStart(4, '0')}.txt`, '')
    }
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const r = await call(repo, tree, 'list_files', { directory:'many' })
        const m = matches(r)
        t.equal(m.length, 501, `${name}: 500 entries plus a marker`)
        t.ok(!m[500].startsWith('many/'), `${name}: the marker is last`)
    }
    repo.cleanup()
})

test('list_files refuses .git, ignored, and .git-link directories',
    async t => {
        const repo = newRepo()
        repo.write('.gitignore', 'build/\n')
        repo.commitAll()
        repo.write('build/out.go', 'x\n')
        repo.write('credentials.json', '{}\n')
        repo.write('new.go', 'x\n')
        fs.symlinkSync('.git', path.join(repo.dir, 'gitlink'))
        for (const d of ['.git', '.GIT', 'build', 'gitlink', '../x', '/']) {
            const r = await call(repo, LIVE_TREE, 'list_files',
                { directory:d })
            t.ok(typeof r.error === 'string', `refuses ${d}`)
        }
        const r = await call(repo, LIVE_TREE, 'list_files', {})
        t.ok(matches(r).includes('new.go'), 'lists untracked files')
        t.ok(!matches(r).includes('credentials.json'),
            'not untracked denylisted ones')
        t.ok(!matches(r).some(m => m.startsWith('build/')),
            'nor ignored ones')
        const missing = await call(repo, LIVE_TREE, 'list_files',
            { directory:'nope' })
        t.ok(typeof missing.error === 'string', 'a missing directory')
        repo.cleanup()
    })

test('pinned list_files refuses non-canonical directories', async t => {
    const repo = newRepo()
    repo.write('sub/a.go', 'x\n')
    repo.commitAll()
    const [, [, staged]] = await allTrees(repo)
    for (const d of ['sub/', './sub', '../sub', '/sub', ':sub', '0:sub']) {
        const r = await call(repo, staged, 'list_files', { directory:d })
        t.ok(typeof r.error === 'string', `refuses ${d}`)
    }
    repo.cleanup()
})
