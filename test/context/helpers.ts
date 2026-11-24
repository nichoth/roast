// Shared helpers for context tests.
// A small seeded PRNG so failures reproduce.
export function rng (seed:number):(n:number) => number {
    let s = seed >>> 0
    return n => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s % n
    }
}

// Go unicode.IsSpace, written out independently of the code under test.
const SPACES = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
])

// Decodes one rune at `i` the way Go's utf8.DecodeRune does: an invalid
// or truncated sequence is one byte of U+FFFD.
function decodeRune (b:Buffer, i:number):[number, number] {
    const c = b[i]
    if (c < 0x80) return [c, 1]
    const cont = (j:number, lo = 0x80, hi = 0xbf):boolean =>
        j < b.length && b[j] >= lo && b[j] <= hi
    if (c >= 0xc2 && c <= 0xdf && cont(i + 1)) {
        return [((c & 0x1f) << 6) | (b[i + 1] & 0x3f), 2]
    }
    if (c >= 0xe0 && c <= 0xef) {
        const lo = c === 0xe0 ? 0xa0 : 0x80
        const hi = c === 0xed ? 0x9f : 0xbf
        if (cont(i + 1, lo, hi) && cont(i + 2)) {
            return [((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) |
                (b[i + 2] & 0x3f), 3]
        }
    }
    if (c >= 0xf0 && c <= 0xf4) {
        const lo = c === 0xf0 ? 0x90 : 0x80
        const hi = c === 0xf4 ? 0x8f : 0xbf
        if (cont(i + 1, lo, hi) && cont(i + 2) && cont(i + 3)) {
            return [((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) |
                ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f), 4]
        }
    }
    return [0xfffd, 1]
}

// strings.Join(strings.Fields(s), " ") over bytes: split into fields,
// then join.
export function fieldsReference (b:Buffer):Buffer {
    const fields:Buffer[] = []
    let start = -1
    for (let i = 0; i < b.length;) {
        const [r, size] = decodeRune(b, i)
        if (SPACES.has(r)) {
            if (start >= 0) fields.push(b.subarray(start, i))
            start = -1
        } else if (start < 0) {
            start = i
        }
        i += size
    }
    if (start >= 0) fields.push(b.subarray(start))
    const out:Buffer[] = []
    fields.forEach((f, i) => {
        if (i > 0) out.push(Buffer.from(' '))
        out.push(f)
    })
    return Buffer.concat(out)
}

