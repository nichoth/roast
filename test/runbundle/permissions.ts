import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { baseOptions } from '../../scripts/esbuild-options.ts'
import type * as Esbuild from 'esbuild'
import { zstdDecompressSync } from 'node:zlib'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'

const source = resolve('src/runbundle/bundle.ts')
const { buildSync } = createRequire(import.meta.url)('esbuild') as
    typeof Esbuild

test('private directory, bundle, tar modes and live lock mode', async t => {
    const repo = recordRepo(t)
    const dir = join(repo.dir, 'run')
    fs.mkdirSync(dir, { mode:0o755 })
    fs.writeFileSync(join(dir, 'large'), Buffer.alloc(32 * 1024 ** 2, 97))
    const worker = join(repo.dir, 'worker.mjs')
    buildSync({
        stdin:{
            contents:`import { buildBundle } from ${JSON.stringify(source)};
            buildBundle(process.argv[2]);`,
            resolveDir:repo.dir
        },
        ...baseOptions(),
        outfile:worker,
        banner:{
            js:"import { createRequire } from 'node:module';" +
            'const require = createRequire(import.meta.url);'
        },
    })
    let lockMode:number|undefined
    const watcher = fs.watch(dir, (_event, name) => {
        if (name !== 'bundle.tar.zst.tmp') return
        try {
            lockMode = fs.statSync(join(dir, name)).mode & 0o777
        } catch { /* The rename event may arrive after publication. */ }
    })
    t.cleanup(() => watcher.close())
    const child = spawn(process.execPath, [worker, dir], { stdio:'pipe' })
    let stderr = ''
    child.stderr.on('data', data => { stderr += String(data) })
    const code = await new Promise<number|null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
    })
    t.equal(code, 0, stderr)
    t.equal(lockMode, 0o600, 'observed live exclusive lock mode')
    t.equal(fs.statSync(dir).mode & 0o777, 0o700, 'directory protected')
    const bundle = join(dir, 'bundle.tar.zst')
    t.equal(fs.statSync(bundle).mode & 0o777, 0o600, 'bundle protected')
    const tar = zstdDecompressSync(fs.readFileSync(bundle))
    let offset = 0
    let count = 0
    while (tar[offset] !== 0) {
        t.equal(tar.subarray(offset + 100, offset + 108).toString(),
            '0000600\0', 'regular entry private')
        const size = parseInt(tar.subarray(offset + 124, offset + 135)
            .toString(), 8)
        offset += 512 + Math.ceil(size / 512) * 512
        count++
    }
    t.equal(count, 2, 'artifact and manifest checked')
})
