// Run the entries in test/index.ts in isolated, bounded child processes.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { ROOT, baseOptions } from './esbuild-options.ts'

const shim = [
    "import { createRequire as __roastRequire } from 'node:module'",
    'const require = __roastRequire(import.meta.url)',
].join('\n')

async function execute (files:string[], number:number):Promise<boolean> {
    const bundle = resolve(ROOT, 'test', `.group-${randomUUID()}.js`)
    try {
        await build({
            ...baseOptions(),
            stdin:{
                contents:files.map(file => `import ${JSON.stringify(file)}`)
                    .join('\n'),
                resolveDir:ROOT,
                loader:'ts',
            },
            outfile:bundle,
            tsconfig:'tsconfig.json',
            banner:{ js:shim },
        })
        const child = spawn(process.execPath, [bundle], {
            cwd:ROOT, stdio:['ignore', 'pipe', 'pipe'],
        })
        const reporter = spawn(process.execPath,
            [resolve(ROOT, 'node_modules/tap-spec/bin/cmd.js')], {
                cwd:ROOT, stdio:['pipe', 'pipe', 'pipe'],
            })
        let output = ''
        child.stdout.pipe(reporter.stdin)
        child.stderr.on('data', chunk => { output += chunk })
        reporter.stdout.on('data', chunk => { output += chunk })
        reporter.stderr.on('data', chunk => { output += chunk })
        const wait = (proc:ChildProcess) => new Promise<boolean>(resolve => {
            proc.on('error', () => resolve(false))
            proc.on('close', code => resolve(code === 0))
        })
        const results = await Promise.all([wait(child), wait(reporter)])
        console.log(`\n--- group ${number}: ${files.join(', ')} ---\n${output}`)
        return results.every(Boolean)
    } catch (err) {
        console.error(`group ${number}:`, err)
        return false
    } finally {
        await rm(bundle, { force:true })
    }
}

async function main ():Promise<void> {
    const arg = process.env.ROAST_TEST_WORKERS
    if (arg !== undefined && (!/^\d+$/.test(arg) || Number(arg) < 1 ||
        !Number.isSafeInteger(Number(arg)))) {
        throw new Error('ROAST_TEST_WORKERS must be a positive integer')
    }
    const workers = arg ? Number(arg) : Math.min(4, availableParallelism())
    const args = process.argv.slice(2)
    let groups:string[][]
    if (args.length) {
        groups = args.map(file => [resolve(file)])
    } else {
        const index = await readFile(resolve(ROOT, 'test/index.ts'), 'utf8')
        const imports = [...index.matchAll(/^import '(.+\.js)'$/gm)]
            .map(match => resolve(ROOT, 'test',
                match[1].replace(/\.js$/, '.ts')))
        if (!imports.length) throw new Error('no test imports found')
        groups = Array.from({ length:Math.min(imports.length, 16) }, () => [])
        imports.forEach((file, i) => groups[i % groups.length].push(file))
    }
    let next = 0
    let failed = false
    await Promise.all(Array.from({ length:Math.min(workers, groups.length) },
        async () => {
            while (next < groups.length) {
                const i = next++
                if (!await execute(groups[i], i + 1)) failed = true
            }
        }))
    if (failed) process.exitCode = 1
}

try {
    await main()
} catch (err) {
    console.error(err)
    process.exitCode = 1
}
