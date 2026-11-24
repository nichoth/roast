// Patch capping (spec 04, 2.9): every file section of a unified diff is
// cut at maxSection bytes, with a marker where it was cut. Works on bytes
// and holds at most one read-buffer of an unfinished line.
import { SECTION_OMITTED_MARKER } from './constants.js'

// Go reads the stream with a 64 KiB bufio.Reader: a longer line arrives
// in fragments, and only a fragment at line start can be a header.
const READ_BUFFER = 64 * 1024

const HEADER = Buffer.from('diff --git ')
const NL = 0x0a

// The new-side path of a `diff --git a/P b/P` header, else the raw
// remainder (renames, quoted paths).
export function sectionName (header:string):string {
    const pair = header.startsWith('diff --git ') ?
        header.slice('diff --git '.length) :
        header
    return pairPath(pair) ?? pair
}

// `P` when `pair` is exactly `a/P b/P`.
export function pairPath (pair:string):string|null {
    if (pair.length < 7 || (pair.length - 5) % 2 !== 0) return null
    const n = (pair.length - 5) / 2
    const path = pair.slice(2, 2 + n)
    if (pair.slice(0, 2) !== 'a/' || pair.slice(2 + n) !== ' b/' + path) {
        return null
    }
    return path
}

export class SectionCapper {
    private readonly max:number
    private readonly chunks:Buffer[] = []
    private readonly cut:string[] = []
    private pending:Buffer[] = []
    private pendingLen = 0
    private header = ''
    private used = 0
    private dropping = false
    private atLineStart = true
    private lastByte = -1

    constructor (maxSection:number) {
        this.max = maxSection
    }

    write (chunk:Buffer):void {
        let pos = 0
        while (pos < chunk.length) {
            if (this.dropping && this.pendingLen === 0) {
                pos = this.skipDropped(chunk, pos)
                if (pos >= chunk.length) return
            }
            const nl = chunk.indexOf(NL, pos)
            if (nl === -1) {
                this.hold(chunk.subarray(pos))
                return
            }
            this.hold(chunk.subarray(pos, nl + 1))
            this.flushPending()
            pos = nl + 1
        }
    }

    // Ends the stream; returns the capped bytes and the cut section names.
    finish ():{ out:Buffer, cut:string[] } {
        this.flushPending()
        this.finishSection()
        return { out:Buffer.concat(this.chunks), cut:this.cut }
    }

    // While a section is dropping, skips the lines that cannot start a
    // new section without slicing them, so a huge cut file costs no
    // allocation per line. Returns where the next possible header (or a
    // line start too short to tell) begins.
    private skipDropped (chunk:Buffer, pos:number):number {
        while (pos < chunk.length) {
            if (!this.atLineStart) {
                const nl = chunk.indexOf(NL, pos)
                if (nl === -1) return chunk.length
                pos = nl + 1
                this.atLineStart = true
                continue
            }
            if (chunk.length - pos < HEADER.length) return pos
            if (chunk.compare(HEADER, 0, HEADER.length, pos,
                pos + HEADER.length) === 0) {
                return pos
            }
            this.atLineStart = false
        }
        return pos
    }

    // Buffers part of a line, emitting full read-buffer fragments.
    private hold (part:Buffer):void {
        this.pending.push(part)
        this.pendingLen += part.length
        while (this.pendingLen >= READ_BUFFER) {
            const all = Buffer.concat(this.pending)
            this.fragment(all.subarray(0, READ_BUFFER))
            const rest = all.subarray(READ_BUFFER)
            this.pending = rest.length > 0 ? [rest] : []
            this.pendingLen = rest.length
        }
    }

    private flushPending ():void {
        if (this.pendingLen === 0) return
        const frag = this.pending.length === 1 ?
            this.pending[0] :
            Buffer.concat(this.pending)
        this.pending = []
        this.pendingLen = 0
        this.fragment(frag)
    }

    private fragment (frag:Buffer):void {
        if (this.atLineStart && startsWith(frag, HEADER)) {
            this.finishSection()
            const nl = frag.indexOf(NL)
            const line = nl === -1 ? frag : frag.subarray(0, nl)
            this.header = line.toString('utf8')
            this.used = 0
            this.dropping = false
        }
        if (!this.dropping) {
            const take = Math.min(frag.length, this.max - this.used)
            if (take > 0) this.emit(frag.subarray(0, take))
            this.used += Math.max(take, 0)
            if (take < frag.length) this.dropping = true
        }
        this.atLineStart = frag[frag.length - 1] === NL
    }

    private emit (bytes:Buffer):void {
        // Copy: a kept slice must not pin its whole read chunk.
        this.chunks.push(Buffer.from(bytes))
        this.lastByte = bytes[bytes.length - 1]
    }

    private finishSection ():void {
        if (!this.dropping) return
        if (this.lastByte !== NL) this.emit(Buffer.from('\n'))
        this.emit(Buffer.from(SECTION_OMITTED_MARKER(this.max)))
        this.cut.push(sectionName(this.header))
        this.dropping = false
    }
}

function startsWith (buf:Buffer, prefix:Buffer):boolean {
    return buf.length >= prefix.length &&
        buf.subarray(0, prefix.length).equals(prefix)
}

// The note for cut sections, appended to `notes` when any were cut.
export function truncationNote (
    notes:string[],
    cut:readonly string[],
    maxSection:number
):string[] {
    if (cut.length === 0) return notes
    return [...notes, `diff for ${cut.length} file(s) cut at ${
        maxSection} bytes each: ${listSome(cut, 10)}`]
}

export function listSome (items:readonly string[], limit:number):string {
    if (items.length <= limit) return items.join(', ')
    return items.slice(0, limit).join(', ') +
        `, and ${items.length - limit} more`
}
