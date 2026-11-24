// pattern: Functional Core
// Minimal Go-compatible ustar with PAX path extensions.
import { posix } from 'node:path'

const BLOCK = 512
const MAX_SIZE = 8 * 1024 ** 3

export type TarFile = { name:string, data:Uint8Array|string }
export type TarEntry = {
    name:string, data:Uint8Array, typeflag:string, size:number,
}

function padded (size:number):number {
    return Math.ceil(size / BLOCK) * BLOCK
}

function asciiName (name:string):string {
    return Array.from(name).filter(c => {
        const code = c.codePointAt(0)!
        return code > 0 && code < 128
    }).join('').slice(0, 100)
}

function header (
    name:string, size:number, typeflag:string, mode:number,
):Buffer {
    const out = Buffer.alloc(BLOCK)
    out.write(asciiName(name), 0, 100, 'ascii')
    for (const [offset, width, value] of [
        [100, 8, mode], [108, 8, 0], [116, 8, 0],
        [124, 12, size], [136, 12, 0],
    ]) {
        out.write(value.toString(8).padStart(width - 1, '0'), offset)
    }
    out.write(typeflag, 156)
    out.write('ustar\0' + '00', 257)
    if (typeflag === '0') {
        out.write('0000000\0' + '0000000\0', 329)
    }
    out.fill(32, 148, 156)
    const sum = out.reduce((a, b) => a + b, 0)
    out.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return out
}

export function writeTar (files:readonly TarFile[]):Buffer {
    const parts:Buffer[] = []
    function append (name:string, data:Uint8Array, type:string):void {
        parts.push(header(name, data.length, type, type === '0' ? 384 : 0))
        parts.push(Buffer.from(data), Buffer.alloc(padded(data.length) -
            data.length))
    }
    for (const file of files) {
        if (file.data.length >= MAX_SIZE) {
            throw new Error('cannot archive files >= 8 GiB')
        }
        if (asciiName(file.name) !== file.name) {
            const rest = ` path=${file.name}\n`
            let length = Buffer.byteLength(rest) + 1
            while (length !==
                Buffer.byteLength(rest) + String(length).length) {
                length = Buffer.byteLength(rest) + String(length).length
            }
            const name = posix.join(posix.dirname(file.name),
                'PaxHeaders.0', posix.basename(file.name))
            append(name, Buffer.from(String(length) + rest), 'x')
        }
        const data = typeof file.data === 'string' ?
            Buffer.from(file.data) : file.data
        if (data.length >= MAX_SIZE) {
            throw new Error('cannot archive files >= 8 GiB')
        }
        append(file.name, data, '0')
    }
    parts.push(Buffer.alloc(2 * BLOCK))
    return Buffer.concat(parts)
}

function octal (field:Buffer):number {
    const text = field.toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]*$/.test(text)) throw new Error('tar: invalid octal field')
    const value = text === '' ? 0 : parseInt(text, 8)
    if (!Number.isSafeInteger(value)) throw new Error('tar: invalid size')
    return value
}

function cstring (field:Buffer):string {
    return field.toString('utf8').split('\0', 1)[0]
}

function paxPath (data:Buffer):string|null {
    let offset = 0
    let path:string|null = null
    while (offset < data.length) {
        const space = data.indexOf(32, offset)
        if (space < 0) throw new Error('tar: invalid PAX length')
        const digits = data.subarray(offset, space).toString('ascii')
        const length = Number(digits)
        const end = offset + length
        if (!/^[1-9]\d*$/.test(digits) || !Number.isSafeInteger(length) ||
            end > data.length || end <= space + 1 || data[end - 1] !== 10) {
            throw new Error('tar: invalid PAX record length')
        }
        const record = data.subarray(space + 1, end - 1).toString('utf8')
        const equals = record.indexOf('=')
        if (equals <= 0) throw new Error('tar: invalid PAX record')
        if (record.slice(0, equals) === 'path') path = record.slice(equals + 1)
        offset = end
    }
    return path
}

export function readTar (archive:Uint8Array):TarEntry[] {
    const data = Buffer.from(archive)
    const entries:TarEntry[] = []
    let offset = 0
    let path:string|null = null
    while (offset < data.length) {
        const hdr = data.subarray(offset, offset + BLOCK)
        if (hdr.length !== BLOCK) throw new Error('tar: truncated header')
        if (hdr.every(b => b === 0)) {
            const end = data.subarray(offset + BLOCK, offset + 2 * BLOCK)
            if (end.length !== BLOCK || !end.every(b => b === 0)) {
                throw new Error('tar: truncated end marker')
            }
            return entries
        }
        const expected = octal(hdr.subarray(148, 156))
        let unsigned = 256
        let signed = 256
        for (let i = 0; i < BLOCK; i++) {
            if (i >= 148 && i < 156) continue
            unsigned += hdr[i]
            signed += hdr[i] < 128 ? hdr[i] : hdr[i] - 256
        }
        if (expected !== unsigned && expected !== signed) {
            throw new Error('tar: invalid checksum')
        }
        const size = octal(hdr.subarray(124, 136))
        let name = cstring(hdr.subarray(0, 100))
        const prefix = cstring(hdr.subarray(345, 500))
        if (cstring(hdr.subarray(257, 263)) === 'ustar' && prefix) {
            name = prefix + '/' + name
        }
        const typeflag = String.fromCharCode(hdr[156])
        offset += BLOCK
        if (size > data.length - offset ||
            padded(size) > data.length - offset) {
            throw new Error('tar: truncated data')
        }
        const body = data.subarray(offset, offset + size)
        offset += padded(size)
        if (typeflag === 'x') {
            path = paxPath(body) ?? path
        } else if (typeflag === 'g') {
            paxPath(body) // Validate framing but ignore global overrides.
        } else {
            entries.push({ name:path ?? name, typeflag, size, data:body })
            path = null
        }
    }
    return entries
}

export const NULL_TYPEFLAG = '\0'
