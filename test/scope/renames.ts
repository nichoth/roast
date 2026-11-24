import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { build, fit } from '../../src/scope/index.js'
import { newRepo, type TestRepo } from './helpers.js'

function bigFile (n:number, extra = ''):string {
    let out = 'package p\n'
    for (let i = 0; i < n; i++) out += `var v${i} = ${i}\n`
    return out + extra
}

function addedLines (diff:string):number {
    return diff.split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++')).length
}

function move (repo:TestRepo, from:string, to:string):void {
    fs.mkdirSync(path.dirname(path.join(repo.dir, to)), { recursive:true })
    repo.git('mv', from, to)
}

test('a move is a delete plus add with excludes applied to each side',
    async t => {
        const repo = newRepo()
        repo.write('main.go', 'package main\n')
        repo.commitAll()
        fs.rmSync(path.join(repo.dir, 'main.go'))
        repo.write('vendor/foo/main.go', 'package main\n')
        repo.git('add', '-A')
        const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
        t.deepEqual([...s.files], ['main.go'], 'only the deletion')
        t.ok(!s.diff.includes('vendor/'), 'vendored side never appears')
        t.ok(s.diff.includes('deleted file mode'), 'plain deletion')
        repo.cleanup()
    })

test('moved files with small edits collapse to rename sections',
    async t => {
        const repo = newRepo()
        repo.git('switch', '-q', '-c', 'move')
        repo.write('pkg/big.go', bigFile(200))
        repo.commitAll('add big')
        move(repo, 'pkg/big.go', 'moved/big.go')
        repo.write('moved/big.go', bigFile(200, 'var edited = true\n'))
        repo.commitAll('move big')
        const s = await build(repo.dir, { base:'HEAD~1', env:repo.env })
        t.ok(s.diff.includes('rename from pkg/big.go\n'), 'rename from')
        t.ok(s.diff.includes('rename to moved/big.go\n'), 'rename to')
        t.ok(s.diff.includes('+var edited = true\n'), 'edited line')
        t.ok(!s.diff.includes('deleted file mode'), 'no whole-file delete')
        t.ok(addedLines(s.diff) < 20, 'only the edited lines')
        t.deepEqual([...s.files], ['moved/big.go', 'pkg/big.go'], 'files')
        t.ok(s.notes.some(n => n.includes('collapsed')), 'collapse note')
        repo.cleanup()
    })

test('a pure move has a rename header and no hunks', async t => {
    const repo = newRepo()
    repo.write('src/x.go', bigFile(50))
    repo.commitAll()
    move(repo, 'src/x.go', 'lib/x.go')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(s.diff.includes('similarity index 100%'), 'pure rename')
    t.ok(s.diff.includes('rename to lib/x.go'), 'rename header')
    t.ok(!s.diff.includes('@@'), 'no hunks')
    t.deepEqual([...s.files], ['lib/x.go', 'src/x.go'], 'both paths')
    repo.cleanup()
})

test('a move across an exclude boundary is not paired', async t => {
    const repo = newRepo()
    repo.write('src/in.go',
        'package in\n\nfunc In() string { return "in" }\n')
    repo.write('vendor/lib/out.go', 'package out\n\nvar vendored = 1\n\n' +
        'func Out() int { return vendored }\n')
    repo.commitAll()
    move(repo, 'src/in.go', 'vendor/lib/in.go')
    move(repo, 'vendor/lib/out.go', 'src/out.go')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(!s.diff.includes('vendor/'), 'vendored path never surfaces')
    t.ok(!s.diff.includes('rename '), 'not paired')
    t.ok(s.diff.includes('deleted file mode'), 'plain delete')
    t.ok(s.diff.includes('+var vendored = 1'), 'full add')
    repo.cleanup()
})

test('an uncommitted move collapses', async t => {
    const repo = newRepo()
    repo.write('a/f.go', bigFile(80))
    repo.commitAll()
    move(repo, 'a/f.go', 'b/f.go')
    const s = await build(repo.dir, { uncommittedOnly:true, env:repo.env })
    t.ok(s.diff.includes('rename from a/f.go'), 'collapsed')
    t.equal(addedLines(s.diff), 0, 'no added lines')
    repo.cleanup()
})

test('a path starting with R is not read as a status', async t => {
    const repo = newRepo()
    repo.write('README.md', '# readme\n')
    repo.write('src/x.go', bigFile(50))
    repo.commitAll()
    repo.write('README.md', '# readme\n\nedited\n')
    move(repo, 'src/x.go', 'lib/x.go')
    repo.git('add', '-A')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(s.diff.includes('rename from src/x.go'), 'move collapsed')
    t.ok(!s.diff.includes('deleted file mode'), 'no delete section')
    t.ok(s.diff.includes('+edited'), 'README edit kept')
    repo.cleanup()
})

test('fit breakdown counts a collapsed move for both paths', async t => {
    const repo = newRepo()
    repo.write('a/f.go', bigFile(80))
    repo.commitAll()
    move(repo, 'a/f.go', 'b/f.go')
    repo.write('b/f.go', bigFile(80, 'var changed = true\n'))
    repo.git('add', '-A')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(s.diff.includes('rename to b/f.go'), 'collapsed')
    const { breakdown } = fit(s, 10)
    t.ok(breakdown !== null, 'breakdown')
    for (const p of ['a/f.go', 'b/f.go']) {
        const e = breakdown?.find(x => x.path === p)
        t.ok(e && e.bytes > 0, `${p} counted`)
    }
    repo.cleanup()
})
