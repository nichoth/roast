// Tests for src/runbundle/tar.ts \u2014 ustar writer and reader.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from '../helpers/test.js'
import type { TarFile } from '../../src/runbundle/tar.js'
import { writeTar, readTar } from '../../src/runbundle/tar.js'

test('writeTar with one file produces correct ustar header', t => {
    const files:TarFile[] = [{
        name:'meta.json',
        data:Buffer.from('metadata\n')
    }]
    const archive = writeTar(files)

    // A 9-byte file should produce a 2048-byte tar (1 \u00d7 512 header +
    // padding).
    t.equal(archive.length, 2048, 'total size is 2048 bytes')

    // The checksum field should be `011006\0 ` (unsigned sum of header with
    // chksum as spaces).
    const chksumBytes = archive.slice(148, 156)
    const chksumStr = chksumBytes.toString().split('\0').join('').slice(0, 6)
    t.equal(chksumStr, '011006', 'checksum')
    t.equal(chksumBytes[6], 0x00, 'checksum byte 7 is NUL')
    t.equal(chksumBytes[7], 0x20, 'checksum byte 8 is space')

    // Size field should be `00000000011\0` (9 in octal).
    const sizeBytes = archive.slice(124, 136)
    const sizeStr = sizeBytes.toString().replace(/\0/g, '')
    t.equal(sizeStr, '00000000011', 'size is octal 9')

    // Name field: 'meta.json' NUL-padded.
    const nameBuf = archive.slice(0, 9)
    t.equal(nameBuf.toString(), 'meta.json', 'name bytes are correct')

    // Mode: `0000600\0` at offset 100.
    const modeBytes = archive.slice(100, 108)
    t.equal(modeBytes.toString(), '0000600\0', 'mode is 0000600')

    // Typeflag: `0` at byte 156.
    t.equal(archive[156], 0x30, 'typeflag is 0')

    // Magic: `ustar\0` at byte 257.
    t.equal(archive.slice(257, 263).toString(), 'ustar\x00', 'magic is ustar')

    // Version: '00' at byte 263.
    t.equal(archive.slice(263, 265).toString(), '00', 'version is 00')

    // After the header (512 bytes) comes data + padding to 2048.
    const dataStart = 512
    t.equal(archive.slice(dataStart, dataStart + 9).toString(), 'metadata\n',
        'data bytes match')
    // Remaining bytes should be zero (padding).
    t.deepEqual(archive.subarray(dataStart + 9),
        Buffer.alloc(archive.length - dataStart - 9), 'all padding is zero')

    // Two zero blocks at the end.
    const endOffset = archive.length - 1024
    for (let i = endOffset; i < archive.length; i++) {
        if (archive[i] !== 0) t.fail(`byte ${i} should be zero`)
    }
})

test('readTar round-trips a simple file', t => {
    const files:TarFile[] = [
        { name:'meta.json', data:Buffer.from('metadata\n') },
    ]
    const archive = writeTar(files)
    const entries = readTar(archive)

    t.equal(entries.length, 1, 'one entry')
    t.equal(entries[0].name, 'meta.json', 'name matches')
    t.equal(entries[0].typeflag, '0', 'typeflag is regular file')
    t.deepEqual(entries[0].data, Buffer.from('metadata\n'), 'data matches')

    // Verify the data size.
    t.equal(entries[0].size, 9, 'size matches')
})

test('readTar round-trips multiple files', t => {
    const files:TarFile[] = [
        { name:'a.txt', data:Buffer.from('aaa') },
        { name:'b.txt', data:Buffer.from('bb') },
        { name:'c.txt', data:Buffer.from('ccc') },
    ]
    const archive = writeTar(files)
    const entries = readTar(archive)

    t.equal(entries.length, 3, 'three entries')
    t.deepEqual(entries[0].data, Buffer.from('aaa'), 'a.txt')
    t.deepEqual(entries[1].data, Buffer.from('bb'), 'b.txt')
    t.deepEqual(entries[2].data, Buffer.from('ccc'), 'c.txt')
})

test('writeTar rejects files at the 8 GiB boundary before reading', t => {
    // A typed array subclass exposes the boundary without allocating GiB.
    class HugeData extends Uint8Array {
        get length ():number { return 8 * 1024 ** 3 }
    }
    t.throws(() => writeTar([{
        name:'big.bin', data:new HugeData(0),
    }]), /8 GiB/, 'rejects the boundary before accessing data')
})

test('readTar returns entries with correct typeflags', t => {
    const files:TarFile[] = [{ name:'f.txt', data:Buffer.from('x') }]
    const archive = writeTar(files)
    const entries = readTar(archive)

    t.equal(entries[0].typeflag, '0', 'typeflag is "0"')
})

test('readTar accepts NUL typeflag as regular file (legacy)', t => {
    // Build a minimal tar with a NUL typeflag at offset 156.
    const data = Buffer.from('x')
    const archive = writeTar([{ name:'nul.txt', data }])

    // Modify the typeflag to NUL (0x00).
    archive[156] = 0x00
    checksum(archive)

    const entries = readTar(archive)
    t.equal(entries.length, 1, 'one entry')
    t.deepEqual(entries[0].data, data, 'data matches with NUL typeflag')
})

test('writeTar with long file name produces PAX path record', t => {
    const longName = 'a'.repeat(150) + '.txt'
    const files:TarFile[] = [{
        name:longName,
        data:Buffer.from('long content')
    }]
    const archive = writeTar(files)

    // Decompress should not be needed; this tests the raw tar output.
    const entries = readTar(archive)
    t.equal(entries.length, 1, 'one entry')
    t.equal(entries[0].name, longName, 'full long name is preserved')
})

test('writeTar with non-ASCII file name produces PAX path record', t => {
    const files:TarFile[] = [{
        name:'caf\u00e9.txt',
        data:Buffer.from('non-ascii\n')
    }]
    const archive = writeTar(files)

    const entries = readTar(archive)
    t.equal(entries.length, 1, 'one entry')
    t.equal(entries[0].name, 'caf\u00e9.txt',
        'full non-ASCII name is preserved')
})

test('writeTar with multi-byte UTF-8 characters in PAX records', t => {
    const files:TarFile[] = [{
        name:'\u65e5\u672c\u8a9e.txt',
        data:Buffer.from('japanese\n')
    }]
    const archive = writeTar(files)

    const entries = readTar(archive)
    t.equal(entries.length, 1, 'one entry')
    t.equal(entries[0].name, '\u65e5\u672c\u8a9e.txt',
        'full multi-byte name is preserved')
})

test('writeTar matches Go fixtures including PAX lengths', t => {
    for (const [label, name, data] of [
        ['meta', 'meta.json', 'metadata\n'],
        ['long', 'a'.repeat(150), 'long content'],
        ['unicode', 'caf\u00e9.txt', 'non-ascii\n'],
    ]) {
        const expected = readFileSync(resolve(
            'test/runbundle/fixtures', label + '.tar',
        ))
        t.deepEqual(writeTar([{ name, data:Buffer.from(data) }]),
            expected, label + ' complete tar bytes match Go')
    }
})

export function checksum (archive:Buffer):void {
    archive.fill(32, 148, 156)
    const sum = archive.subarray(0, 512).reduce((a, b) => a + b, 0)
    archive.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
}

test('readTar handles two zero blocks at end of archive', t => {
    const files:TarFile[] = [
        { name:'only.txt', data:Buffer.from('x') },
    ]
    const archive = writeTar(files)

    const entries = readTar(archive)
    t.equal(entries.length, 1, 'one entry from a properly terminated archive')
})

test('writeTar with empty data produces correct padding', t => {
    const files:TarFile[] = [{ name:'empty.dat', data:Buffer.alloc(0) }]
    const archive = writeTar(files)

    // A 0-byte file: 512 header + no data padding + 1024 zero blocks = 1536.
    t.equal(archive.length, 1536, 'empty data needs no padding block')

    const entries = readTar(archive)
    t.equal(entries.length, 1, 'one entry')
    t.equal(entries[0].size, 0, 'size is 0')
    t.deepEqual(entries[0].data, Buffer.alloc(0), 'empty data')
})

test('writeTar with exact 512-byte file produces correct layout', t => {
    const files:TarFile[] = [{ name:'exact.bin', data:Buffer.alloc(512, 'x') }]
    const archive = writeTar(files)

    // 512 header + 512 data (no padding) + 1024 zero blocks = 2048.
    t.equal(archive.length, 2048, 'total size is 2048 bytes')

    const entries = readTar(archive)
    t.equal(entries[0].size, 512, 'size matches')
    t.ok(Buffer.from(entries[0].data).every(b => b === 0x78),
        'all data bytes are x')
})

// The ticket's public writer example accepts text as well as raw bytes.
test('writeTar encodes text data as UTF-8 bytes', t => {
    const tar = writeTar([{ name:'meta.json', data:'metadata\n' }])
    const fixture = readFileSync(resolve('test/runbundle/fixtures/meta.tar'))
    t.deepEqual(tar, fixture, 'ticket text example equals Go fixture')
    const entries = readTar(writeTar([{ name:'text', data:'caf\u00e9' }]))
    t.equal(entries[0].size, 5, 'UTF-8 byte length in header')
    t.deepEqual(entries[0].data, Buffer.from('caf\u00e9'), 'text bytes')
})
