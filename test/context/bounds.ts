import { test } from '@substrate-system/tapzero'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
    GROUNDING_CACHE_BYTES,
    newQuoteGrounder,
} from '../../src/context/grounding.js'
import { LineReader } from '../../src/context/lines.js'
import { numberedSnippet } from '../../src/context/snippet.js'
import { LIVE_TREE, pinnedWorktree } from '../../src/context/tree.js'
import { newRepo, tempDir, type TestRepo } from '../scope/helpers.js'

test('a quote at the end of a file over 8 MiB grounds', async t => {
    const repo = newRepo()
    const filler = 'filler words here\n'
    const body = filler.repeat(Math.ceil(GROUNDING_CACHE_BYTES * 2 /
        filler.length)) + 'func deepNeedle() {}\n'
    repo.write('huge.txt', body)
    repo.commitAll()
    const tree = pinnedWorktree(repo.git('rev-parse', 'HEAD^{tree}').trim())
    for (const tr of [LIVE_TREE, tree]) {
        const g = newQuoteGrounder(repo.dir, tr, Buffer.alloc(0),
            { env:repo.env })
        t.ok(await g('huge.txt', 'func   deepNeedle()\n{}'),
            `pinned=${tr.oid !== ''}: the tail quote grounds`)
        t.ok(!(await g('huge.txt', 'func absentNeedle() {}')),
            `pinned=${tr.oid !== ''}: an absent quote does not`)
        t.ok(await g('huge.txt', 'here filler words'),
            `pinned=${tr.oid !== ''}: a second call re-streams`)
    }
    repo.cleanup()
})

test('a 1M-line diff grounds', async t => {
    const repo = newRepo()
    const head = 'diff --git a/data.txt b/data.txt\nnew file mode 100644\n' +
        '--- /dev/null\n+++ b/data.txt\n@@ -0,0 +1,1000000 @@\n'
    const diff = Buffer.concat([Buffer.from(head),
        Buffer.from('+a b c d e f g h\n'.repeat(1000000)),
        Buffer.from('+tail marker\n')])
    const g = newQuoteGrounder(repo.dir, LIVE_TREE, diff, { env:repo.env })
    t.ok(await g('data.txt', 'h a b c'), 'content across lines grounds')
    t.ok(await g('data.txt', 'h tail marker'), 'the last line grounds')
    t.ok(!(await g('data.txt', 'h h')), 'absent content does not')
    repo.cleanup()
})

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'],
    { encoding:'utf8' }).trim()

// A `git` first on PATH that records its pid and runs `action` when any
// argument equals `trigger`, and the real git otherwise.
function wrapGit (repo:TestRepo, trigger:string, action:string) {
    const dir = tempDir('roast-ctx-wrapgit-')
    const pidFile = path.join(dir, 'pid')
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\n' +
        'for a in "$@"; do\n' +
        `  if [ "$a" = "${trigger}" ]; then\n` +
        `    echo $$ > "${pidFile}"\n` +
        `    exec ${action}\n` +
        '  fi\n' +
        'done\n' +
        `exec "${REAL_GIT}" "$@"\n`, { mode:0o755 })
    return { env:{ ...repo.env, PATH:`${dir}:${repo.env.PATH}` }, pidFile, dir }
}

function alive (pid:number):boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function waitForPid (file:string):Promise<number> {
    for (let i = 0; i < 500; i++) {
        if (fs.existsSync(file)) {
            const pid = Number(fs.readFileSync(file, 'utf8').trim())
            if (pid > 0) return pid
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${file}`)
}

async function rejection (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

async function waitDead (pid:number):Promise<boolean> {
    for (let i = 0; i < 300 && alive(pid); i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    return !alive(pid)
}

test('abort kills a blocking cat-file -s', async t => {
    const repo = newRepo()
    const tree = pinnedWorktree(repo.git('rev-parse', 'HEAD^{tree}').trim())
    const w = wrapGit(repo, '-s', 'sleep 30')
    const ac = new AbortController()
    const g = newQuoteGrounder(repo.dir, tree, Buffer.alloc(0),
        { env:w.env, signal:ac.signal })
    const p = g('README.md', 'hello')
    const pid = await waitForPid(w.pidFile)
    ac.abort()
    const err = await rejection(p)
    t.ok(err instanceof Error && err.name === 'AbortError',
        'rejects with an AbortError')
    t.ok(await waitDead(pid), 'cat-file -s was killed')
    repo.cleanup()
    fs.rmSync(w.dir, { recursive:true, force:true })
})

test('abort kills a streamed blob read', async t => {
    const repo = newRepo()
    const tree = pinnedWorktree(repo.git('rev-parse', 'HEAD^{tree}').trim())
    // `blob` is the streamed cat-file; it never finishes.
    const w = wrapGit(repo, 'blob', 'sleep 30')
    const ac = new AbortController()
    const p = numberedSnippet(repo.dir, 'README.md', 1000, tree,
        { env:w.env, signal:ac.signal })
    const pid = await waitForPid(w.pidFile)
    ac.abort()
    const err = await rejection(p)
    t.ok(err instanceof Error && err.name === 'AbortError',
        'rejects with an AbortError')
    t.ok(await waitDead(pid), 'cat-file blob was killed')
    repo.cleanup()
    fs.rmSync(w.dir, { recursive:true, force:true })
})

test('LineReader caps lines without swallowing the next', async t => {
    const long = 'A'.repeat(100)
    const src = Readable.from([Buffer.from(long + '\nsec'),
        Buffer.from('ond\nlast')])
    const r = new LineReader(src)
    const a = await r.readLineCapped(10)
    t.equal(a.line.toString(), 'A'.repeat(10) + '\n', 'cut line keeps \\n')
    t.ok(a.cut && !a.eof, 'first line is cut')
    const b = await r.readLineCapped(10)
    t.equal(b.line.toString(), 'second\n', 'next line is whole')
    t.ok(!b.cut, 'second line not cut')
    const c = await r.readLineCapped(10)
    t.equal(c.line.toString(), 'last', 'final line without newline')
    t.ok(c.eof, 'eof after the final line')
    const d = await r.readLineCapped(10)
    t.ok(d.line.length === 0 && d.eof, 'then empty at eof')
})
