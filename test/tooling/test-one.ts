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
