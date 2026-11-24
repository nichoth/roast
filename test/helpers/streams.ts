import { PassThrough, Writable } from 'node:stream'

// A writable that keeps everything written to it.
export class BufferStream extends Writable {
    chunks:Buffer[] = []

    _write (
        chunk:Buffer|string,
        _enc:BufferEncoding,
        done:(err?:Error|null) => void
    ):void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        done()
    }

    text ():string {
        return Buffer.concat(this.chunks).toString('utf8')
    }
}

// A readable stdin fed with fixed text, then EOF.
export function inputStream (text = ''):NodeJS.ReadableStream {
    const s = new PassThrough()
    s.end(text)
    return s
}
