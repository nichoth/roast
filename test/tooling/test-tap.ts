import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import { ROOT, run } from '../helpers/spawn.js'

// Runs the real `test:tap` script from package.json in a fixture directory
// whose test/test-bundle.js is `bundle`.
async function testTap (bundle:string) {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'),
        'utf8'))
    const script:string = pkg.scripts['test:tap']
    const dir = await mkdtemp(join(tmpdir(), 'roast-test-tap-'))
    const bin = join(ROOT, 'node_modules', '.bin')
    try {
        await mkdir(join(dir, 'test'))
        await writeFile(join(dir, 'test', 'test-bundle.js'), bundle)
        return await run('sh', ['-c', script], {
            cwd:dir,
            env:{ ...process.env, PATH:bin + delimiter + process.env.PATH },
        })
    } finally {
        await rm(dir, { recursive:true, force:true })
    }
}

// tap-spec itself exits non-zero on `not ok` lines and a missing plan,
// so these bundles print a complete, passing TAP stream and fail only
// through their exit status: pipefail is what catches them.
const PASSING_TAP = "console.log('TAP version 13\\nok 1 - fine\\n1..1')\n"

test('test:tap exits 0 when the test bundle passes', async t => {
    const res = await testTap(PASSING_TAP)
    t.equal(res.code, 0, 'exits 0')
})

test('test:tap exits non-zero when the bundle reports a failure', async t => {
    const res = await testTap(PASSING_TAP + 'process.exitCode = 1\n')
    t.ok(res.code !== 0, 'exits non-zero')
})

test('test:tap exits non-zero when the test bundle crashes', async t => {
    const res = await testTap(PASSING_TAP +
        "setTimeout(() => { throw new Error('crash after the plan') })\n")
    t.ok(res.code !== 0, 'exits non-zero')
})

test('test:tap exits non-zero on a failed assertion', async t => {
    const res = await testTap(
        "console.log('TAP version 13\\nnot ok 1 - broken\\n1..1')\n" +
        'process.exitCode = 1\n')
    t.ok(res.code !== 0, 'exits non-zero')
})

test('parallel runner executes each fixture in an isolated process', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'roast-groups-'))
    try {
        const files = ['alpha', 'beta'].map(name => join(dir, `${name}.ts`))
        await Promise.all(files.map((file, i) => writeFile(file,
            `console.log('TAP version 13\\nok 1 - fixture-${i} ' + ` +
            "process.pid + '\\n1..1')\n")))
        const res = await run('npm', ['run', 'test:run', '--', ...files], {
            cwd:ROOT,
        })
        t.equal(res.code, 0, 'runner succeeds')
        t.ok(res.stdout.includes('fixture-0'), 'first fixture reported')
        t.ok(res.stdout.includes('fixture-1'), 'second fixture reported')
        const pids = [...res.stdout.matchAll(/fixture-\d+ (\d+)/g)]
            .map(match => match[1])
        t.equal(pids.length, 2, 'each fixture reported once')
        t.ok(pids[0] !== pids[1], 'different processes')
    } finally {
        await rm(dir, { recursive:true, force:true })
    }
})

test('parallel runner rejects failed, crashed and incomplete groups',
    async t => {
        const dir = await mkdtemp(join(tmpdir(), 'roast-groups-fail-'))
        try {
            const cases = [
                "console.log('TAP version 13\\nnot ok 1 - broken\\n1..1')",
                "throw new Error('fixture crash')",
                "console.log('TAP version 13\\nok 1 - unfinished')",
                PASSING_TAP + 'process.exitCode = 2',
            ]
            for (const [i, source] of cases.entries()) {
                const file = join(dir, `failure-${i}.ts`)
                await writeFile(file, source)
                const res = await run('node', [
                    'scripts/test-groups.ts', file,
                ], { cwd:ROOT })
                t.ok(res.code !== 0, `failure ${i} propagates`)
                t.ok((res.stdout + res.stderr).includes(`failure-${i}.ts`),
                    `failure ${i} identifies its group`)
            }
        } finally {
            await rm(dir, { recursive:true, force:true })
        }
    })

test('parallel runner accepts a reduced worker limit', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'roast-workers-'))
    try {
        const marker = join(dir, 'order')
        const files = ['first', 'second'].map(name => join(dir, `${name}.ts`))
        for (const [i, file] of files.entries()) {
            await writeFile(file,
                "import { appendFileSync } from 'node:fs'\n" +
                `appendFileSync(${JSON.stringify(marker)}, '${i}')\n` +
                PASSING_TAP)
        }
        const res = await run('npm', ['run', 'test:run', '--', ...files], {
            cwd:ROOT,
            env:{ ...process.env, ROAST_TEST_WORKERS:'1' },
        })
        t.equal(res.code, 0, 'runner succeeds with one worker')
        t.equal(await readFile(marker, 'utf8'), '01', 'groups run in order')
    } finally {
        await rm(dir, { recursive:true, force:true })
    }
})

test('parallel runner removes bundles after success and failure', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'roast-group-cleanup-'))
    try {
        for (const [name, status] of [['pass', 0], ['fail', 1]] as const) {
            const file = join(dir, `${name}.ts`)
            await writeFile(file,
                "console.error('bundle-path=' + new URL(import.meta.url).pathname)\n" +
                PASSING_TAP + `process.exitCode = ${status}\n`)
            const res = await run('npm', [
                'run', 'test:run', '--', file,
            ], { cwd:ROOT })
            t.equal(res.code, status, `${name} exit status`)
            const path = (res.stdout + res.stderr)
                .match(/bundle-path=([^\s]+)/)?.[1]
            t.ok(path, `${name} reports its bundle`)
            const exists = path ? await access(path).then(
                () => true, () => false) : true
            t.ok(!exists, `${name} bundle removed`)
        }
    } finally {
        await rm(dir, { recursive:true, force:true })
    }
})
