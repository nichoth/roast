import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import { ROOT, run } from '../helpers/spawn.js'

// Runs the real `test:one` script from package.json at the repository
// root, the way `npm run test:one -- <file>` does: npm appends the
// arguments to the script text.
async function testOne (args:string[]) {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'),
        'utf8'))
    const script:string = pkg.scripts['test:one']
    const bin = join(ROOT, 'node_modules', '.bin')
    const quoted = args.map(arg => `'${arg}'`).join(' ')
    return run('sh', ['-c', `${script} ${quoted}`], {
        cwd:ROOT,
        env:{ ...process.env, PATH:bin + delimiter + process.env.PATH },
    })
}

// Writes `source` as a test module in a temporary directory and runs it
// through `test:one`.
async function testOneSource (source:string) {
    const dir = await mkdtemp(join(tmpdir(), 'roast-test-one-'))
    try {
        const file = join(dir, 'fixture.ts')
        await writeFile(file, source)
        return await testOne([file])
    } finally {
        await rm(dir, { recursive:true, force:true })
    }
}

const PASSING_TAP = "console.log('TAP version 13\\nok 1 - fine\\n1..1')\n"

test('simultaneous focused commands keep their own results', async t => {
    const results = await Promise.all(Array.from({ length:8 }, (_, i) => {
        const label = `focused-fixture-${i}`
        const status = i % 2
        const source = `console.log('TAP version 13\\nok 1 - ${label}` +
            `\\n1..1')\nprocess.exitCode = ${status}\n`
        return testOneSource(source)
    }))
    for (const [i, res] of results.entries()) {
        t.equal(res.code, i % 2, `fixture ${i} exit status`)
        t.ok(res.stdout.includes(`focused-fixture-${i}`),
            `fixture ${i} reports its own output`)
    }
})

test('test:one exits 0 when the test module passes', async t => {
    const res = await testOneSource(PASSING_TAP)
    t.equal(res.code, 0, 'exits 0')
})

test('test:one exits non-zero when the test module fails', async t => {
    const res = await testOneSource(PASSING_TAP + 'process.exitCode = 1\n')
    t.ok(res.code !== 0, 'exits non-zero')
})

test('test:one exits non-zero without a test file', async t => {
    const res = await testOne([])
    t.ok(res.code !== 0, 'exits non-zero')
})

test('test:one exits non-zero for a missing test file', async t => {
    const res = await testOne(['test/no-such-focused-test.ts'])
    t.ok(res.code !== 0, 'exits non-zero')
})

test('test:one exits non-zero for a failed assertion', async t => {
    const res = await testOneSource(
        "console.log('TAP version 13\\nnot ok 1 - broken\\n1..1')\n"
    )
    t.ok(res.code !== 0, 'exits non-zero')
})

test('test:one exits non-zero for a crashed process', async t => {
    const res = await testOneSource("throw new Error('fixture crash')\n")
    t.ok(res.code !== 0, 'exits non-zero')
    t.ok(res.stderr.includes('fixture crash'), 'reports the crash')
})

test('focused bundles are removed after success and failure', async t => {
    for (const [name, ending, expected] of [
        ['success', '', 0],
        ['failure', 'process.exitCode = 1', 1],
        ['crash', "throw new Error('crash')", 1],
    ] as const) {
        const source = "import { fileURLToPath } from 'node:url'\n" +
            "console.error('bundle-path=' + " +
            'fileURLToPath(import.meta.url))\n' +
            PASSING_TAP + ending + '\n'
        const res = await testOneSource(source)
        const path = res.stderr.match(/bundle-path=(.+)/)?.[1]
        t.equal(res.code, expected, `${name} has expected exit status`)
        t.ok(path, `${name} reports its bundle path`)
        t.ok(path && !existsSync(path), `${name} removes its bundle`)
    }
})

test('simultaneous focused commands keep their results separate', async t => {
    const passing = "console.log('TAP version 13\\n" +
        "ok 1 - distinct-pass\\n1..1')"
    const failing = "console.error('distinct-fail'); " +
        "console.log('TAP version 13\\nnot ok 1 - broken\\n1..1')"
    const [good, bad] = await Promise.all([
        testOneSource(passing), testOneSource(failing),
    ])
    t.equal(good.code, 0, 'passing command succeeds')
    t.ok(bad.code !== 0, 'failing command fails')
    t.ok(good.stdout.includes('distinct-pass'), 'passing output is its own')
    t.ok(bad.stderr.includes('distinct-fail'), 'failing output is its own')
})
