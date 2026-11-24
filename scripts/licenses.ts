// Third-party notices for the bundle (spec 15, 2.6). A pure library with
// no top-level side effects, so the test bundle can import it; the bundle
// step (scripts/bundle.ts) calls it. Run directly by Node (type
// stripping), so only erasable TypeScript syntax is allowed here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Metafile } from 'esbuild'

// The licenses a bundled package may declare: the list the Go CI passed
// to go-licenses.
export const ALLOWED_LICENSES:readonly string[] = [
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MIT',
    'MPL-2.0',
    'Unlicense',
]

export interface BundledPackage {
    name:string;
    version:string;
    license:string;
    repository:string|null;
    dir:string;
    licenseFiles:string[];
}

const NODE_MODULES = 'node_modules/'

// The package root of a path inside node_modules: the prefix up to and
// including the package name after the last `node_modules/` segment.
function packageRoot (path:string):string|null {
    const posix = path.replaceAll('\\', '/')
    const at = posix.lastIndexOf(NODE_MODULES)
    if (at === -1) return null
    if (at > 0 && posix[at - 1] !== '/') return null
    const start = at + NODE_MODULES.length
    const segments = posix.slice(start).split('/')
    const nameSegments = segments[0]?.startsWith('@') ? 2 : 1
    if (segments.length <= nameSegments) return null
    const name = segments.slice(0, nameSegments).join('/')
    return posix.slice(0, start) + name
}

// The package root directories of every node_modules input that put code
// into `outfile`, in first-seen order.
export function bundledPackageDirs (
    metafile:Metafile,
    outfile:string
):string[] {
    const output = metafile.outputs[outfile]
    if (!output) throw new Error(`the metafile has no output ${outfile}`)
    const dirs = new Set<string>()
    for (const [path, input] of Object.entries(output.inputs)) {
        if (input.bytesInOutput <= 0) continue
        const root = packageRoot(path)
        if (root !== null) dirs.add(root)
    }
    return [...dirs]
}

// Spec 15 2.6 gives `(\..*)?` after the base name; `-` is accepted too
// because bundled packages ship `LICENSE-MIT.txt` (emoji-regex, via
// yargs) as their only license file.
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

function readManifest (dir:string):Record<string, unknown> {
    const path = join(dir, 'package.json')
    const parsed:unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null ||
        Array.isArray(parsed)) {
        throw new Error(`${path} is not a JSON object`)
    }
    return parsed as Record<string, unknown>
}

// The SPDX identifiers in a license expression, split on parentheses
// and the OR, AND, and WITH operators.
function licenseIdentifiers (expression:string):string[] {
    return expression
        .split(/[()]| OR | AND | WITH /)
        .map(part => part.trim())
        .filter(part => part !== '')
}

function repositoryUrl (value:unknown):string|null {
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value !== null &&
        typeof (value as { url?:unknown }).url === 'string') {
        return (value as { url:string }).url
    }
    return null
}

function readPackage (dir:string):BundledPackage {
    const manifest = readManifest(dir)
    const name = manifest.name
    const version = manifest.version
    if (typeof name !== 'string' || typeof version !== 'string') {
        throw new Error(`${join(dir, 'package.json')} has no name or version`)
    }
    const id = `${name}@${version}`
    const license = manifest.license
    if (typeof license !== 'string' || license.trim() === '') {
        throw new Error(`${id} (${dir}) declares no license field`)
    }
    const disallowed = licenseIdentifiers(license)
        .filter(spdx => !ALLOWED_LICENSES.includes(spdx))
    if (disallowed.length > 0) {
        throw new Error(`${id} (${dir}) declares license ${
            JSON.stringify(license)}, which is not in the allowlist (${
            ALLOWED_LICENSES.join(', ')})`)
    }
    const licenseFiles = readdirSync(dir, { withFileTypes:true })
        .filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .map(file => join(dir, file))
    if (licenseFiles.length === 0) {
        throw new Error(`${id} (${dir}) ships no license file`)
    }
    return {
        name,
        version,
        license,
        repository:repositoryUrl(manifest.repository),
        dir,
        licenseFiles,
    }
}

// Reads each package directory, deduplicating by name@version.
export function readBundledPackages (dirs:string[]):BundledPackage[] {
    const seen = new Map<string, BundledPackage>()
    for (const dir of dirs) {
        const pkg = readPackage(dir)
        const key = `${pkg.name}@${pkg.version}`
        if (!seen.has(key)) seen.set(key, pkg)
    }
    return [...seen.values()]
}

const RULE = '='.repeat(78)

const HEADER = [
    'Third-party software bundled in dist/cli.js',
    '',
    "Roast's npm package bundles the following packages. Each entry gives " +
        'the',
    'package, its declared license, and the license text it ships.',
].join('\n')

function compareStrings (a:string, b:string):number {
    return a < b ? -1 : a > b ? 1 : 0
}

// Orders versions part by part, numerically where both parts are
// numbers, so 2.0.0 sorts before 10.0.0.
function compareVersions (a:string, b:string):number {
    const left = a.split(/[.+-]/)
    const right = b.split(/[.+-]/)
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const x = left[i] as string
        const y = right[i] as string
        const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
        const order = numeric ? Number(x) - Number(y) : compareStrings(x, y)
        if (order !== 0) return order
    }
    return left.length - right.length || compareStrings(a, b)
}

// Renders dist/THIRD_PARTY_LICENSES.txt: packages sorted by name then
// version, each with its license field, repository, and license texts.
export function renderNotices (
    packages:BundledPackage[],
    readFile:(path:string) => string
):string {
    const sorted = [...packages].sort((a, b) =>
        compareStrings(a.name, b.name) ||
        compareVersions(a.version, b.version))
    const sections = sorted.map(pkg => {
        const head = [`${pkg.name}@${pkg.version}`, `License: ${pkg.license}`]
        if (pkg.repository !== null) {
            head.push(`Repository: ${pkg.repository}`)
        }
        const texts = pkg.licenseFiles.map(file => readFile(file).trim())
        return `${RULE}\n${head.join('\n')}\n\n${texts.join('\n\n')}`
    })
    return [HEADER, ...sections].join('\n\n') + '\n'
}
