// Go-compatible string helpers. Each one reproduces a Go standard library
// behavior that JavaScript's nearest built-in gets subtly wrong, so output
// matches the Go implementation byte for byte.

// Go unicode.IsSpace: Latin-1 spaces plus the Unicode White_Space set.
// Unlike JS `\s`, U+0085 is a space and U+FEFF is not.
export function isGoSpace (cp:number):boolean {
    switch (cp) {
        case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d:
        case 0x20: case 0x85: case 0xa0:
        case 0x1680: case 0x2028: case 0x2029: case 0x202f:
        case 0x205f: case 0x3000:
            return true
    }
    return cp >= 0x2000 && cp <= 0x200a
}

// Go strings.TrimSpace.
export function goTrimSpace (s:string):string {
    let start = 0
    let end = s.length
    // Every Go space is a single UTF-16 unit, so unit scanning is exact.
    while (start < end && isGoSpace(s.charCodeAt(start))) start++
    while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--
    return s.slice(start, end)
}

// Go filepath.Ext on a `/`-separated path: the suffix from the last dot in
// the final element, so `docs/.md` -> `.md` and `file.` -> `.`.
export function goExt (path:string):string {
    for (let i = path.length - 1; i >= 0 && path[i] !== '/'; i--) {
        if (path[i] === '.') return path.slice(i)
    }
    return ''
}

function utf8Len (cp:number):number {
    if (cp < 0x80) return 1
    if (cp < 0x800) return 2
    if (cp < 0x10000) return 3
    return 4
}

// The longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`,
// cut on a code point boundary. A lone surrogate counts as the three
// bytes of the U+FFFD it encodes to.
export function truncateUtf8 (s:string, maxBytes:number):string {
    let used = 0
    let end = 0
    for (const ch of s) {
        const n = utf8Len(ch.codePointAt(0)!)
        if (used + n > maxBytes) return s.slice(0, end)
        used += n
        end += ch.length
    }
    return s
}

// Go fmt "%.2f". Go rounds the exact binary value half to even; toFixed
// rounds exact ties away from zero. Ties are values where x * 8 is an odd
// integer (0.125, 0.375, ...).
export function formatFixed2 (x:number):string {
    if (x < 0 || Object.is(x, -0)) return '-' + formatFixed2(-x)
    const eighths = x * 8
    if (Number.isInteger(eighths) && eighths % 2 !== 0) {
        let n = Math.floor(x * 100)
        if (n % 2 !== 0) n++
        return (n / 100).toFixed(2)
    }
    return x.toFixed(2)
}

// Orders strings by their UTF-8 bytes (Go string comparison). JS `<`
// compares UTF-16 units, which puts U+10000 and above before U+E000..FFFF.
export function compareBytes (a:string, b:string):number {
    return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u

// Go unicode.IsPrint: letters, marks, numbers, punctuation, symbols, and
// the ASCII space only.
export function isGoPrint (cp:number):boolean {
    if (cp === 0x20) return true
    if (cp >= 0xd800 && cp <= 0xdfff) return false
    return PRINTABLE.test(String.fromCodePoint(cp))
}

const NAMED_ESCAPES:Record<number, string> = {
    0x07:'\\a',
    0x08:'\\b',
    0x0c:'\\f',
    0x0a:'\\n',
    0x0d:'\\r',
    0x09:'\\t',
    0x0b:'\\v',
}

function hex (n:number, width:number):string {
    return n.toString(16).padStart(width, '0')
}

// Go strconv.Quote (also fmt %q on a string). A lone surrogate, which Go
// cannot hold, is quoted as U+FFFD would be if it were not printable:
// `\ufffd`.
export function goQuote (s:string):string {
    let out = '"'
    for (const ch of s) {
        const cp = ch.codePointAt(0)!
        if (cp === 0x22 || cp === 0x5c) {
            out += '\\' + ch
        } else if (isGoPrint(cp)) {
            out += ch
        } else if (NAMED_ESCAPES[cp] !== undefined) {
            out += NAMED_ESCAPES[cp]
        } else if (cp < 0x20 || cp === 0x7f) {
            out += '\\x' + hex(cp, 2)
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
            out += '\\ufffd'
        } else if (cp < 0x10000) {
            out += '\\u' + hex(cp, 4)
        } else {
            out += '\\U' + hex(cp, 8)
        }
    }
    return out + '"'
}
