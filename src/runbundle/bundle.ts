// pattern: Imperative Shell
// Build and verify deterministic .tar.zst archives of run directories.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { TarFile } from './tar.js'
import { writeTar, readTar, NULL_TYPEFLAG } from './tar.js'
import { digest } from '../record/meta-json.js'
import { compareBytes } from '../gocompat/strings.js'
import { installWarningFilter } from '../startup.js'

// Direct module users do not pass through the CLI startup guard.
installWarningFilter()

export const BUNDLE_FILE = 'bundle.tar.zst'
export const MANIFEST_FILE = 'bundle-manifest.json'
export const FORMAT = 'roast-run-bundle'
export const VERSION = 1

const MAX_MANIFEST_BYTES = 1 << 20 // 1 MiB
const STALE_LOCK_AGE_MS = 10 * 60 * 1000 // 10 minutes

/** A manifest entry describing one archived file. */
export type ManifestEntry = {
    path:string
    sha256:string
    size:number
}

/** The versioned, deterministic inventory embedded in a bundle. */
export type Manifest = {
    format:string
    version:number
    files:ManifestEntry[]|null
}

/** Error thrown when another process is building the bundle. */
export class BundleBuildInProgressError extends Error {
    constructor () {
        super('bundle build already in progress by another process')
    }
}

// Build

/** Build a deterministic run bundle and return its path, digest, and size. */
export type Bundle = { path:string, sha256:string, size:number }

export function buildBundle (runDir:string):Bundle {
    // Protect the run directory.
    try { fs.chmodSync(runDir, 0o700) } catch (err) {
        throw new Error(
            `protect run directory ${runDir}: ${getErrorMessage(err)}`,
        )
    }

    const bundlePath = path.join(runDir, BUNDLE_FILE)

    // Check for an existing valid bundle.
    try {
        const st = fs.lstatSync(bundlePath)
        if (!st.isDirectory()) {
            if (!st.isFile()) {
                throw new Error(
                    `existing bundle ${bundlePath} is not a regular file`,
                )
            }
            fs.chmodSync(bundlePath, 0o600)
            try { verifyBundle(bundlePath) } catch (err) {
                throw new Error(`verify existing bundle ${bundlePath}: ` +
                    getErrorMessage(err))
            }
            return {
                path:bundlePath, sha256:hashFile(bundlePath), size:st.size,
            }
        }
    } catch (err:unknown) {
        if (!isEnoent(err)) throw err
    }

    // No existing bundle; build a new one.
    const tmpPath = bundlePath + '.tmp'
    acquireBundleLock(tmpPath)

    try {
        const archiveFiles = collectArchiveFiles(runDir)
        writeBundle(tmpPath, archiveFiles)
        fs.renameSync(tmpPath, bundlePath)
    } catch (err) {
        try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
        throw err
    }

    // Verify the newly built bundle and return.
    const st = fs.statSync(bundlePath)
    verifyBundle(bundlePath)
    return { path:bundlePath, sha256:hashFile(bundlePath), size:st.size }
}

// Lock

function createLock (tmp:string):void {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    fs.closeSync(fd)
}

function acquireBundleLock (tmp:string):void {
    try {
        createLock(tmp)
        return
    } catch (err) {
        if (!isEExist(err)) {
            throw new Error(
                `create bundle lock ${tmp}: ${getErrorMessage(err)}`,
            )
        }
    }
    let st:fs.Stats
    try {
        st = fs.statSync(tmp)
    } catch (err) {
        if (isEnoent(err)) throw new BundleBuildInProgressError()
        throw new Error(`stat bundle lock ${tmp}: ${getErrorMessage(err)}`)
    }
    if (Date.now() - st.mtimeMs < STALE_LOCK_AGE_MS) {
        throw new BundleBuildInProgressError()
    }
    try {
        fs.unlinkSync(tmp)
    } catch (err) {
        if (!isEnoent(err)) {
            throw new Error(
                `reclaim stale bundle lock ${tmp}: ${getErrorMessage(err)}`,
            )
        }
    }
    try { createLock(tmp) } catch { throw new BundleBuildInProgressError() }
}

// File Collection

function collectArchiveFiles (runDir:string):TarFile[] {
    const entries = fs.readdirSync(runDir, { withFileTypes:true })

    // Sort bytewise by name.
    entries.sort((a, b) => compareBytes(a.name, b.name))

    const files:TarFile[] = []

    for (const entry of entries) {
        const name = entry.name

        // Skip directories, the bundle file, and .tmp names.
        if (entry.isDirectory()) continue
        if (name === BUNDLE_FILE) continue
        if (name.endsWith('.tmp')) continue

        // Reject reserved bundle-manifest.json.
        if (name === MANIFEST_FILE) {
            throw new Error(
                `run directory contains reserved bundle path ${MANIFEST_FILE}`
            )
        }

        const filePath = path.join(runDir, name)
        const data = readRegularArtifact(filePath, name)
        files.push({ name, data })
    }

    // Build the manifest.
    const manifestEntries:ManifestEntry[] = []
    for (const file of files) {
        const data = typeof file.data === 'string' ?
            Buffer.from(file.data) : file.data
        manifestEntries.push({
            path:file.name,
            sha256:digest(data),
            size:data.length,
        })
    }

    // Sort manifest entries bytewise by path.
    manifestEntries.sort((a, b) => compareBytes(a.path, b.path))

    const manifestJson = JSON.stringify({
        format:FORMAT,
        version:VERSION,
        files:manifestEntries.length > 0 ? manifestEntries : null,
    }, null, 2) + '\n'

    const allFiles = [...files]
    allFiles.push({ name:MANIFEST_FILE, data:Buffer.from(manifestJson) })

    // Sort all archive files bytewise by name.
    allFiles.sort((a, b) => compareBytes(a.name, b.name))

    return allFiles
}

function readRegularArtifact (filePath:string, name:string):Uint8Array {
    const st = fs.lstatSync(filePath)

    if (st.isSymbolicLink()) {
        throw new Error(
            `run artifact ${name} is a symlink; ` +
            'only regular files may be bundled'
        )
    }

    if (!st.isFile()) {
        throw new Error(`run artifact ${name} is not a regular file`)
    }

    const fd = fs.openSync(filePath, fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || st.ino !== opened.ino ||
            st.dev !== opened.dev) {
            throw new Error(
                `run artifact ${name} changed while the bundle was being built`
            )
        }
        return fs.readFileSync(fd)
    } finally {
        fs.closeSync(fd)
    }
}

// === Compression ============================================================

function writeBundle (filePath:string, files:TarFile[]):void {
    const fd = fs.openSync(filePath,
        fs.constants.O_WRONLY | fs.constants.O_TRUNC)
    try {
        fs.fchmodSync(fd, 0o600)
        const compressed = zstdCompressSync(writeTar(files), {
            params:{
                [constants.ZSTD_c_compressionLevel]:3,
                [constants.ZSTD_c_checksumFlag]:1,
            },
        })
        fs.writeFileSync(fd, compressed)
    } finally {
        fs.closeSync(fd)
    }
}

// Verify

/** Verify a bundle's format and contents; return the manifest. */
export function verifyBundle (filePath:string):Manifest {
    const compressed = fs.readFileSync(filePath)
    let data:Buffer
    try { data = zstdDecompressSync(compressed) } catch (err) {
        throw new Error(`open zstd stream: ${getErrorMessage(err)}`)
    }
    let entries:ReturnType<typeof readTar>
    try { entries = readTar(data) } catch (err) {
        throw new Error(`read tar: ${getErrorMessage(err)}`)
    }
    const actual = new Map<string, { sha256:string, size:number }>()
    let manifestData:Uint8Array|null = null
    for (const entry of entries) {
        if (entry.typeflag !== '0' && entry.typeflag !== NULL_TYPEFLAG) {
            throw new Error(
                `bundle entry "${entry.name}" is not a regular file`,
            )
        }
        if (!isValidName(entry.name)) {
            throw new Error(`bundle entry "${entry.name}" is not a flat path`)
        }
        if (actual.has(entry.name) ||
            (entry.name === MANIFEST_FILE && manifestData !== null)) {
            throw new Error(`bundle contains duplicate entry "${entry.name}"`)
        }
        if (entry.name === MANIFEST_FILE) {
            if (entry.size > MAX_MANIFEST_BYTES) {
                throw new Error('bundle manifest is larger than 1048576 bytes')
            }
            manifestData = entry.data
        } else {
            actual.set(entry.name, {
                sha256:digest(entry.data), size:entry.size,
            })
        }
    }
    if (manifestData === null) {
        throw new Error('bundle has no bundle-manifest.json')
    }
    let manifest:Manifest
    try {
        manifest = parseManifest(Buffer.from(manifestData).toString('utf8'))
    } catch (err) {
        throw new Error(`parse bundle manifest: ${getErrorMessage(err)}`)
    }
    if (manifest.format !== FORMAT) {
        throw new Error(`unsupported bundle format "${manifest.format}"`)
    }
    if (manifest.version !== VERSION) {
        throw new Error(`unsupported bundle version ${manifest.version}`)
    }
    const files = manifest.files ?? []
    if (files.length !== actual.size) {
        throw new Error(`bundle manifest lists ${files.length} files but ` +
            `archive contains ${actual.size}`)
    }
    let previous = ''
    for (const expected of files) {
        if (!isValidName(expected.path) || expected.path === MANIFEST_FILE) {
            throw new Error(
                `bundle manifest contains invalid path "${expected.path}"`,
            )
        }
        if (previous && compareBytes(previous, expected.path) >= 0) {
            throw new Error('bundle manifest paths are not strictly sorted')
        }
        previous = expected.path
        if (!/^[a-f0-9]{64}$/.test(expected.sha256)) {
            throw new Error(
                `bundle manifest has invalid sha256 for ${expected.path}`,
            )
        }
        const got = actual.get(expected.path)
        if (!got) {
            throw new Error(
                `bundle manifest entry ${expected.path} ` +
                'is missing from archive',
            )
        }
        if (got.size !== expected.size) {
            throw new Error(`bundle entry ${expected.path} size is ` +
                `${got.size}, manifest says ${expected.size}`)
        }
        if (got.sha256 !== expected.sha256) {
            throw new Error(
                `bundle entry ${expected.path} digest does not match manifest`,
            )
        }
    }
    return manifest
}

// JSON decoding is separate from archive I/O. Null scalars take Go zero
// values, and unknown keys are rejected at both struct levels.
function parseManifest (text:string):Manifest {
    const raw:unknown = JSON.parse(text, (key:string, value:unknown,
        context?:{ source?:string }) => {
        if ((key === 'version' || key === 'size') &&
            typeof value === 'number' &&
            (!/^-?\d+$/.test(context?.source ?? String(value)) ||
            !Number.isSafeInteger(value))) {
            throw new Error('expected an integer literal')
        }
        return value
    })
    const m = struct(raw, ['format', 'version', 'files'])
    const files = m.files
    if (files != null && !Array.isArray(files)) {
        throw new Error('files must be an array or null')
    }
    return {
        format:stringField(m.format),
        version:integerField(m.version),
        files:files == null ? null : files.map((file:unknown) => {
            const f = struct(file, ['path', 'sha256', 'size'])
            return {
                path:stringField(f.path),
                sha256:stringField(f.sha256),
                size:integerField(f.size)
            }
        }),
    }
}

function struct (value:unknown, keys:string[]):Record<string, unknown> {
    if (value == null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected an object')
    }
    for (const key of Object.keys(value)) {
        if (!keys.includes(key)) throw new Error(`unknown key "${key}"`)
    }
    return value as Record<string, unknown>
}

function stringField (value:unknown):string {
    if (value == null) return ''
    if (typeof value !== 'string') throw new Error('expected a string')
    return value
}

function integerField (value:unknown):number {
    if (value == null) return 0
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error('expected an integer')
    }
    return value
}

// Helpers

function isEnoent (err:unknown):boolean {
    if (err instanceof Error && 'code' in err) return err.code === 'ENOENT'
    return false
}

function isEExist (err:unknown):boolean {
    if (err instanceof Error && 'code' in err) return err.code === 'EEXIST'
    return false
}

function getErrorMessage (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function isValidName (name:string):boolean {
    if (!name || name.includes('/') || name.includes('\\') ||
        name.includes('\0') || name === '.' || name === '..') return false
    return true
}

function hashFile (filePath:string):string {
    const data = fs.readFileSync(filePath)
    return digest(data)
}
