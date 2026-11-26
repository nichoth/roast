// Bundles the CLI (default), the test entry (--test), one test module
// (--test-file <path>), or the live-test entry (--live) with esbuild.
// Run directly by Node (type stripping), so only erasable TypeScript
// syntax is allowed here.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import type { Metafile } from 'esbuild'
import { ROOT, baseOptions } from './esbuild-options.ts'
import {
    bundledPackageDirs,
    readBundledPackages,
    renderNotices,
} from './licenses.ts'

const SHEBANG = '#!/usr/bin/env node'
// esbuild's ESM output turns a bundled CommonJS `require('node:fs')` into
// a runtime "Dynamic require is not supported" error unless a `require`
// is in scope.
const REQUIRE_SHIM = [
    "import { createRequire as __roastRequire } from 'node:module'",
    'const require = __roastRequire(import.meta.url)',
].join('\n')

type Mode =
    { kind:'cli'|'test'|'live' }|
    { kind:'test-file', file:string, outfile:string }

function parseMode (args:string[]):Mode {
    if (args.length === 0) return { kind:'cli' }
    if (args.length === 1 && args[0] === '--test') return { kind:'test' }
    if (args.length === 1 && args[0] === '--live') return { kind:'live' }
    if (args.length === 2 && args[0] === '--test-file' &&
        args[1].endsWith('.ts')) {
        return {
            kind:'test-file',
            file:args[1],
            outfile:'test/one-bundle.js',
        }
    }
    if (args.length === 4 && args[0] === '--test-file' &&
        args[1].endsWith('.ts') && args[2] === '--outfile') {
        return { kind:'test-file', file:args[1], outfile:args[3] }
    }
    throw new Error('usage: node scripts/bundle.ts ' +
        '[--test|--test-file <path.ts>|--live], ' +
        `got ${args.join(' ')}`)
}

// Runs git at the repository root; `unknown` when git fails (a build
// from a tarball, no git on PATH).
function git (args:string[]):string {
    try {
        const out = execFileSync('git', args, {
            cwd:ROOT,
            encoding:'utf8',
            stdio:['ignore', 'pipe', 'ignore'],
        }).trim()
        return out || 'unknown'
    } catch {
        return 'unknown'
    }
}

async function packageVersion ():Promise<string> {
    const text = await readFile(new URL('package.json', `file://${ROOT}`),
        'utf8')
    const version = JSON.parse(text).version
    if (typeof version !== 'string') {
        throw new Error('package.json has no string version')
    }
    return version
}

// Writes dist/THIRD_PARTY_LICENSES.txt from the metafile (spec 15, 2.6).
// Throws, naming the package, when a bundled package fails validation.
async function writeThirdPartyNotices (metafile:Metafile):Promise<void> {
    const dirs = bundledPackageDirs(metafile, 'dist/cli.js')
        .map(dir => resolve(ROOT, dir))
    const notices = renderNotices(readBundledPackages(dirs),
        path => readFileSync(path, 'utf8'))
    await writeFile(new URL('dist/THIRD_PARTY_LICENSES.txt',
        `file://${ROOT}`), notices)
}

async function bundleCli ():Promise<void> {
    const dist = new URL('dist/', `file://${ROOT}`)
    await rm(dist, { recursive:true, force:true })
    await mkdir(dist, { recursive:true })

    const version = await packageVersion()
    const commit = git(['rev-parse', '--short=7', 'HEAD'])
    const date = git(['log', '-1', '--format=%cI'])

    const result = await build({
        ...baseOptions(),
        entryPoints:['src/cli.ts'],
        outfile:'dist/cli.js',
        tsconfig:'tsconfig.build.json',
        metafile:true,
        banner:{ js:`${SHEBANG}\n${REQUIRE_SHIM}` },
        define:{
            __ROAST_VERSION__:JSON.stringify(version),
            __ROAST_COMMIT__:JSON.stringify(commit),
            __ROAST_DATE__:JSON.stringify(date),
        },
    })
    const metafile = result.metafile
    if (!metafile) throw new Error('esbuild returned no metafile')
    await writeFile(new URL('meta.json', dist), JSON.stringify(metafile))
    await writeThirdPartyNotices(metafile)
    await chmod(new URL('cli.js', dist), 0o755)
}

async function bundleTests (entry:string, outfile:string):Promise<void> {
    await build({
        ...baseOptions(),
        entryPoints:[entry],
        outfile,
        tsconfig:'tsconfig.json',
        banner:{ js:REQUIRE_SHIM },
    })
}

async function main ():Promise<void> {
    const mode = parseMode(process.argv.slice(2))
    if (mode.kind === 'cli') return bundleCli()
    if (mode.kind === 'test') {
        return bundleTests('test/index.ts', 'test/test-bundle.js')
    }
    if (mode.kind === 'test-file') {
        return bundleTests(mode.file, mode.outfile)
    }
    return bundleTests('test/live/index.ts', 'test/live-bundle.js')
}

try {
    await main()
} catch (err) {
    // esbuild has already printed its own diagnostics for build errors.
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
}
