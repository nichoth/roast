// read_file's window arguments (spec 05, 2.7 `parseOffsetLimit`).
import { isGoSpace } from '../gocompat/strings.js'

// Clamp on a parsed offset or limit (2^30).
export const MAX_WINDOW = 1073741824

export const DEFAULT_OFFSET = 1
export const DEFAULT_LIMIT = 500

export const OFFSET_LIMIT_ERROR = 'offset and limit must be integers'

export type Window = { offset:number; limit:number }

const DIGITS:Record<number, string> = {
    2:'01',
    8:'01234567',
    10:'0123456789',
    16:'0123456789abcdefABCDEF',
}

// Go strconv's underscoreOK: `_` only between digits, or after a base
// prefix.
function underscoreOK (tok:string):boolean {
    let s = tok
    if (s[0] === '+' || s[0] === '-') s = s.slice(1)
    let saw = '^'
    let i = 0
    let hex = false
    const p = (s[1] ?? '').toLowerCase()
    if (s.length >= 2 && s[0] === '0' && (p === 'b' || p === 'o' ||
        p === 'x')) {
        i = 2
        saw = '0'
        hex = p === 'x'
    }
    for (; i < s.length; i++) {
        const c = s[i].toLowerCase()
        if ((c >= '0' && c <= '9') || (hex && c >= 'a' && c <= 'f')) {
            saw = '0'
            continue
        }
        if (c === '_') {
            if (saw !== '0') return false
            saw = '_'
            continue
        }
        if (saw === '_') return false
        saw = '!'
    }
    return saw !== '_'
}

// Go `fmt.Sscan` into an int: leading space skipped, optional sign, base
// prefixes (`0x`, `0o`, `0b`, a bare leading `0` is octal) and `_`
// separators, digits read as far as they go, the rest ignored. The value
// is a bigint so huge inputs can clamp; null when there are no digits.
function sscanInt (s:string):bigint|null {
    let i = 0
    while (i < s.length && isGoSpace(s.codePointAt(i)!)) {
        i += s.codePointAt(i)! > 0xffff ? 2 : 1
    }
    let sign = ''
    if (s[i] === '+' || s[i] === '-') sign = s[i++]
    let base = 10
    let prefix = ''
    let zeroFound = false
    if (s[i] === '0') {
        zeroFound = true
        prefix = '0'
        i++
        const c = (s[i] ?? '').toLowerCase()
        if (c === 'b' || c === 'o' || c === 'x') {
            base = c === 'b' ? 2 : c === 'o' ? 8 : 16
            prefix += s[i++]
        } else {
            base = 8
        }
    }
    const allowed = DIGITS[base] + '_'
    let digits = ''
    while (i < s.length && allowed.includes(s[i])) digits += s[i++]
    if (digits === '' && !zeroFound) return null
    if (!underscoreOK(sign + prefix + digits)) return null
    const clean = digits.replaceAll('_', '')
    if (clean === '') {
        // `0` alone is zero; `0x` with no digits is not a number.
        return prefix === '0' ? 0n : null
    }
    const marker = base === 2 ? '0b' : base === 8 ? '0o' : base === 16 ?
        '0x' :
        ''
    const v = BigInt(marker + clean)
    return sign === '-' ? -v : v
}

function clamp (v:bigint):number {
    if (v < 1n) return 1
    if (v > BigInt(MAX_WINDOW)) return MAX_WINDOW
    return Number(v)
}

function parseOne (v:unknown, fallback:number):number|null {
    if (v === undefined || v === null) return fallback
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return null
        if (v >= MAX_WINDOW) return MAX_WINDOW
        return Math.max(Math.trunc(v), 1)
    }
    if (typeof v === 'string') {
        const n = sscanInt(v)
        return n === null ? null : clamp(n)
    }
    return null
}

// The window read_file serves, or the error result to return.
export function parseOffsetLimit (
    args:Record<string, unknown>
):Window|{ error:string } {
    const offset = parseOne(args.offset, DEFAULT_OFFSET)
    const limit = parseOne(args.limit, DEFAULT_LIMIT)
    if (offset === null || limit === null) return { error:OFFSET_LIMIT_ERROR }
    return { offset, limit }
}
