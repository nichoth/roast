// `roast ignore` (spec 12, 2.13): /.roast/ in the toplevel .gitignore.
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { gateRepo, read, scratch, type GateRepo } from '../gate/helpers.js'

function ignore (r:GateRepo, cwd = r.dir) {
    return runRoast(['ignore'], { cwd, env:r.env })
}

test('ignore creates the toplevel .gitignore', async t => {
    const r = gateRepo(t, false)
    const sub = path.join(r.dir, 'a', 'b')
    fs.mkdirSync(sub, { recursive:true })
    const res = await ignore(r, sub)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(read(path.join(r.dir, '.gitignore')), '/.roast/\n', 'created')
    t.equal((fs.statSync(path.join(r.dir, '.gitignore')).mode & 0o777) &
        0o644, 0o644, 'readable by everyone')
    t.ok(!fs.existsSync(path.join(sub, '.gitignore')), 'not in the subdir')
})

test('ignore appends to an existing .gitignore', async t => {
    const cases:[string, string][] = [
        ['node_modules/\n', 'node_modules/\n/.roast/\n'],
        ['node_modules/\ndist', 'node_modules/\ndist\n/.roast/\n'],
        ['', '/.roast/\n'],
    ]
    for (const [before, after] of cases) {
        const r = gateRepo(t, false)
        const file = path.join(r.dir, '.gitignore')
        fs.writeFileSync(file, before)
        const res = await ignore(r)
        t.equal(res.code, 0, 'exits 0')
        t.equal(read(file), after, `${JSON.stringify(before)} appended`)
    }
})

test('ignore leaves an equivalent entry unchanged', async t => {
    for (const entry of ['/.roast/', '/.roast', '.roast/', '.roast',
        '  .roast/  ']) {
        const r = gateRepo(t, false)
        const file = path.join(r.dir, '.gitignore')
        const body = `dist\n${entry}\nnode_modules`
        fs.writeFileSync(file, body)
        const res = await ignore(r)
        t.equal(res.code, 0, 'exits 0')
        t.equal(read(file), body, `${JSON.stringify(entry)} kept as is`)
    }
})

test('ignore twice is idempotent', async t => {
    const r = gateRepo(t, false)
    await ignore(r)
    const once = read(path.join(r.dir, '.gitignore'))
    const res = await ignore(r)
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(path.join(r.dir, '.gitignore')), once, 'unchanged')
})

test('ignore outside a repository is a usage error', async t => {
    const r = gateRepo(t, false)
    const outside = scratch(t)
    const res = await runRoast(['ignore'], { cwd:outside, env:r.env })
    t.equal(res.code, 2, 'exits 2')
    t.ok(!fs.existsSync(path.join(outside, '.gitignore')), 'writes nothing')
    const extra = await runRoast(['ignore', 'x'], { cwd:r.dir, env:r.env })
    t.equal(extra.code, 2, 'an extra argument exits 2')
})
