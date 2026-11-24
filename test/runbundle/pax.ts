import * as fs from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { buildBundle, verifyBundle } from '../../src/runbundle/bundle.js'
import { readTar } from '../../src/runbundle/tar.js'

test('bundle preserves long and Unicode names through PAX extensions', t => {
    const repo = recordRepo(t)
    const names = ['a'.repeat(150), 'caf\u00e9.txt', '\ue000', '\u{10000}']
    for (const name of names) fs.writeFileSync(join(repo.dir, name), 'data')
    const result = buildBundle(repo.dir)
    const manifest = verifyBundle(result.path)
    t.deepEqual(manifest.files?.map(f => f.path), names,
        'manifest uses UTF-8 byte order including supplementary characters')
    const tar = zstdDecompressSync(fs.readFileSync(result.path))
    t.deepEqual(readTar(tar).map(f => f.name),
        [names[0], 'bundle-manifest.json', ...names.slice(1)], 'full names')
    let offset = 0
    let count = 0
    while (!tar.subarray(offset, offset + 512).every(b => b === 0)) {
        const size = parseInt(tar.subarray(offset + 124, offset + 135)
            .toString(), 8)
        if (tar[offset + 156] === 120) {
            const record = tar.subarray(offset + 512, offset + 512 + size)
            const length = Number(record.subarray(0, record.indexOf(32)))
            t.equal(length, record.length,
                'PAX self length counts UTF-8 bytes')
            t.equal(record[record.length - 1], 10, 'PAX newline terminator')
            count++
        }
        offset += 512 + Math.ceil(size / 512) * 512
    }
    t.equal(count, 4, 'one extension per long or non-ASCII path')
})
