import * as fs from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { verifyBundle } from '../../src/runbundle/bundle.js'
import { writeTar, readTar } from '../../src/runbundle/tar.js'
import { checksum } from './tar.js'

const hash =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const entry = { path:'a', sha256:hash, size:3 }
const manifest = { format:'roast-run-bundle', version:1, files:[entry] }

export function archive (text = JSON.stringify(manifest)):Buffer {
    return writeTar([
        { name:'a', data:Buffer.from('abc') },
        { name:'bundle-manifest.json', data:Buffer.from(text) },
    ])
}

test('verify rejects malformed manifests and inventories', t => {
    const repo = recordRepo(t)
    const path = join(repo.dir, 'bundle')
    const cases:unknown[] = [
        { ...manifest, files:[{ ...entry, sha256:'0'.repeat(64) }] },
        { Format:manifest.format, version:1, files:[entry] },
        { ...manifest, extra:true },
        { ...manifest, files:[{ ...entry, extra:true }] },
        { ...manifest, files:[{ ...entry, Path:'a' }] },
        { ...manifest, files:[{ ...entry, size:'3' }] },
        { ...manifest, files:[{ ...entry, path:3 }] },
        { ...manifest, files:[{ ...entry, sha256:123 }] },
        { ...manifest, files:[null] },
        { ...manifest, files:[{ ...entry, size:4 }] },
        { ...manifest, files:[{ ...entry, path:'missing' }] },
        { ...manifest, files:[{ ...entry, sha256:hash.toUpperCase() }] },
        { ...manifest, files:[] },
        { ...manifest, files:[{ ...entry, path:'../a' }] },
        { ...manifest, version:2 },
        { ...manifest, format:'other' },
    ]
    for (const [i, value] of cases.entries()) {
        fs.writeFileSync(path,
            zstdCompressSync(archive(JSON.stringify(value))))
        t.throws(() => verifyBundle(path), undefined, 'reject case ' + i)
    }
    for (const text of [
        JSON.stringify(manifest) + '{}',
        JSON.stringify(manifest).replace('"version":1', '"version":1.0'),
        JSON.stringify(manifest).replace('"size":3', '"size":3e0'),
    ]) {
        fs.writeFileSync(path, zstdCompressSync(archive(text)))
        t.throws(() => verifyBundle(path), /manifest/,
            'reject invalid JSON type')
    }
})

test('verify checks tar framing, PAX, entry types and duplicates', t => {
    const repo = recordRepo(t)
    const path = join(repo.dir, 'bundle')
    const check = (tar:Buffer):void => {
        fs.writeFileSync(path, zstdCompressSync(tar))
        t.throws(() => verifyBundle(path), undefined, 'malformed tar rejected')
    }
    const invalidChecksum = archive()
    invalidChecksum[0] = 98
    check(invalidChecksum)
    const gnu = archive()
    gnu[156] = 76
    checksum(gnu)
    check(gnu)
    for (const body of ['99 path=a\n', '0 path=a\n',
        '10 path=a!', '10 path:a\n', 'x path=a\n']) {
        const pax = writeTar([{ name:'pax', data:Buffer.from(body) }])
        pax[156] = 120
        checksum(pax)
        check(Buffer.concat([pax.subarray(0, 1024), archive()]))
    }
    const duplicate = archive()
    check(Buffer.concat([duplicate.subarray(0, -1024), duplicate]))
    check(writeTar([{ name:'a', data:Buffer.from('abc') }]))
    check(archive().subarray(0, 520))
    const prefix = archive()
    prefix.write('parent', 345)
    checksum(prefix)
    check(prefix)
    for (const name of ['..', '.', '../a', 'a/b', 'a\\b']) {
        const badName = archive()
        badName.fill(0, 0, 100)
        badName.write(name, 0)
        checksum(badName)
        check(badName)
    }
    const legacy = archive()
    legacy[156] = 0
    checksum(legacy)
    fs.writeFileSync(path, zstdCompressSync(legacy))
    t.equal(verifyBundle(path).files?.[0].path, 'a', 'NUL type accepted')
})

test('verify rejects duplicate manifests, oversized manifests and order',
    t => {
        const repo = recordRepo(t)
        const path = join(repo.dir, 'bundle')
        const manifestFile = (text:string) => ({
            name:'bundle-manifest.json', data:Buffer.from(text),
        })
        const cases = [
            writeTar([manifestFile('{}'), manifestFile('{}')]),
            writeTar([manifestFile(' '.repeat(1048577))]),
            writeTar([
                { name:'b', data:Buffer.from('abc') },
                { name:'a', data:Buffer.from('abc') },
                manifestFile(JSON.stringify({
                    ...manifest,
                    files:[
                        { ...entry, path:'b' }, entry,
                    ]
                })),
            ]),
        ]
        for (const tar of cases) {
            fs.writeFileSync(path, zstdCompressSync(tar))
            t.throws(() => verifyBundle(path), undefined, 'invalid inventory')
        }
        for (const name of ['__proto__', 'constructor', 'toString']) {
            const tar = writeTar([
                { name, data:Buffer.from('abc') },
                manifestFile(JSON.stringify({
                    ...manifest,
                    files:[{ ...entry, path:name }]
                })),
            ])
            fs.writeFileSync(path, zstdCompressSync(tar))
            t.equal(verifyBundle(path).files?.[0].path, name,
                'ordinary object-property names remain valid paths')
        }
        fs.writeFileSync(path, zstdCompressSync(writeTar([
            manifestFile(JSON.stringify({
                format:'roast-run-bundle', version:1, files:null,
            })),
        ])))
        t.equal(verifyBundle(path).files, null, 'empty inventory is null')
    })

test('tar accepts signed checksums and consumes global PAX records', t => {
    const tar = archive()
    tar[265] = 255
    checksum(tar)
    const unsigned = parseInt(tar.subarray(148, 154).toString(), 8)
    tar.write((unsigned - 256).toString(8).padStart(6, '0') + '\0 ', 148)
    t.equal(readTar(tar)[0].name, 'a', 'signed checksum accepted')
    const global = writeTar([{
        name:'global',
        data:Buffer.from('10 path=z\n')
    }])
    global[156] = 103
    checksum(global)
    const combined = Buffer.concat([global.subarray(0, -1024), archive()])
    t.equal(readTar(combined)[0].name, 'a', 'global path ignored')
})
