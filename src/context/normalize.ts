// Whitespace normalization for quote grounding (spec 05, 2.11): Go
// strings.Join(strings.Fields(s), " ") on bytes. Whitespace is Go
// unicode.IsSpace; bytes that are not valid UTF-8 are kept as they are.
import { isGoSpace } from '../gocompat/strings.js'

// A growable byte buffer: the sink normalized text is written into.
export class ByteBuilder {
    private buf:Buffer
    length = 0

    constructor (capacity = 256) {
        this.buf = Buffer.allocUnsafe(Math.max(capacity, 16))
    }

    private reserve (n:number):void {
        const need = this.length + n
        if (need <= this.buf.length) return
        let cap = this.buf.length * 2
        while (cap < need) cap *= 2
        const next = Buffer.allocUnsafe(cap)
        this.buf.copy(next, 0, 0, this.length)
        this.buf = next
    }

    pushByte (b:number):void {
        this.reserve(1)
        this.buf[this.length++] = b
    }

    pushRange (src:Buffer, start:number, end:number):void {
        const n = end - start
        this.reserve(n)
        src.copy(this.buf, this.length, start, end)
        this.length += n
    }

    // The bytes written so far (a view; copy before writing more).
    view ():Buffer {
        return this.buf.subarray(0, this.length)
    }

    // Drops all but the last `keep` bytes.
    keepTail (keep:number):void {
        if (this.length <= keep) return
        this.buf.copy(this.buf, 0, this.length - keep, this.length)
        this.length = keep
    }

    toBuffer ():Buffer {
        return Buffer.from(this.view())
    }
}

// Go utf8.FullRune: whether `b[i:]` begins with a full encoding or with
// an invalid one (which decodes as one error byte).
function fullRune (b:Buffer, i:number):boolean {
    const n = b.length - i
    const c = b[i]
    let want:number
    let lo = 0x80
    let hi = 0xbf
    if (c < 0xc2 || c > 0xf4) return true
    if (c < 0xe0) want = 2
    else if (c < 0xf0) {
        want = 3
        if (c === 0xe0) lo = 0xa0
        if (c === 0xed) hi = 0x9f
    } else {
        want = 4
        if (c === 0xf0) lo = 0x90
        if (c === 0xf4) hi = 0x8f
    }
    if (n >= want) return true
    if (n > 1 && (b[i + 1] < lo || b[i + 1] > hi)) return true
    if (n > 2 && (b[i + 2] < 0x80 || b[i + 2] > 0xbf)) return true
    return false
}

// Go utf8.DecodeRune: [rune, size]; an invalid sequence is [0xfffd, 1].
function decodeRune (b:Buffer, i:number):[number, number] {
    const c = b[i]
    const n = b.length - i
    const cont = (j:number, lo = 0x80, hi = 0xbf):boolean =>
        j - i < n && b[j] >= lo && b[j] <= hi
    if (c >= 0xc2 && c <= 0xdf) {
        if (cont(i + 1)) return [((c & 0x1f) << 6) | (b[i + 1] & 0x3f), 2]
    } else if (c >= 0xe0 && c <= 0xef) {
        const lo = c === 0xe0 ? 0xa0 : 0x80
        const hi = c === 0xed ? 0x9f : 0xbf
        if (cont(i + 1, lo, hi) && cont(i + 2)) {
            return [((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) |
                (b[i + 2] & 0x3f), 3]
        }
    } else if (c >= 0xf0 && c <= 0xf4) {
        const lo = c === 0xf0 ? 0x90 : 0x80
        const hi = c === 0xf4 ? 0x8f : 0xbf
        if (cont(i + 1, lo, hi) && cont(i + 2) && cont(i + 3)) {
            return [((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) |
                ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f), 4]
        }
    }
    return [0xfffd, 1]
}

const EMPTY = Buffer.alloc(0)
const NEWLINE = Buffer.from('\n')

// normalizeWS over a stream of chunks. An incomplete UTF-8 sequence at the
// end of a chunk is carried into the next one, so any chunking produces
// the same bytes as the whole-input form.
export class WsNormalizer {
    private carry:Buffer = EMPTY
    // A non-space rune has been written.
    private started = false
    // Whitespace seen since the last non-space rune.
    private space = false

    // Normalizes `chunk` and returns the output for it. `final` marks the
    // last chunk, so a trailing incomplete sequence is emitted as is.
    write (chunk:Buffer, final:boolean):Buffer {
        const out = new ByteBuilder(chunk.length + this.carry.length + 1)
        this.writeInto(out, chunk, final)
        return out.toBuffer()
    }

    // write(), appending to `out` instead of returning a buffer.
    writeInto (out:ByteBuilder, chunk:Buffer, final:boolean):void {
        let s = chunk
        if (this.carry.length > 0) {
            s = Buffer.concat([this.carry, chunk])
            this.carry = EMPTY
        }
        const len = s.length
        let i = 0
        while (i < len) {
            const c = s[i]
            if (c < 0x80) {
                if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) {
                    this.space = true
                } else {
                    this.emitStart(out)
                    out.pushByte(c)
                }
                i++
                continue
            }
            if (!final && !fullRune(s, i)) {
                // Copy: the caller may reuse its chunk buffer.
                this.carry = Buffer.from(s.subarray(i))
                break
            }
            const [r, size] = decodeRune(s, i)
            if (isGoSpace(r)) {
                this.space = true
            } else {
                this.emitStart(out)
                out.pushRange(s, i, i + size)
            }
            i += size
        }
    }

    // Writes `text` and a newline.
    writeLine (out:ByteBuilder, text:Buffer):void {
        this.writeInto(out, text, false)
        this.writeInto(out, NEWLINE, false)
    }

    finish (out:ByteBuilder):void {
        this.writeInto(out, EMPTY, true)
    }

    private emitStart (out:ByteBuilder):void {
        if (this.space && this.started) out.pushByte(0x20)
        this.space = false
        this.started = true
    }
}

// Collapses every whitespace run to one space and trims both ends.
export function normalizeWS (buf:Buffer):Buffer {
    return new WsNormalizer().write(buf, true)
}
