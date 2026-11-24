import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { LIVE_TREE } from '../../src/context/tree.js'
import { lines, newRepo } from '../scope/helpers.js'
import {
    allTrees,
    call,
    content,
    fakeGit,
    headTree,
    onArg,
    stagedTree,
    waitDead,
    waitForPid,
} from './tools-helpers.js'

const MAX_WINDOW = 2 ** 30

test('read_file windows, sets more_below, and handles past EOF', async t => {
    const repo = newRepo()
    repo.write('ten.txt', lines(10))
    repo.write('empty.txt', '')
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const read = (args:Record<string, unknown>) =>
            call(repo, tree, 'read_file', { path:'ten.txt', ...args })
        let r = await read({ offset:3, limit:2 })
        t.equal(r.error, undefined, `${name}: no error`)
        t.deepEqual(r.returned_range, [3, 4], `${name}: window`)
        t.equal(r.more_below, true, `${name}: more below`)
        t.equal(r.path, 'ten.txt', `${name}: path echoed`)
        t.ok(content(r).includes('line 2') &&
            !content(r).includes('line 1\n') &&
            !content(r).includes('line 4'), `${name}: the window's lines`)

        r = await read({ offset:9, limit:5 })
        t.deepEqual(r.returned_range, [9, 10], `${name}: tail window`)
        t.equal(r.more_below, false, `${name}: nothing below`)

        r = await read({})
        t.deepEqual(r.returned_range, [1, 10], `${name}: default window`)

        r = await read({ offset:20 })
        t.equal(r.error, undefined, `${name}: past EOF is not an error`)
        t.deepEqual(r.returned_range, [20, 10], `${name}: past EOF range`)
        t.equal(r.more_below, false, `${name}: past EOF, nothing below`)

        r = await call(repo, tree, 'read_file', { path:'empty.txt' })
        t.deepEqual(r.returned_range, [1, 0], `${name}: empty file`)

        r = await read({ offset:'3', limit:'2' })
        t.deepEqual(r.returned_range, [3, 4], `${name}: string coercion`)

        r = await read({ offset:true })
        t.ok(typeof r.error === 'string', `${name}: a bool offset errors`)

        r = await call(repo, tree, 'read_file', { path:'missing.txt' })
        t.ok(typeof r.error === 'string', `${name}: missing file errors`)
        r = await call(repo, tree, 'read_file', { path:7 })
        t.ok(typeof r.error === 'string', `${name}: non-string path errors`)
    }
    repo.cleanup()
})

test('read_file clamps huge windows and raises small ones', async t => {
    const repo = newRepo()
    repo.write('ten.txt', lines(10))
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        for (const v of [1e30, '99999999999999999999',
            JSON.parse('9007199254740993') as number]) {
            const r = await call(repo, tree, 'read_file',
                { path:'ten.txt', offset:v, limit:v })
            t.equal(r.error, undefined, `${name}: ${String(v)} no error`)
            t.deepEqual(r.returned_range, [MAX_WINDOW, 10],
                `${name}: ${String(v)} clamps to 2^30`)
        }
        const r = await call(repo, tree, 'read_file',
            { path:'ten.txt', offset:0, limit:-5 })
        t.deepEqual(r.returned_range, [1, 1], `${name}: 0 and -5 become 1`)
        t.equal(r.more_below, true, `${name}: one line, more below`)
    }
    repo.cleanup()
})

test('read_file: a cut long line does not swallow the next', async t => {
    const repo = newRepo()
    const long = 'x'.repeat(100000)
    repo.write('long.txt', `${long}\nNEXT LINE\nLAST LINE\n`)
    repo.write('noeol.txt', 'a\nb')
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        let r = await call(repo, tree, 'read_file', { path:'long.txt' })
        t.deepEqual(r.returned_range, [1, 3], `${name}: three lines`)
        t.ok(content(r).includes('NEXT LINE') &&
            content(r).includes('LAST LINE'), `${name}: next lines kept`)
        t.ok(Buffer.byteLength(content(r)) < 66000,
            `${name}: long lines are cut`)

        r = await call(repo, tree, 'read_file',
            { path:'long.txt', offset:2, limit:1 })
        t.deepEqual(r.returned_range, [2, 2], `${name}: line 2 alone`)
        t.ok(content(r).includes('NEXT LINE') &&
            !content(r).includes('xxxxxxxx'), `${name}: just line 2`)

        r = await call(repo, tree, 'read_file', { path:'noeol.txt' })
        t.deepEqual(r.returned_range, [1, 2],
            `${name}: a final line without a newline counts`)
    }
    repo.cleanup()
})

test('a staged read_file serves the index, not the worktree', async t => {
    const repo = newRepo()
    repo.write('a.go', 'COMMITTED\n')
    repo.write('gone.go', 'DOOMED\n')
    repo.commitAll()
    repo.write('a.go', 'STAGED\n')
    repo.git('add', 'a.go')
    repo.git('rm', '-q', 'gone.go')
    repo.write('a.go', 'WORKTREE\n')
    const tree = await stagedTree(repo)

    const r = await call(repo, tree, 'read_file', { path:'a.go' })
    t.ok(content(r).includes('STAGED'), 'serves the staged blob')
    t.ok(!content(r).includes('WORKTREE'), 'not the worktree')

    const staged = await call(repo, tree, 'read_file', { path:'gone.go' })
    t.ok(typeof staged.error === 'string', 'a staged deletion is absent')
    const captured = await call(repo, headTree(repo), 'read_file',
        { path:'nope.go' })
    t.ok(typeof captured.error === 'string', 'absent from a capture')
    const live = await call(repo, LIVE_TREE, 'read_file', { path:'nope.go' })
    t.ok(staged.error !== String(captured.error).replace('nope', 'gone') &&
        staged.error !== String(live.error).replace('nope', 'gone'),
    'the staged deletion is named differently from a plain absence')
    repo.cleanup()
})

test('read_file refuses non-canonical pinned paths', async t => {
    const repo = newRepo()
    repo.write('foo.go', 'package foo\n')
    repo.write('sub/x.go', 'package sub\n')
    repo.commitAll()
    const tree = await stagedTree(repo)
    for (const p of ['0:foo.go', '1:foo.go', '/foo.go', ':foo.go', '',
        './foo.go', '../foo.go', 'sub/../foo.go', 'sub//x.go', 'foo.go/.']) {
        const r = await call(repo, tree, 'read_file', { path:p })
        t.ok(typeof r.error === 'string', `refuses ${JSON.stringify(p)}`)
    }
    repo.cleanup()
})

test('read_file bounds a huge single-line blob', async t => {
    const repo = newRepo()
    repo.write('one.txt', 'y'.repeat(8 * 1024 * 1024) + '\nnext\n')
    repo.commitAll()
    for (const [name, tree] of await allTrees(repo)) {
        const r = await call(repo, tree, 'read_file',
            { path:'one.txt', limit:1 })
        t.deepEqual(r.returned_range, [1, 1], `${name}: one line`)
        t.equal(r.more_below, true, `${name}: more below`)
        t.ok(Buffer.byteLength(content(r)) < 33000, `${name}: bounded`)
    }
    repo.cleanup()
})

test('read_file kills an endless blob stream instead of draining it',
    async t => {
        const repo = newRepo()
        repo.write('big.txt', 'small\n')
        repo.commitAll()
        const tree = headTree(repo)
        const fake = fakeGit(repo, onArg('blob', 'yes'))
        const r = await call(repo, tree, 'read_file',
            { path:'big.txt', limit:2000 }, { env:fake.env })
        t.deepEqual(r.returned_range, [1, 2000], 'a full window')
        t.equal(r.more_below, true, 'more below')
        const pid = await waitForPid(fake.pidFile)
        t.ok(await waitDead(pid), 'the cat-file child was killed')
        fake.cleanup()
        repo.cleanup()
    })

test('aborting a streamed read_file kills the child', async t => {
    const repo = newRepo()
    repo.write('a.txt', 'a\n')
    repo.commitAll()
    const fake = fakeGit(repo, onArg('blob', 'sleep 30'))
    const ac = new AbortController()
    const p = call(repo, headTree(repo), 'read_file', { path:'a.txt' },
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

test('live read_file follows the corpus rules', async t => {
    const repo = newRepo()
    repo.write('.gitignore', 'build/\n')
    repo.commitAll()
    repo.write('build/out.go', 'SECRET\n')
    repo.write('credentials.json', 'SECRET\n')
    repo.write('new.go', 'UNTRACKED\n')
    fs.symlinkSync('.git', path.join(repo.dir, 'gitlink'))
    for (const p of ['.git/config', '.GIT/config', '.Git/HEAD',
        'gitlink/config', 'build/out.go', 'credentials.json']) {
        const r = await call(repo, LIVE_TREE, 'read_file', { path:p })
        t.ok(typeof r.error === 'string', `refuses ${p}`)
    }
    const r = await call(repo, LIVE_TREE, 'read_file', { path:'new.go' })
    t.ok(content(r).includes('UNTRACKED'), 'serves an untracked file')
    repo.cleanup()
})
