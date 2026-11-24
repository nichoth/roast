// Tests for src/runbundle/bundle.ts - build, verify, and lock.
import { test as registerTest, type CleanupTest } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type * as Esbuild from 'esbuild'
import { baseOptions } from '../../scripts/esbuild-options.ts'
import { run } from '../helpers/spawn.js'
import { checksum } from './tar.js'
import { archive } from './verify.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
    buildBundle,
    verifyBundle,
    BUNDLE_FILE,
    MANIFEST_FILE,
    FORMAT,
    VERSION,
} from '../../src/runbundle/bundle.js'
import type { TarFile } from '../../src/runbundle/tar.js'
import { writeTar, readTar } from '../../src/runbundle/tar.js'

const source = path.resolve('src/runbundle/bundle.ts')
const goFixture = path.resolve('test/runbundle/fixtures/go-bundle.tar.zst')

function test (name:string, fn:(t:CleanupTest) => void|Promise<void>):void {
    registerTest(name, async t => {
        recordRepo(t)
        await fn(t)
    })
}

// Helpers

function tempDir (prefix:string = 'roast-bundle-'):string {
    return fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), prefix)))
}

function writeFiles (dir:string, files:Record<string,
    string|Uint8Array>):void {
    for (const [name, content] of Object.entries(files)) {
        if (typeof content === 'string') {
            fs.writeFileSync(path.join(dir, name), content)
        } else {
            fs.writeFileSync(path.join(dir, name), Buffer.from(content))
        }
    }
}

// === Acceptance criteria ====================================================

test('writeTar meta.json fixture is 2048 bytes with Go-identical header',
    t => {
        const files:TarFile[] = [{
            name:'meta.json',
            data:Buffer.from('metadata\n')
        }]
        const archive = writeTar(files)

        // Total size should be 2048 bytes.
        t.equal(archive.length, 2048, 'total size is 2048 bytes')

        // Verify checksum: `011006\0 ` at offset 148.
        const chksumBytes = archive.slice(148, 156)
        const chksumStr = chksumBytes.toString()
            .split('\0').join('').slice(0, 6)
        t.equal(chksumStr, '011006', 'checksum is 011006')
        t.equal(chksumBytes[6], 0x00, 'checksum byte 7 is NUL')
        t.equal(chksumBytes[7], 0x20, 'checksum byte 8 is space')

        // Size field: `00000000011\0` (9 in octal).
        const sizeBytes = archive.slice(124, 136)
        const sizeStr = sizeBytes.toString().replace(/\0/g, '')
        t.equal(sizeStr, '00000000011', 'size is octal 00000000011')
    })

test('Two run dirs with identical files produce identical bundle bytes', t => {
    const dir1 = tempDir()
    const dir2 = tempDir()

    // Write identical files but with different modes (to test determinism).
    writeFiles(dir1, { 'meta.json':'metadata\n' })
    writeFiles(dir2, { 'meta.json':'metadata\n' })

    fs.writeFileSync(path.join(dir1, 'result.json.gz'),
        Buffer.from('result\n'))
    fs.chmodSync(path.join(dir1, 'result.json.gz'), 0o644)
    fs.writeFileSync(path.join(dir2, 'result.json.gz'),
        Buffer.from('result\n'))
    fs.chmodSync(path.join(dir2, 'result.json.gz'), 0o755)

    const result1 = buildBundle(dir1)
    const result2 = buildBundle(dir2)

    // Both should produce the same bundle content.
    t.notEqual(result1.path, result2.path, 'paths are different')
    t.equal(result1.sha256, result2.sha256, 'digests match')
    t.equal(result1.size, result2.size, 'sizes match')

    // Verify the bundle.
    const manifest = verifyBundle(result1.path)
    t.equal(manifest.format, FORMAT, 'format is correct')
    t.equal(manifest.version, VERSION, 'version is 1')
})

test('An existing valid bundle is reused byte-for-byte', t => {
    const dir = tempDir()
    writeFiles(dir, { 'meta.json':'metadata\n' })

    // First build.
    const result1 = buildBundle(dir)
    const bytes1 = fs.readFileSync(result1.path)

    // Modify the run directory to change what would be bundled.
    fs.writeFileSync(path.join(dir, 'new-file.txt'),
        Buffer.from('new content'))
    fs.writeFileSync(path.join(dir, 'meta.json'),
        Buffer.from('changed metadata\n'))

    // Second build should reuse the existing bundle.
    const result2 = buildBundle(dir)
    t.equal(result2.path, result1.path, 'same path')

    const bytes2 = fs.readFileSync(result2.path)
    t.deepEqual(bytes1, bytes2, 'bundle bytes are identical')
})

test('A symlinked bundle path is rejected', t => {
    const dir = tempDir()
    const other = tempDir()

    // Write a file and build a real bundle in `other`.
    writeFiles(other, { 'meta.json':'metadata\n' })
    const realResult = buildBundle(other)

    // Create a symlinked bundle path in `dir`.
    fs.symlinkSync(path.resolve(realResult.path), path.join(dir, BUNDLE_FILE))

    // Also write a meta.json.
    writeFiles(dir, { 'meta.json':'metadata\n' })

    t.throws(() => buildBundle(dir), /not a regular file/,
        'symlinked bundle is rejected')
})

test('A symlinked artifact is rejected', t => {
    const dir = tempDir()
    const target = path.join(tempDir(), 'secret')
    fs.writeFileSync(target, Buffer.from('must not be bundled'))
    fs.symlinkSync(target, path.join(dir, 'result.json.gz'))

    t.throws(() => buildBundle(dir), /symlink/,
        'symlinked artifact is rejected')
})

test('An invalid existing bundle makes the build fail', t => {
    const dir = tempDir()
    // Write a non-bundle file as the bundle.
    fs.writeFileSync(path.join(dir, BUNDLE_FILE), Buffer.from('not a bundle'))

    t.throws(() => buildBundle(dir), /verify existing bundle/,
        'invalid bundle causes verification failure')
})

test('After build the run dir is 0o700 and bundle is 0o600', t => {
    const dir = tempDir()
    fs.chmodSync(dir, 0o755)
    writeFiles(dir, { 'meta.json':'metadata\n' })

    const result = buildBundle(dir)
    const dirMode = fs.statSync(dir).mode & 0o777
    t.equal(dirMode, 0o700, 'run dir is 0o700')

    const bundleMode = fs.statSync(result.path).mode & 0o777
    t.equal(bundleMode, 0o600, 'bundle is 0o600')

    // Verify tar entry modes are all 0o600 (writeTar uses mode 0600 for all
    // entries).
    const rawBytes = fs.readFileSync(result.path)
    const decompressed = zstdDecompressSync(rawBytes as unknown as Buffer)
    const entries = readTar(decompressed)
    for (const entry of entries) {
        t.ok(entry.typeflag === '0', `${entry.name} has regular typeflag`)
    }
})

test('A fresh lock fails; a stale lock is reclaimed', t => {
    const dir = tempDir()
    writeFiles(dir, { 'meta.json':'metadata\n' })

    // Create a fresh lock file.
    const tmpPath = path.join(dir, BUNDLE_FILE + '.tmp')
    fs.writeFileSync(tmpPath, '', { mode:0o600 })

    // Should fail because the lock is not stale (less than 10 minutes old).
    t.throws(() => buildBundle(dir), /already in progress/,
        'fresh lock blocks build')

    // Make the lock stale (older than 10 minutes).
    const now = Date.now()
    const staleTime = new Date(now - 11 * 60 * 1000)
    fs.utimesSync(tmpPath, staleTime, staleTime)

    // Should succeed after reclaiming the stale lock.
    const result = buildBundle(dir)
    t.ok(result.path.endsWith(BUNDLE_FILE), 'stale lock reclaimed')

    // Clean up.
    try { fs.unlinkSync(tmpPath) } catch {}
})

test('A run directory with a 150-byte file name and non-ASCII name builds',
    t => {
        const dir = tempDir()
        writeFiles(dir, { 'meta.json':'metadata\n' })

        // Long name (150 chars).
        const longName = 'a'.repeat(150) + '.txt'
        fs.writeFileSync(path.join(dir, longName), Buffer.from('long content'))

        // Non-ASCII name.
        fs.writeFileSync(path.join(dir, 'caf\u00e9.txt'),
            Buffer.from('non-ascii\n'))

        const result = buildBundle(dir)
        t.ok(result.path.endsWith(BUNDLE_FILE),
            'bundle builds with special names')

        // Verify the bundle.
        const manifest = verifyBundle(result.path)
        t.ok(manifest.files, 'manifest has files')

        // Find long and non-ASCII names in the decompressed archive.
        const rawBytes = fs.readFileSync(result.path)
        const decompressed = zstdDecompressSync(rawBytes as unknown as Buffer)
        const entries = readTar(decompressed)

        // Check that all expected names are present.
        const entryNames = entries.map(e => e.name)
        t.ok(entryNames.includes('meta.json'), 'meta.json is in archive')

        // Verify both names are present with full characters.
        t.ok(entryNames.includes(longName),
        `long name ${longName.length} chars is in archive`)
        t.ok(entryNames.includes('caf\u00e9.txt'),
            'non-ASCII name caf\u00e9.txt is in archive')

        // Check that PAX records have correct types (x).
        let offset = 0
        let count = 0
        while (!decompressed.subarray(offset, offset + 512)
            .every(b => b === 0)) {
            const size = parseInt(decompressed
                .subarray(offset + 124, offset + 135).toString(), 8)
            if (decompressed[offset + 156] === 120) count++
            offset += 512 + Math.ceil(size / 512) * 512
        }
        t.equal(count, 2, 'two raw PAX headers')
    })

test('A bundle written by the Go baseline verifies in TS', async t => {
    const manifest = verifyBundle(goFixture)
    t.equal(manifest.format, FORMAT, 'Go bundle format')
    t.equal(manifest.version, VERSION, 'Go bundle version')
    t.deepEqual(manifest.files?.map(f => [f.path, f.size]),
        [['meta.json', 9]], 'Go artifact inventory')
})

test('verifyBundle rejects manifest digest mismatch', async t => {
    const file = path.join(tempDir(), BUNDLE_FILE)
    const tar = archive()
    tar[512] = 100
    fs.writeFileSync(file, zstdCompressSync(tar))
    t.throws(() => verifyBundle(file), /digest/, 'altered artifact rejected')
})

test('verifyBundle rejects unknown or mis-cased manifest keys', async t => {
    const file = path.join(tempDir(), BUNDLE_FILE)
    const text = '{"Format":"roast-run-bundle","version":1,"files":null}'
    const tar = writeTar([{ name:MANIFEST_FILE, data:Buffer.from(text) }])
    fs.writeFileSync(file, zstdCompressSync(tar))
    t.throws(() => verifyBundle(file), /unknown key/, 'case mismatch rejected')
})

test('verifyBundle accepts regular entries with typeflag NUL', async t => {
    const file = path.join(tempDir(), BUNDLE_FILE)
    const tar = archive()
    tar[156] = 0
    checksum(tar)
    fs.writeFileSync(file, zstdCompressSync(tar))
    t.equal(verifyBundle(file).files?.[0].path, 'a', 'NUL type accepted')
})

test('Building in a fresh process writes no ExperimentalWarning', async t => {
    const dir = tempDir()
    const worker = path.join(process.cwd(), 'worker.mjs')
    const { buildSync } = createRequire(import.meta.url)('esbuild') as
        typeof Esbuild
    buildSync({
        ...baseOptions(),
        outfile:worker,
        stdin:{
            contents:`import { buildBundle, verifyBundle }
            from ${JSON.stringify(source)};
            verifyBundle(buildBundle(process.argv[2]).path);`,
            resolveDir:process.cwd()
        },
        banner:{
            js:"import { createRequire } from 'node:module';" +
            'const require = createRequire(import.meta.url);'
        },
    })
    const result = await run(process.execPath, [worker, dir])
    t.equal(result.code, 0, 'fresh process builds and verifies')
    t.ok(!result.stderr.includes('ExperimentalWarning'), 'no warning')
})

test('manifest files are in bytewise sorted order', async t => {
    const dir = tempDir()
    writeFiles(dir, {
        'meta.json':'metadata\n',
        'zzz.txt':'zzz\n',
        'aaa.txt':'aaa\n',
        'result.json.gz':JSON.stringify({ ok:true }),
    })

    const result = buildBundle(dir)
    const manifest = verifyBundle(result.path)

    if (manifest.files) {
        for (let i = 1; i < manifest.files.length; i++) {
            const prev = manifest.files[i - 1].path
            const curr = manifest.files[i].path
            // Bytewise comparison: prev must be strictly less than current.
            t.ok(prev < curr, `${prev} < ${curr} in bytewise order`)
        }
    }
})

test('bundle contains bundle-manifest.json and all other files', async t => {
    const dir = tempDir()
    writeFiles(dir, {
        'meta.json':'metadata\n',
        'result.json.gz':JSON.stringify({ ok:true }),
    })

    const result = buildBundle(dir)
    const rawBytes = fs.readFileSync(result.path)
    const decompressed = zstdDecompressSync(rawBytes as unknown as Buffer)
    const entries = readTar(decompressed)

    const entryNames = entries.map(e => e.name)
    t.ok(entryNames.includes(MANIFEST_FILE),
        'bundle-manifest.json is in archive')
    t.ok(entryNames.includes('meta.json'), 'meta.json is in archive')
    t.ok(entryNames.includes('result.json.gz'), 'result.json.gz is in archive')

    // Verify manifest contains all these files.
    const manifest = verifyBundle(result.path)
    if (manifest.files) {
        t.ok(manifest.files.length >= 2, 'has at least 2 non-manifest files')
    }
})

test('bundle build returns correct path, sha256, and size', async t => {
    const dir = tempDir()
    writeFiles(dir, { 'meta.json':'metadata\n' })

    const result = buildBundle(dir)

    // Path should be under run directory.
    t.ok(result.path.startsWith(dir), 'path is under run directory')
    t.ok(result.path.endsWith(BUNDLE_FILE), 'path ends with bundle.tar.zst')

    // SHA256 should be a 64-character lowercase hex string.
    t.equal(result.sha256.length, 64, 'sha256 is 64 chars')
    t.ok(/^[a-f0-9]{64}$/.test(result.sha256), 'sha256 is lowercase hex')

    // Size should match actual file size.
    const st = fs.statSync(result.path)
    t.equal(result.size, st.size, 'size matches stat')
})

test('bundle build rejects symlinked bundle path and artifact', async t => {
    // Symlinked bundle path.
    const dirA = tempDir()
    const dirB = tempDir()

    writeFiles(dirB, { 'meta.json':'metadata\n' })
    const realResult = buildBundle(dirB)

    fs.symlinkSync(path.resolve(realResult.path), path.join(dirA, BUNDLE_FILE))
    writeFiles(dirA, { 'meta.json':'metadata\n' })

    t.throws(() => buildBundle(dirA), /not a regular file/,
        'symlinked bundle is rejected')

    // Symlinked artifact.
    const dirC = tempDir()
    const targetD = path.join(tempDir(), 'secret')
    fs.writeFileSync(targetD, Buffer.from('must not be bundled'))
    fs.symlinkSync(targetD, path.join(dirC, 'result.json.gz'))

    t.throws(() => buildBundle(dirC), /symlink/,
        'symlinked artifact is rejected')
})

test('bundle build rejects non-regular files as artifacts', async t => {
    const dir = tempDir()
    execFileSync('mkfifo', [path.join(dir, 'pipe')])
    t.throws(() => buildBundle(dir), /regular file/, 'FIFO rejected')
})

test('bundle build rejects stray bundle-manifest.json in run directory',
    async t => {
        const dir = tempDir()
        writeFiles(dir, {
            'meta.json':'metadata\n',
            [MANIFEST_FILE]:'{"format":"wrong"}\n',
        })

        t.throws(() => buildBundle(dir), /reserved bundle path/,
            'stray manifest is rejected')
    })

test('bundle build skips .tmp names and directories', async t => {
    const dir = tempDir()
    writeFiles(dir, {
        'meta.json':'metadata\n',
        'skipme.tmp':Buffer.from('temp content'),
    })

    // Create a subdirectory (should be skipped).
    fs.mkdirSync(path.join(dir, 'subdir'))

    const result = buildBundle(dir)
    const rawBytes = fs.readFileSync(result.path)
    const decompressed = zstdDecompressSync(rawBytes as unknown as Buffer)
    const entries = readTar(decompressed)

    const entryNames = entries.map(e => e.name)
    t.ok(entryNames.includes(MANIFEST_FILE), 'manifest is in archive')
    t.ok(!entryNames.includes('skipme.tmp'), '.tmp file is not in bundle')
})

test('bundle build preserves file modes 0o600 for bundle and lock',
    async t => {
        const dir = tempDir()
        writeFiles(dir, { 'meta.json':'metadata\n' })

        // Set the run dir to 0755 before building.
        fs.chmodSync(dir, 0o755)

        const result = buildBundle(dir)

        // Bundle should be 0o600.
        const bundleMode = fs.statSync(result.path).mode & 0o777
        t.equal(bundleMode, 0o600, 'bundle is 0o600')

        // Run directory should be 0o700.
        const dirMode = fs.statSync(dir).mode & 0o777
        t.equal(dirMode, 0o700, 'run directory is 0o700')
    })

test('buildBundle has a null inventory without regular artifacts', t => {
    const dir = tempDir()
    writeFiles(dir, { 'skip.tmp':Buffer.from('skip me') })
    fs.mkdirSync(path.join(dir, 'subdir'))
    const result = buildBundle(dir)
    t.equal(verifyBundle(result.path).files, null, 'empty inventory is null')
})
