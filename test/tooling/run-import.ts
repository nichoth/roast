import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import { ROOT, run } from '../helpers/spawn.js'

// Bundles an entry that only imports src/cli/run.ts, runs it, and expects
// no output and a clean exit: the module must have no side effects.
test('importing src/cli/run.ts executes nothing', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'roast-run-import-'))
    const outfile = join(dir, 'import-run.mjs')
    const script = `
        import { build } from 'esbuild'
        await build({
            absWorkingDir:${JSON.stringify(ROOT)},
            stdin:{
                contents:"import * as m from './src/cli/run.ts'\\n" +
                    "globalThis.__roastRun = m",
                resolveDir:${JSON.stringify(ROOT)},
                loader:'ts',
            },
            outfile:${JSON.stringify(outfile)},
            bundle:true,
            platform:'node',
            format:'esm',
            mainFields:['module', 'main'],
            loader:{ '.tmpl':'text', '.md':'text', '.sh':'text' },
            banner:{ js:"import { createRequire as __r } from 'node:module'" +
                '\\nconst require = __r(import.meta.url)' },
            logLevel:'error',
        })
    `
    try {
        const built = await run(process.execPath,
            ['--input-type=module', '-e', script])
        t.equal(built.code, 0, 'the import-only entry bundles')
        const res = await run(process.execPath, [outfile, '--version'])
        t.equal(res.code, 0, 'exits 0')
        t.equal(res.stdout, '', 'writes nothing to stdout')
        t.equal(res.stderr, '', 'writes nothing to stderr')
    } finally {
        await rm(dir, { recursive:true, force:true })
    }
})
