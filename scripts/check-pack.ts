// The slimmed package check (spec 15, 2.10). Operates on process.cwd()
// so tests can run it in a fixture. Run by `npm run check:pack` after a
// build, in CI and in prepublishOnly. Run directly by Node (type
// stripping), so only erasable TypeScript syntax is allowed here.
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED_FILES = [
    'dist/cli.js',
    'dist/THIRD_PARTY_LICENSES.txt',
    'roast.schema.json',
    'LICENSE.txt',
    'LICENSE-MIT.txt',
    'LICENSE-APACHE.txt',
]

const SHEBANG = '#!/usr/bin/env node\n'

interface PackResult {
    files?:Array<{ path?:unknown }>;
}

// The paths `npm pack --dry-run --json` would put in the tarball. npm 12
// prints an object keyed by package name, older npm an array.
function packedFiles (cwd:string):Set<string> {
    const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd,
        encoding:'utf8',
    })
    if (res.error) throw res.error
    if (res.status !== 0) {
        process.stderr.write(res.stderr)
        throw new Error(`npm pack --dry-run exited ${res.status}`)
    }
    const parsed:unknown = JSON.parse(res.stdout)
    const results = (Array.isArray(parsed) ?
        parsed :
        Object.values(parsed as Record<string, unknown>)) as PackResult[]
    if (results.length !== 1) {
        throw new Error(`npm pack reported ${results.length} packages, ` +
            'expected 1')
    }
    const files = results[0]?.files ?? []
    return new Set(files.map(file => String(file.path)))
}

function manifestProblems (manifest:Record<string, unknown>):string[] {
    const problems:string[] = []
    if (typeof manifest.license !== 'string' || manifest.license === '') {
        problems.push('package.json declares no license')
    }
    const deps = manifest.dependencies
    if (deps !== undefined &&
        (typeof deps !== 'object' || deps === null ||
            Object.keys(deps).length > 0)) {
        problems.push('package.json declares dependencies; everything ' +
            'Roast runs must be bundled into dist/cli.js')
    }
    if (manifest.optionalDependencies !== undefined) {
        problems.push('package.json declares optionalDependencies')
    }
    return problems
}

function cliProblems (path:string):string[] {
    let fd:number
    try {
        fd = openSync(path, 'r')
    } catch {
        return [] // the tarball check already reports a missing file
    }
    const head = Buffer.alloc(SHEBANG.length)
    try {
        readSync(fd, head, 0, head.length, 0)
    } finally {
        closeSync(fd)
    }
    const problems:string[] = []
    if (head.toString('utf8') !== SHEBANG) {
        problems.push(`dist/cli.js does not start with ${
            JSON.stringify(SHEBANG)}`)
    }
    if ((statSync(path).mode & 0o100) === 0) {
        problems.push('dist/cli.js is not executable by its owner')
    }
    return problems
}

function main ():number {
    const cwd = process.cwd()
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'),
        'utf8')) as Record<string, unknown>
    const packed = packedFiles(cwd)
    const problems = [
        ...REQUIRED_FILES
            .filter(file => !packed.has(file))
            .map(file => `the tarball does not contain ${file}`),
        ...manifestProblems(manifest),
        ...cliProblems(join(cwd, 'dist', 'cli.js')),
    ]
    if (problems.length > 0) {
        for (const problem of problems) {
            console.error(`packaging check failed: ${problem}`)
        }
        console.error('hint: run `npm run build`, then check the `files` ' +
            'list in package.json')
        return 1
    }
    console.log(`packaging check passed: ${packed.size} files, ` +
        `${REQUIRED_FILES.length} required files present`)
    return 0
}

try {
    process.exitCode = main()
} catch (err) {
    console.error(`packaging check failed: ${
        err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
}
