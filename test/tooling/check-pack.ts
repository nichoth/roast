// Runs the real scripts/check-pack.ts with cwd set to a fixture
// package that copies the real `files` and `license` from package.json.
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import { ROOT, run } from '../helpers/spawn.js'
import type { SpawnResult } from '../helpers/spawn.js'

const SCRIPT = join(ROOT, 'scripts', 'check-pack.ts')

type Manifest = Record<string, unknown>

interface Fixture {
    dir:string;
    manifest:Manifest;
}

async function makeFixture ():Promise<Fixture> {
    const real = JSON.parse(await readFile(join(ROOT, 'package.json'),
        'utf8'))
    const dir = await mkdtemp(join(tmpdir(), 'roast-check-pack-'))
    const manifest:Manifest = {
        name:'roast-check-pack-fixture',
        version:'1.0.0',
        license:real.license,
        files:real.files,
    }
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'dist', 'cli.js'),
        '#!/usr/bin/env node\nconsole.log("roast")\n')
    await chmod(join(dir, 'dist', 'cli.js'), 0o755)
    await writeFile(join(dir, 'dist', 'THIRD_PARTY_LICENSES.txt'),
        'notices\n')
    await writeFile(join(dir, 'roast.schema.json'), '{}\n')
    for (const file of ['LICENSE.txt', 'LICENSE-MIT.txt',
        'LICENSE-APACHE.txt']) {
        await writeFile(join(dir, file), 'license\n')
    }
    return { dir, manifest }
}

// Builds a fixture, lets `change` break it, and runs the check there.
async function checkPackage (
    change:(fixture:Fixture) => Promise<void>|void = () => {}
):Promise<SpawnResult> {
    const fixture = await makeFixture()
    try {
        await change(fixture)
        await writeFile(join(fixture.dir, 'package.json'),
            JSON.stringify(fixture.manifest, null, 2))
        return await run(process.execPath, [SCRIPT], { cwd:fixture.dir })
    } finally {
        await rm(fixture.dir, { recursive:true, force:true })
    }
}

function removes (path:string) {
    return ({ dir }:Fixture) => rm(join(dir, path))
}

test('check-pack passes when every required file is present',
    async t => {
        const res = await checkPackage()
        t.equal(res.code, 0, `exits 0 (stderr: ${res.stderr})`)
    })

test('check-pack fails when the tarball lacks a required file',
    async t => {
        for (const file of [
            'dist/cli.js',
            'roast.schema.json',
            'LICENSE-MIT.txt',
            'dist/THIRD_PARTY_LICENSES.txt',
        ]) {
            const res = await checkPackage(removes(file))
            t.equal(res.code, 1, `exits 1 without ${file}`)
            t.ok(res.stderr.includes(file), `the problem names ${file}`)
        }
    })

test('check-pack fails on a manifest that installs dependencies',
    async t => {
        const cases:Array<[string, (manifest:Manifest) => void]> = [
            ['no license', m => { delete m.license }],
            ['non-empty dependencies', m => {
                m.dependencies = { yargs:'^18.0.0' }
            }],
            ['optionalDependencies', m => {
                m.optionalDependencies = { fsevents:'^2.0.0' }
            }],
        ]
        for (const [name, edit] of cases) {
            const res = await checkPackage(({ manifest }) => edit(manifest))
            t.equal(res.code, 1, `exits 1 with ${name}`)
        }
    })

test('check-pack accepts an empty dependencies object', async t => {
    const res = await checkPackage(({ manifest }) => {
        manifest.dependencies = {}
    })
    t.equal(res.code, 0, `exits 0 (stderr: ${res.stderr})`)
})

test('check-pack fails when dist/cli.js cannot run as a bin',
    async t => {
        const noShebang = await checkPackage(({ dir }) =>
            writeFile(join(dir, 'dist', 'cli.js'), 'console.log(1)\n'))
        t.equal(noShebang.code, 1, 'exits 1 without the shebang')
        const notExecutable = await checkPackage(({ dir }) =>
            chmod(join(dir, 'dist', 'cli.js'), 0o644))
        t.equal(notExecutable.code, 1, 'exits 1 when not executable')
    })
