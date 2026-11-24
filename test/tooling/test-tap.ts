import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
