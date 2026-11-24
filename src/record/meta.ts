// pattern: Imperative Shell
import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
    isValidName, makeRunDir, writePrivate, NoRecordDirError,
} from './dir.js'
import { compareBytes } from './json.js'
import { serializeMeta } from './meta-json.js'
import type { Meta } from './meta-types.js'
import { decodeMeta } from './meta-read.js'

export type * from './meta-types.js'
export { serializeMeta } from './meta-json.js'
export { wireProtocol, captureEnv, digest } from './meta-json.js'

function validate (name:string, label:string):void {
    if (!isValidName(name)) {
        throw new Error(`${label} ${JSON.stringify(name)}`)
    }
}

export async function resolveRunDir (
    dir:string,
    id:string
):Promise<string> {
    validate(id, 'invalid run id')
    if (!dir) throw new NoRecordDirError()
    let entries
    try {
        entries = await fs.readdir(dir, { withFileTypes:true })
    } catch (err) {
        throw new Error(`no run artifacts in ${dir}`, { cause:err })
    }
    const matches = entries.filter(e => e.isDirectory() &&
        e.name.startsWith(id)).map(e => e.name).sort(compareBytes)
    if (matches.length === 0) {
        throw new Error(`no run matches ${JSON.stringify(id)} under ${dir}`)
    }
    if (matches.length > 1) {
        throw new Error(`${JSON.stringify(id)} is ambiguous: matches ` +
            matches.join(', '))
    }
    return path.join(dir, matches[0])
}

export async function writeMeta (dir:string, meta:Meta):Promise<string> {
    validate(meta.run_id, 'write meta: invalid run id')
    const runDir = await makeRunDir(dir, meta.run_id)
    const file = path.join(runDir, 'meta.json')
    const tmp = file + '.tmp'
    await writePrivate(tmp, serializeMeta(meta))
    try {
        await fs.rename(tmp, file)
    } catch (err) {
        await fs.rm(tmp, { force:true }).catch(() => {})
        throw new Error(`publish ${file}`, { cause:err })
    }
    return file
}

export async function readMeta (
    dir:string,
    id:string
):Promise<{ meta:Meta; runDir:string }> {
    const runDir = await resolveRunDir(dir, id)
    const file = path.join(runDir, 'meta.json')
    const text = await fs.readFile(file, 'utf8')
    return { meta:decodeMeta(text), runDir }
}

export async function writeArtifact (
    dir:string,
    runId:string,
    name:string,
    content:string|Uint8Array
):Promise<string> {
    validate(runId, 'write artifact: invalid run id')
    validate(name, 'write artifact: invalid name')
    const runDir = await makeRunDir(dir, runId)
    const file = path.join(runDir, name + '.gz')
    await writePrivate(file, gzipSync(content))
    return file
}

export async function readArtifact (
    runDir:string,
    name:string
):Promise<string> {
    validate(name, 'read artifact: invalid name')
    return gunzipSync(await fs.readFile(path.join(runDir, name + '.gz')))
        .toString('utf8')
}

export async function writeReport (
    dir:string,
    runId:string,
    markdown:string
):Promise<string> {
    validate(runId, 'write report: invalid run id')
    const runDir = await makeRunDir(dir, runId)
    const file = path.join(runDir, 'report.md')
    await writePrivate(file, markdown)
    return file
}

export async function reportPath (dir:string, id:string):Promise<string> {
    return path.join(await resolveRunDir(dir, id), 'report.md')
}

export async function removeRun (dir:string, runId:string):Promise<void> {
    validate(runId, 'remove partial run: invalid run id')
    if (!dir) return
    await fs.rm(path.join(dir, runId), { recursive:true, force:true })
}
