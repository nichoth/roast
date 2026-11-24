import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type * as Esbuild from 'esbuild'
import { baseOptions } from '../../scripts/esbuild-options.ts'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { run } from '../helpers/spawn.js'

const source = resolve('src/runbundle/bundle.ts')
const fixture = resolve('test/runbundle/fixtures/go-bundle.tar.zst')
const { buildSync } = createRequire(import.meta.url)('esbuild') as
    typeof Esbuild

test('standalone build and verify suppress only zstd experimental warnings',
    async t => {
        const repo = recordRepo(t)
        const worker = join(repo.dir, 'worker.mjs')
        buildSync({
            ...baseOptions(),
            outfile:worker,
            stdin:{
                contents:`
                import { buildBundle, verifyBundle }
                    from ${JSON.stringify(source)};
                if (process.argv[2] === 'build') {
                    const result = buildBundle(process.argv[3]);
                    verifyBundle(result.path);
                } else verifyBundle(process.argv[3]);
                // Exercise the filter even on Node versions where zstd
                // is stable and no longer emits its experimental warning.
                process.emitWarning('zstd', 'ExperimentalWarning');
                process.emitWarning('unrelated', 'ControlWarning');
            `,
                resolveDir:repo.dir
            },
            banner:{
                js:"import { createRequire } from 'node:module';" +
                'const require = createRequire(import.meta.url);'
            },
        })
        for (const mode of ['build', 'verify']) {
            const dir = join(repo.dir, mode)
            fs.mkdirSync(dir)
            fs.writeFileSync(join(dir, 'a'), 'abc')
            const result = await run(process.execPath,
                [worker, mode, mode === 'build' ? dir : fixture],
                { cwd:repo.dir })
            t.equal(result.code, 0, mode + ' process succeeded')
            t.ok(!result.stderr.includes('ExperimentalWarning'),
                mode + ' emits no experimental warning')
            t.ok(result.stderr.includes('ControlWarning'),
                mode + ' retains unrelated warning')
        }
    })
