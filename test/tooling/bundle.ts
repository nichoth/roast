import { readFile, stat, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import { ROOT, run } from '../helpers/spawn.js'
import { tempRepo } from '../helpers/repo.js'
import { GATE_EXAMPLE } from '../config/examples.js'

const CLI = join(ROOT, 'dist', 'cli.js')

// The process env without anything that could pick a locale.
function baseEnv ():NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (key === 'LANG' || key === 'LANGUAGE' || key.startsWith('LC_')) {
            delete env[key]
        }
    }
    return env
}

test('--version prints the package.json version', async t => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'),
        'utf8'))
    for (const flag of ['--version', '-v']) {
        const res = await run(process.execPath, [CLI, flag])
        t.equal(res.code, 0, `${flag} exits 0`)
        t.ok(res.stdout.includes(pkg.version),
            `${flag} output contains the package version`)
    }
})

test('--help output does not depend on the locale', async t => {
    const german = await run(process.execPath, [CLI, '--help'], {
        env:{ ...baseEnv(), LC_ALL:'de_DE.UTF-8', LANG:'de_DE.UTF-8' },
    })
    const c = await run(process.execPath, [CLI, '--help'], {
        env:{ ...baseEnv(), LC_ALL:'C' },
    })
    t.equal(german.code, 0, 'help exits 0 under a German locale')
    t.equal(c.code, 0, 'help exits 0 under the C locale')
    t.ok(c.stdout.length > 0, 'help is printed to stdout')
    t.equal(german.stdout, c.stdout, 'help output is identical')
})

test('dist/cli.js has a shebang and the owner execute bit', async t => {
    const file = await open(CLI, 'r')
    const head = Buffer.alloc(20)
    await file.read(head, 0, 20, 0)
    await file.close()
    t.equal(head.toString('utf8'), '#!/usr/bin/env node\n',
        'the first line is the node shebang')
    const mode = (await stat(CLI)).mode
    t.ok(mode & 0o100, 'the owner can execute it')
})

test('the entry exits 2 on a Node version below 22.18', async t => {
    const fakeVersion = 'data:text/javascript,' + encodeURIComponent(
        'Object.defineProperty(process.versions, "node", ' +
        '{ value: "22.17.1" })'
    )
    const res = await run(process.execPath, [
        '--import', fakeVersion, CLI, '--version',
    ])
    t.equal(res.code, 2, 'exits 2')
    t.ok(res.stderr.includes('22.18'), 'stderr names the floor')
    t.equal(res.stdout, '', 'the CLI body never ran')
})

test('the bundle reads a commented config for gate settings', async t => {
    const repo = tempRepo()
    try {
        await writeFile(join(repo.dir, '.roast.json'), GATE_EXAMPLE)
        const res = await run(process.execPath, [CLI, 'gate', 'settings'],
            { cwd:repo.dir, env:repo.env })
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        const lines = res.stdout.split('\n')
        t.ok(lines.includes('timeout_seconds=42'), 'the configured timeout')
        t.ok(lines.includes('severity=MEDIUM'), 'the configured severity')
    } finally {
        repo.remove()
    }
})
