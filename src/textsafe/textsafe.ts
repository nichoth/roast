// Neutralizes terminal control sequences in untrusted text before it reaches
// a terminal or a Markdown report (Go: internal/textsafe).
//
// `text` keeps line structure (LF and tab survive, CRLF becomes LF);
// `line` keeps everything on one line (LF and tab become `\n` and `\t`).
// Controls, DEL, C1 controls, invalid UTF-8 bytes, and lone surrogates
// become printable escapes. Backslash is never escaped, so both functions
// are idempotent.

// A decoded unit: a code point (>= 0), or an invalid byte stored as
// -(byte + 1).
type Unit = number

// Fast path: true when the mode would change nothing in `s`. A
// well-formed surrogate pair is clean; a lone surrogate is not.
function isClean (s:string, lineMode:boolean):boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c < 0x20) {
            if (lineMode || (c !== 0x0a && c !== 0x09)) return false
        } else if (c >= 0x7f && c <= 0x9f) {
            return false
        } else if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(i + 1)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false
            i++
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            return false
        }
    }
    return true
}

function hex (n:number, width:number):string {
    return n.toString(16).padStart(width, '0')
}

function escapeUnits (units:Unit[], lineMode:boolean):string {
    let out = ''
    for (let i = 0; i < units.length; i++) {
        const u = units[i]
        if (u < 0) {
            out += '\\x' + hex(-u - 1, 2)
        } else if (u === 0x0d) {
            if (!lineMode && units[i + 1] === 0x0a) continue
            out += '\\x0d'
        } else if (u === 0x0a) {
            out += lineMode ? '\\n' : '\n'
        } else if (u === 0x09) {
            out += lineMode ? '\\t' : '\t'
        } else if (u < 0x20 || u === 0x7f) {
            out += '\\x' + hex(u, 2)
        } else if ((u >= 0x80 && u <= 0x9f) ||
            (u >= 0xd800 && u <= 0xdfff)) {
            out += '\\u' + hex(u, 4)
        } else {
            out += String.fromCodePoint(u)
        }
    }
    return out
}

function stringUnits (s:string):Unit[] {
    const units:Unit[] = []
    // String iteration yields a lone surrogate as its own code point.
    for (const ch of s) units.push(ch.codePointAt(0)!)
    return units
}

function isCont (b:number|undefined):boolean {
    return b !== undefined && b >= 0x80 && b <= 0xbf
}

// Decodes one rune at `i` with Go utf8.DecodeRune validity rules. Returns
// [codePoint, size], or [-1, 1] for an invalid or truncated sequence.
function decodeRune (b:Uint8Array, i:number):[number, number] {
    const b0 = b[i]
    if (b0 < 0x80) return [b0, 1]
    const b1 = b[i + 1]
    if (b0 >= 0xc2 && b0 <= 0xdf) {
        if (!isCont(b1)) return [-1, 1]
        return [((b0 & 0x1f) << 6) | (b1 & 0x3f), 2]
    }
    if (b0 >= 0xe0 && b0 <= 0xef) {
        const lo = b0 === 0xe0 ? 0xa0 : 0x80
        const hi = b0 === 0xed ? 0x9f : 0xbf
        if (b1 === undefined || b1 < lo || b1 > hi) return [-1, 1]
        const b2 = b[i + 2]
        if (!isCont(b2)) return [-1, 1]
        return [((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f), 3]
    }
    if (b0 >= 0xf0 && b0 <= 0xf4) {
        const lo = b0 === 0xf0 ? 0x90 : 0x80
        const hi = b0 === 0xf4 ? 0x8f : 0xbf
        if (b1 === undefined || b1 < lo || b1 > hi) return [-1, 1]
        const b2 = b[i + 2]
        const b3 = b[i + 3]
        if (!isCont(b2) || !isCont(b3)) return [-1, 1]
        return [((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) |
            ((b2 & 0x3f) << 6) | (b3 & 0x3f), 4]
    }
    return [-1, 1]
}

function byteUnits (b:Uint8Array):Unit[] {
    const units:Unit[] = []
    for (let i = 0; i < b.length;) {
        const [cp, size] = decodeRune(b, i)
        units.push(cp < 0 ? -(b[i] + 1) : cp)
        i += size
    }
    return units
}

// Multi-line sanitizing of a string.
export function text (s:string):string {
    if (isClean(s, false)) return s
    return escapeUnits(stringUnits(s), false)
}

// Single-line sanitizing of a string.
export function line (s:string):string {
    if (isClean(s, true)) return s
    return escapeUnits(stringUnits(s), true)
}

// Multi-line sanitizing of raw bytes, escaping each invalid UTF-8 byte.
export function textBytes (b:Uint8Array):string {
    return escapeUnits(byteUnits(b), false)
}

// Single-line sanitizing of raw bytes.
export function lineBytes (b:Uint8Array):string {
    return escapeUnits(byteUnits(b), true)
}
