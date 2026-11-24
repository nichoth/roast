import { mkdir, writeFile, readFile, chmod, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { buildBundle, verifyBundle } from '../../src/runbundle/bundle.js'

export function sha256 (data:Uint8Array):string {
    return createHash('sha256').update(data).digest('hex')
}

test('bundles bind exact bytes independent of location and metadata',
    async t => {
        const repo = recordRepo(t)
        const paths = [join(repo.dir, 'one'), join(repo.dir, 'two')]
        const results = []
        for (const [i, dir] of paths.entries()) {
            await mkdir(dir)
            await writeFile(join(dir, 'z'), Buffer.from([255, 0, 128]))
            await writeFile(join(dir, 'a'), 'abc')
            await chmod(join(dir, 'a'), i === 0 ? 0o644 : 0o600)
            await utimes(join(dir, 'a'), i + 100, i + 100)
            await writeFile(join(dir, 'skip.tmp'), 'skip')
            await writeFile(join(dir, '.tmp'), 'skip')
            await mkdir(join(dir, 'subdir'))
            results.push(await buildBundle(dir))
        }
        const bytes = await readFile(results[0].path)
        t.ok((bytes[4] & 4) !== 0, 'zstd frame carries content checksum')
        t.deepEqual(bytes, await readFile(results[1].path), 'identical bytes')
        t.equal(results[0].sha256, sha256(bytes), 'digest binds archive bytes')
        t.equal(results[0].sha256, results[1].sha256, 'identical digest')
        t.equal(results[0].size, bytes.length, 'size binds archive bytes')
        t.equal(results[0].size, results[1].size, 'identical size')
        const manifest = await verifyBundle(results[0].path)
        t.deepEqual(manifest.files, [
            {
                path:'a',
                sha256:'ba7816bf8f01cfea414140de5dae2223b0' +
                    '0361a396177a9cb410ff61f20015ad',
                size:3
            },
            { path:'z', sha256:sha256(Buffer.from([255, 0, 128])), size:3 },
        ], 'manifest inventory is sorted and binds original bytes')
    })
