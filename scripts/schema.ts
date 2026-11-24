// Regenerates roast.schema.json (in the working directory) from the zod
// config schema (spec 15, 2.7). It bundles src/config/json-schema.ts,
// imports the bundle, and writes the file only when its content changed.
// Run directly by Node (type stripping), so only erasable TypeScript
// syntax is allowed here.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { ROOT, baseOptions } from './esbuild-options.ts'

const OUTFILE = join(ROOT, 'node_modules', '.cache', 'roast', 'schema.mjs')

async function readOrEmpty (file:string):Promise<string> {
    try {
        return await readFile(file, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw err
    }
}

async function main ():Promise<void> {
    await mkdir(join(ROOT, 'node_modules', '.cache', 'roast'),
        { recursive:true })
    await build({
        ...baseOptions(),
        entryPoints:['src/config/json-schema.ts'],
        outfile:OUTFILE,
        tsconfig:'tsconfig.json',
    })
    // A query string defeats the module cache if this ever runs twice in
    // one process.
    const mod = await import(`${pathToFileURL(OUTFILE).href}?t=${Date.now()}`)
    const text:string = mod.renderProjectSchema()
    const target = resolve(process.cwd(), 'roast.schema.json')
    if (await readOrEmpty(target) === text) {
        console.log('roast.schema.json is up to date')
        return
    }
    await writeFile(target, text)
    console.log('roast.schema.json regenerated')
}

try {
    await main()
} catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
}
