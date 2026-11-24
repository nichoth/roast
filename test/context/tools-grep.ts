import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { LIVE_TREE } from '../../src/context/tree.js'
import { newRepo } from '../scope/helpers.js'
import {
    allTrees,
    call,
    fakeGit,
    onArg,
    stagedTree,
    waitDead,
    waitForPid,
} from './tools-helpers.js'

function matches (r:Record<string, unknown>):string[] {
    return Array.isArray(r.matches) ? r.matches as string[] : []
}

test('grep_repo finds a literal match on every tree', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package a\n\nfunc Needle() {}\n')
    repo.write('sub/b.go', 'package sub // Needle too\n')
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const r = await call(repo, tree, 'grep_repo', { pattern:'Needle' })
        t.equal(r.error, undefined, `${name}: no error`)
        t.deepEqual(matches(r).sort(), ['a.go:3:func Needle() {}',
            'sub/b.go:1:package sub // Needle too'],
        `${name}: path:line:text, not OID-prefixed`)
        t.equal(r.pattern, 'Needle', `${name}: pattern echoed`)
        t.equal(r.note, undefined, `${name}: no note on a match`)
        const glob = await call(repo, tree, 'grep_repo',
            { pattern:'Needle', path_glob:'sub/*' })
        t.deepEqual(matches(glob), ['sub/b.go:1:package sub // Needle too'],
            `${name}: path_glob restricts`)
    }
    repo.cleanup()
})

test('grep_repo: invalid patterns are errors', async t => {
    const repo = newRepo()
    for (const [name, tree] of await allTrees(repo)) {
        for (const p of ['(', '[a', '', 5]) {
            const r = await call(repo, tree, 'grep_repo', { pattern:p })
            t.ok(typeof r.error === 'string',
                `${name}: ${JSON.stringify(p)} is an error`)
        }
        // Valid for new RegExp, rejected by POSIX ERE.
        const r = await call(repo, tree, 'grep_repo',
            { pattern:'[[:nope:]]' })
        t.ok(typeof r.error === 'string', `${name}: git's failure`)
        t.equal(r.matches, undefined, `${name}: not a zero-match result`)
    }
    repo.cleanup()
})

test('a zero-match grep carries note and a per-tree searched', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package a\n')
    repo.commitAll()
    const searched = new Set<unknown>()
    for (const [name, tree] of await allTrees(repo)) {
        const r = await call(repo, tree, 'grep_repo', { pattern:'Absent' })
        t.equal(r.error, undefined, `${name}: no error`)
        t.deepEqual(r.matches, [], `${name}: empty matches`)
        t.ok(typeof r.note === 'string' && r.note !== '', `${name}: note`)
        t.ok(typeof r.searched === 'string', `${name}: searched`)
        searched.add(r.searched)
        const g = await call(repo, tree, 'grep_repo',
            { pattern:'Absent', path_glob:'*.go' })
        t.ok(g.searched !== r.searched, `${name}: searched names the glob`)
    }
    t.equal(searched.size, 3, 'searched differs per tree')
    repo.cleanup()
})

test('live grep sees untracked files and honors .gitignore', async t => {
    const repo = newRepo()
    repo.write('.gitignore', 'build/\n')
    repo.commitAll()
    repo.write('new.go', 'Needle untracked\n')
    repo.write('build/out.go', 'Needle ignored\n')
    repo.write('credentials.json', 'Needle denied\n')
    fs.symlinkSync('.git', path.join(repo.dir, 'gitlink'))
    repo.git('config', 'remote.origin.url', 'https://Needle@example.com')
    const r = await call(repo, LIVE_TREE, 'grep_repo', { pattern:'Needle' })
    t.deepEqual(matches(r), ['new.go:1:Needle untracked'],
        'only the untracked, non-ignored, non-denylisted file')
    repo.cleanup()
})

test('staged grep searches the index', async t => {
    const repo = newRepo()
    repo.write('a.go', 'COMMITTED\n')
    repo.commitAll()
    repo.write('a.go', 'STAGED\n')
    repo.git('add', 'a.go')
    repo.write('a.go', 'WORKTREE\n')
    repo.write('new.go', 'STAGED WORKTREE\n')
    const tree = await stagedTree(repo)
    const r = await call(repo, tree, 'grep_repo', { pattern:'STAGED' })
    t.deepEqual(matches(r), ['a.go:1:STAGED'], 'the index blob only')
    const w = await call(repo, tree, 'grep_repo', { pattern:'WORKTREE' })
    t.deepEqual(w.matches, [], 'no worktree content')
    repo.cleanup()
})

test('grep forces GIT_LITERAL_PATHSPECS=0', async t => {
    const repo = newRepo()
    repo.commitAll()
    repo.write('credentials.json', 'Needle denied\n')
    repo.write('new.go', 'Needle served\n')
    const env = { ...repo.env, GIT_LITERAL_PATHSPECS:'1' }
    const r = await call(repo, LIVE_TREE, 'grep_repo', { pattern:'Needle' },
        { env })
    t.deepEqual(matches(r), ['new.go:1:Needle served'],
        'denylisted untracked files stay excluded')

    const fake = fakeGit(repo, '[ "$1 $2 $3" = "-C ' + repo.dir +
        ' grep" ] && echo "$GIT_LITERAL_PATHSPECS" > "$PIDFILE.env"')
    const fakeEnv = { ...fake.env, GIT_LITERAL_PATHSPECS:'1' }
    for (const [name, tree] of await allTrees(repo)) {
        fs.rmSync(fake.pidFile + '.env', { force:true })
        await call(repo, tree, 'grep_repo', { pattern:'Needle' },
            { env:fakeEnv })
        t.equal(fs.readFileSync(fake.pidFile + '.env', 'utf8').trim(), '0',
            `${name}: the child's GIT_LITERAL_PATHSPECS is 0`)
    }
    fake.cleanup()
    repo.cleanup()
})

test('grep caps long lines and many matches', async t => {
    const repo = newRepo()
    repo.write('wide.txt', 'Needle ' + 'w'.repeat(100000) + '\n')
    let many = ''
    for (let i = 0; i < 300; i++) many += `Needle ${i}\n`
    repo.write('many.txt', many)
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const wide = await call(repo, tree, 'grep_repo',
            { pattern:'Needle', path_glob:'wide.txt' })
        const w = matches(wide)
        t.equal(w.length, 1, `${name}: one wide match`)
        t.ok(Buffer.byteLength(w[0]) < 2100, `${name}: the line is cut`)
        const r = await call(repo, tree, 'grep_repo',
            { pattern:'Needle', path_glob:'many.txt' })
        const m = matches(r)
        t.equal(m.length, 201, `${name}: 200 matches plus a marker`)
        t.ok(!m[200].startsWith('many.txt:'), `${name}: marker last`)
    }
    repo.cleanup()
})

test('aborting grep_repo kills the child', async t => {
    const repo = newRepo()
    const fake = fakeGit(repo, onArg('grep', 'sleep 30'))
    const ac = new AbortController()
    const p = call(repo, LIVE_TREE, 'grep_repo', { pattern:'x' },
        { env:fake.env, signal:ac.signal })
    const pid = await waitForPid(fake.pidFile)
    ac.abort()
    let err:unknown
    try {
        await p
    } catch (e) {
        err = e
    }
    t.ok(err instanceof Error && err.name === 'AbortError',
        'rejects with an AbortError')
    t.ok(await waitDead(pid), 'the child was killed')
    fake.cleanup()
    repo.cleanup()
})
