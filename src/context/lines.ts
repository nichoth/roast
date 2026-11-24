// Bounded line reading over a byte stream (spec 05, section 3): a line is
// consumed through its newline but at most `cap` content bytes are kept,
// so one huge line never sits in memory whole.

export interface CappedLine {
    // The kept content, plus the trailing `\n` when the line had one.
    line:Buffer;
    // Content bytes were discarded.
    cut:boolean;
    // The stream ended during this read (no newline followed).
    eof:boolean;
}

const EMPTY = Buffer.alloc(0)

export class LineReader {
    private readonly it:AsyncIterator<Buffer>
    private pending:Buffer = EMPTY
    private done = false

    constructor (source:AsyncIterable<Buffer>) {
        this.it = source[Symbol.asyncIterator]()
    }

    // The next chunk, or null at the end of the stream.
    private async fill ():Promise<boolean> {
        if (this.done) return false
        const next = await this.it.next()
        if (next.done) {
            this.done = true
            return false
        }
        this.pending = next.value
        return true
    }

    async readLineCapped (cap:number):Promise<CappedLine> {
        const kept:Buffer[] = []
        let size = 0
        let cut = false
        for (;;) {
            if (this.pending.length === 0 && !(await this.fill())) {
                return { line:Buffer.concat(kept, size), cut, eof:true }
            }
            const nl = this.pending.indexOf(0x0a)
            const end = nl === -1 ? this.pending.length : nl
            const room = Math.max(cap - size, 0)
            const take = Math.min(end, room)
            if (end > room) cut = true
            if (take > 0) {
                // Copy, so the chunk is not held alive by a small slice.
                kept.push(Buffer.from(this.pending.subarray(0, take)))
                size += take
            }
            if (nl === -1) {
                this.pending = EMPTY
                continue
            }
            this.pending = this.pending.subarray(nl + 1)
            kept.push(Buffer.from('\n'))
            return { line:Buffer.concat(kept, size + 1), cut, eof:false }
        }
    }

    // Stops reading the source.
    async close ():Promise<void> {
        if (!this.done) {
            this.done = true
            await this.it.return?.()
        }
    }
}
