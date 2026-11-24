import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Metafile } from 'esbuild'
import { test } from '@substrate-system/tapzero'
import { ROOT } from '../helpers/spawn.js'
import {
    bundledPackageDirs,
    readBundledPackages,
    renderNotices,
} from '../../scripts/licenses.ts'

const OUTFILE = 'dist/cli.js'

interface FixturePackage {
    name:string;
    version:string;
    license?:unknown;
    repository?:unknown;
    licenseFiles?:Record<string, string>;
}

// Writes one package (manifest plus license files) into `dir`.
async function writePackage (dir:string, pkg:FixturePackage):Promise<void> {
    await mkdir(join(dir, 'lib'), { recursive:true })
    const manifest:Record<string, unknown> = {
        name:pkg.name,
        version:pkg.version,
    }
    if (pkg.license !== undefined) manifest.license = pkg.license
    if (pkg.repository !== undefined) manifest.repository = pkg.repository
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'lib', 'index.js'), 'export {}\n')
    const files = pkg.licenseFiles ?? { LICENSE:`${pkg.name} license\n` }
    for (const [file, text] of Object.entries(files)) {
        await writeFile(join(dir, file), text)
    }
}

// A metafile whose dist/cli.js output has the given inputs.
function metafile (inputs:Record<string, number>):Metafile {
    const outInputs:Metafile['outputs'][string]['inputs'] = {}
    for (const [path, bytes] of Object.entries(inputs)) {
        outInputs[path] = { bytesInOutput:bytes }
    }
    return {
        inputs:{},
        outputs:{
            [OUTFILE]:{
                bytes:1,
                inputs:outInputs,
                imports:[],
                exports:[],
                entryPoint:'src/cli.ts',
            },
        },
    }
}

async function withFixture (
    fn:(root:string) => Promise<void>
):Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'roast-licenses-'))
    try {
        await fn(root)
    } finally {
        await rm(root, { recursive:true, force:true })
    }
}

test('notices collect unscoped, scoped, and nested packages', async t => {
    await withFixture(async root => {
        const nm = join(root, 'node_modules')
        await writePackage(join(nm, 'plain'), {
            name:'plain', version:'1.0.0', license:'MIT',
        })
        await writePackage(join(nm, '@scope', 'pkg'), {
            name:'@scope/pkg', version:'2.0.0', license:'ISC',
        })
        const nested = join(nm, 'plain', 'node_modules', 'inner')
        await writePackage(nested, {
            name:'inner', version:'3.0.0', license:'Apache-2.0',
        })
        // A second copy of inner@3.0.0 in another place.
        const copy = join(nm, '@scope', 'pkg', 'node_modules', 'inner')
        await writePackage(copy, {
            name:'inner', version:'3.0.0', license:'Apache-2.0',
        })

        const meta = metafile({
            [join(nm, 'plain', 'lib', 'index.js')]:10,
            [join(nm, 'plain', 'lib', 'other.js')]:10,
            [join(nm, '@scope', 'pkg', 'lib', 'index.js')]:10,
            [join(nested, 'lib', 'index.js')]:10,
            [join(copy, 'lib', 'index.js')]:10,
        })
        const dirs = bundledPackageDirs(meta, OUTFILE)
        t.deepEqual([...dirs].sort(), [
            join(nm, '@scope', 'pkg'),
            copy,
            join(nm, 'plain'),
            nested,
        ].sort(), 'one directory per package root, innermost for nested')

        const packages = readBundledPackages(dirs)
        t.deepEqual(packages.map(p => `${p.name}@${p.version}`).sort(), [
            '@scope/pkg@2.0.0',
            'inner@3.0.0',
            'plain@1.0.0',
        ], 'packages are deduplicated by name@version')
        const scoped = packages.find(p => p.name === '@scope/pkg')
        t.equal(scoped?.license, 'ISC', 'reads the license field')
        t.deepEqual(scoped?.licenseFiles,
            [join(nm, '@scope', 'pkg', 'LICENSE')],
            'finds the license file')
    })
})

test('notices ignore unbundled inputs and inputs outside node_modules',
    async t => {
        await withFixture(async root => {
            const nm = join(root, 'node_modules')
            await writePackage(join(nm, 'used'), {
                name:'used', version:'1.0.0', license:'MIT',
            })
            await writePackage(join(nm, 'tree-shaken'), {
                name:'tree-shaken', version:'1.0.0', license:'MIT',
            })
            const meta = metafile({
                [join(nm, 'used', 'lib', 'index.js')]:5,
                [join(nm, 'tree-shaken', 'lib', 'index.js')]:0,
                'src/cli.ts':100,
                [join(root, 'my_node_modules', 'x', 'index.js')]:5,
            })
            t.deepEqual(bundledPackageDirs(meta, OUTFILE),
                [join(nm, 'used')],
                'only node_modules inputs with bytes in the output')
        })
    })

// Runs readBundledPackages on one package and returns the error message,
// or null when it does not throw.
async function rejection (pkg:FixturePackage):Promise<string|null> {
    let message:string|null = null
    await withFixture(async root => {
        const good = join(root, 'node_modules', 'good')
        await writePackage(good, {
            name:'good', version:'1.0.0', license:'MIT',
        })
        const dir = join(root, 'node_modules', pkg.name)
        await writePackage(dir, pkg)
        try {
            readBundledPackages([good, dir])
        } catch (err) {
            message = err instanceof Error ? err.message : String(err)
        }
    })
    return message
}

test('a package with no license file is rejected by name', async t => {
    const message = await rejection({
        name:'no-file', version:'1.0.0', license:'MIT', licenseFiles:{},
    })
    t.ok(message?.includes('no-file@1.0.0'), 'the error names the package')
})

test('a package with no license field is rejected by name', async t => {
    const message = await rejection({ name:'no-field', version:'1.0.0' })
    t.ok(message?.includes('no-field@1.0.0'), 'the error names the package')
})

test('a legacy licenses array is not a license field', async t => {
    const message = await rejection({
        name:'legacy', version:'1.0.0', license:[{ type:'MIT' }],
    })
    t.ok(message?.includes('legacy@1.0.0'), 'the error names the package')
})

test('a license outside the allowlist is rejected by name', async t => {
    for (const license of [
        'GPL-3.0',
        'SEE LICENSE IN LICENSE',
        '(MIT OR GPL-2.0)',
        'Apache-2.0 WITH LLVM-exception',
    ]) {
        const message = await rejection({
            name:'bad', version:'1.0.0', license,
        })
        t.ok(message?.includes('bad@1.0.0'),
            `${license} is rejected, naming the package`)
    }
})

test('SPDX expressions of allowed licenses are accepted', async t => {
    for (const license of [
        'MIT',
        '(MIT OR Apache-2.0)',
        'BSD-2-Clause AND BSD-3-Clause',
        'ISC OR (MPL-2.0 AND Unlicense)',
    ]) {
        t.equal(await rejection({ name:'ok', version:'1.0.0', license }),
            null, `${license} is accepted`)
    }
})

test('license files are matched by name, sorted', async t => {
    await withFixture(async root => {
        const dir = join(root, 'node_modules', 'files')
        await writePackage(dir, {
            name:'files',
            version:'1.0.0',
            license:'(MIT OR Apache-2.0)',
            licenseFiles:{
                NOTICE:'notice\n',
                'LICENSE-MIT.txt':'mit\n',
                'licence.md':'licence\n',
                COPYING:'copying\n',
                'LICENSES.txt':'not a license file\n',
                'README.md':'readme\n',
            },
        })
        const [pkg] = readBundledPackages([dir])
        t.deepEqual(pkg?.licenseFiles, [
            'COPYING', 'LICENSE-MIT.txt', 'NOTICE', 'licence.md',
        ].map(file => join(dir, file)), 'only license files, by name')
    })
})

test('notices render sorted by name then version, deterministically',
    async t => {
        await withFixture(async root => {
            const nm = join(root, 'node_modules')
            const fixtures:Array<[string, FixturePackage]> = [
                ['zeta', { name:'zeta', version:'1.0.0', license:'MIT' }],
                [join('a', 'node_modules', 'beta'), {
                    name:'beta', version:'2.0.0', license:'ISC',
                }],
                ['beta', {
                    name:'beta',
                    version:'10.0.0',
                    license:'ISC',
                    repository:{ url:'https://example.com/beta.git' },
                }],
                ['@scope/alpha', {
                    name:'@scope/alpha', version:'1.0.0', license:'MIT',
                }],
            ]
            const dirs:string[] = []
            for (const [rel, pkg] of fixtures) {
                const dir = join(nm, rel)
                await writePackage(dir, pkg)
                dirs.push(dir)
            }
            const read = (path:string) => readFileSync(path, 'utf8')
            const first = renderNotices(readBundledPackages(dirs), read)
            const second = renderNotices(
                readBundledPackages([...dirs].reverse()), read)
            t.equal(first, second, 'two renders are equal')
            const headers = first.split('\n').filter(line =>
                /^(@[^/\s]+\/)?[^@\s]+@\S+$/.test(line))
            t.deepEqual(headers, [
                '@scope/alpha@1.0.0',
                'beta@2.0.0',
                'beta@10.0.0',
                'zeta@1.0.0',
            ], 'packages are sorted by name, then by version')
            t.ok(first.endsWith('\n') && !first.endsWith('\n\n'),
                'the file ends with exactly one newline')
        })
    })

test('the real bundle lists every bundled package in its notices',
    async t => {
        const meta:Metafile = JSON.parse(
            readFileSync(join(ROOT, 'dist', 'meta.json'), 'utf8'))
        const dirs = bundledPackageDirs(meta, OUTFILE)
            .map(dir => resolve(ROOT, dir))
        const packages = readBundledPackages(dirs)
        t.ok(packages.length > 0, 'the bundle has third-party packages')
        const notices = readFileSync(
            join(ROOT, 'dist', 'THIRD_PARTY_LICENSES.txt'), 'utf8')
        const lines = new Set(notices.split('\n'))
        for (const pkg of packages) {
            const header = `${pkg.name}@${pkg.version}`
            t.ok(lines.has(header), `${header} has a header line`)
        }
    })
