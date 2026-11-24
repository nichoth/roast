// `roast runs` and `roast runs show` (spec 10, 2.14 and 2.15).
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { recordRepo } from '../record/repo.js'
import { writeReport } from '../../src/record/meta.js'
import { tempDir, type TempDir } from '../helpers/repo.js'

function runs (r:TempDir, args:string[] = []) {
    return runRoast(['runs', ...args], { cwd:r.dir, env:r.env })
}

test('runs with no records exits 0 with empty stdout', async t => {
    const r = recordRepo(t)
    const res = await runs(r)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(res.stdout, '', 'nothing on stdout')
    t.ok(res.stderr.length > 0, 'a note on stderr')
    t.ok(!fs.existsSync(path.join(r.dir, '.roast')), 'no state created')
})

test('runs outside a Git repository is a usage error', async t => {
    const d = tempDir()
    t.cleanup(d.remove)
    const res = await runs(d)
    t.equal(res.code, 2, `exits 2 ${res.stderr}`)
    t.equal(res.stdout, '', 'nothing on stdout')
})

test('runs rejects any positional argument', async t => {
    const r = recordRepo(t)
    for (const arg of ['sync', 'status', 'bogus']) {
        const res = await runs(r, [arg])
        t.equal(res.code, 2, `runs ${arg} exits 2`)
        t.equal(res.stdout, '', `runs ${arg} prints nothing`)
    }
})

function runLine (id:string, ts = '2026-01-02T03:04:05+00:00'):string {
    return JSON.stringify({
        ts,
        run_id:id,
        repo:'/repo',
        mode:'staged',
        quick:false,
        assessment:'ok',
        n_findings:1,
        n_refuted:0,
        files_reviewed:['a.go'],
    })
}

// Writes monthly index files (name -> content) under .roast/runs.
function writeIndex (r:TempDir, files:Record<string, string>):void {
    const dir = path.join(r.dir, '.roast', 'runs')
    fs.mkdirSync(dir, { recursive:true })
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body)
    }
}

test('runs --json --limit 2 prints the last two raw lines', async t => {
    const r = recordRepo(t)
    const older = runLine('run-older')
    const middle = runLine('run-middle')
    const newest = '{not json'
    writeIndex(r, {
        'runs-2026-02.jsonl':`${newest}\n`,
        'runs-2026-01.jsonl':`${older}\n${middle}\n`,
    })
    const res = await runs(r, ['--json', '--limit', '2'])
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(res.stdout, `${middle}\n${newest}\n`, 'last two, verbatim')
})

test('runs prints one line per parseable index line', async t => {
    const r = recordRepo(t)
    writeIndex(r, {
        'runs-2026-01.jsonl':[
            runLine('run-a'),
            '{broken',
            JSON.stringify({ run_id:'run-wrong-type', n_findings:'x' }),
            JSON.stringify({ run_id:'run-sparse' }),
            '',
        ].join('\n') + '\n',
    })
    const res = await runs(r)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    const lines = res.stdout.split('\n').filter(Boolean)
    t.equal(lines.length, 2, 'two runs listed')
    t.ok(lines[0].includes('run-a'), 'first run ID')
    t.ok(lines[1].includes('run-sparse'), 'missing keys are zero values')
})

test('runs pads columns in code points', async t => {
    const r = recordRepo(t)
    const line = (mode:string) => JSON.stringify({ run_id:'r', mode })
    writeIndex(r, {
        'runs-2026-01.jsonl':`${line('ab')}\n${line('\u00e9\u00e9')}\n`,
    })
    const res = await runs(r)
    const cols = res.stdout.split('\n').filter(Boolean)
        .map(l => [...l].indexOf('q'))
    t.equal(cols.length, 2, 'two lines')
    t.equal(cols[0], cols[1], 'same column for ASCII and non-ASCII')
})

test('runs --limit 0 prints every line; default keeps 20', async t => {
    const r = recordRepo(t)
    const all = Array.from({ length:23 }, (_, i) => runLine(`run-${i}`))
    writeIndex(r, { 'runs-2026-01.jsonl':all.join('\n') + '\n' })
    const count = (s:string) => s.split('\n').filter(Boolean).length
    for (const limit of ['0', '-1']) {
        const res = await runs(r, ['--limit', limit])
        t.equal(res.code, 0, `--limit ${limit} exits 0`)
        t.equal(count(res.stdout), 23, `--limit ${limit} prints all`)
    }
    const res = await runs(r, ['--json'])
    t.equal(res.stdout, all.slice(3).join('\n') + '\n', 'default 20')
    const bad = await runs(r, ['--limit', '1.5'])
    t.equal(bad.code, 2, 'non-integer limit is a usage error')
})

test('runs reads CRLF lines without the carriage return', async t => {
    const r = recordRepo(t)
    const a = runLine('run-a')
    const b = runLine('run-b')
    writeIndex(r, { 'runs-2026-01.jsonl':`${a}\r\n${b}` })
    const res = await runs(r, ['--json'])
    t.equal(res.stdout, `${a}\n${b}\n`, 'CR stripped, final line kept')
})

function recordsDir (r:TempDir):string {
    return path.join(r.dir, '.roast', 'runs')
}

test('runs show prints a stored report', async t => {
    const r = recordRepo(t)
    const report = '# Roast report\n\nNo findings.\n'
    await writeReport(recordsDir(r), '20260102T030405Z-abcd', report)
    const res = await runs(r, ['show', '20260102T030405Z-abcd'])
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(res.stdout, report, 'report, nothing appended')
    const prefix = await runs(r, ['show', '20260102T03'])
    t.equal(prefix.stdout, report, 'a unique prefix resolves')
})

test('runs show escapes control bytes in a stored report', async t => {
    const r = recordRepo(t)
    const report = 'a\u001b[31mred\u0007bell\u009bcsi\n'
    await writeReport(recordsDir(r), 'run-ctl', report)
    const res = await runs(r, ['show', 'run-ctl'])
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    for (const [name, ch] of [['ESC', '\u001b'], ['BEL', '\u0007'],
        ['C1', '\u009b']]) {
        t.ok(!res.stdout.includes(ch), `no ${name}`)
    }
    t.ok(res.stdout.includes('red'), 'text kept')
})

test('runs show needs exactly one argument', async t => {
    const r = recordRepo(t)
    await writeReport(recordsDir(r), 'run-a', 'report\n')
    for (const args of [[], ['run-a', 'run-b']]) {
        const res = await runs(r, ['show', ...args])
        t.equal(res.code, 2, `${args.length} arguments exit 2`)
        t.equal(res.stdout, '', `${args.length} arguments print nothing`)
    }
})

test('runs show rejects path-like run IDs', async t => {
    const r = recordRepo(t)
    // A report one level above .roast/runs that `..` or `a/b` could
    // reach if IDs were joined as paths.
    fs.mkdirSync(path.join(r.dir, '.roast', 'runs', 'a', 'b'),
        { recursive:true })
    fs.writeFileSync(path.join(r.dir, '.roast', 'report.md'), 'outside\n')
    fs.writeFileSync(path.join(r.dir, '.roast', 'runs', 'a', 'b',
        'report.md'), 'nested\n')
    for (const id of ['..', 'a/b', '.']) {
        const res = await runs(r, ['show', id])
        t.equal(res.code, 4, `${id} exits 4`)
        t.equal(res.stdout, '', `${id} prints nothing`)
    }
})

test('runs show without a report exits 4', async t => {
    const r = recordRepo(t)
    fs.mkdirSync(path.join(recordsDir(r), 'run-empty'), { recursive:true })
    const res = await runs(r, ['show', 'run-empty'])
    t.equal(res.code, 4, `exits 4 ${res.stderr}`)
    t.equal(res.stdout, '', 'nothing on stdout')
    const missing = await runs(r, ['show', 'no-such-run'])
    t.equal(missing.code, 4, 'unknown run exits 4')
})
