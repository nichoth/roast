// Go time.Duration parsing and formatting. A duration is a count of
// nanoseconds held as a bigint, so the whole int64 range is exact.

export type GoDuration = bigint

const NS = 1n
const US = 1000n * NS
const MS = 1000n * US
const SECOND = 1000n * MS
const MINUTE = 60n * SECOND
const HOUR = 60n * MINUTE

const UNITS = new Map<string, bigint>([
    ['ns', NS],
    ['us', US],
    ['\u00b5s', US], // micro sign
    ['\u03bcs', US], // Greek mu
    ['ms', MS],
    ['s', SECOND],
    ['m', MINUTE],
    ['h', HOUR],
])

const LIMIT = 1n << 63n

function isDigit (c:string|undefined):boolean {
    return c !== undefined && c >= '0' && c <= '9'
}

function invalid (orig:string):Error {
    return new Error(`time: invalid duration ${JSON.stringify(orig)}`)
}

// Go time.ParseDuration: `[-+]?([0-9]*(\.[0-9]*)?[a-z]+)+`, or `0`.
// Throws on malformed input and on int64 overflow.
export function parseGoDuration (orig:string):GoDuration {
    let s = orig
    let neg = false
    if (s !== '' && (s[0] === '-' || s[0] === '+')) {
        neg = s[0] === '-'
        s = s.slice(1)
    }
    if (s === '0') return 0n
    if (s === '') throw invalid(orig)
    let d = 0n
    while (s !== '') {
        if (!(s[0] === '.' || isDigit(s[0]))) throw invalid(orig)

        // Integer part (Go leadingInt: overflow past 1<<63 is an error).
        let i = 0
        let v = 0n
        while (isDigit(s[i])) {
            v = v * 10n + BigInt(s.charCodeAt(i) - 48)
            if (v > LIMIT) throw invalid(orig)
            i++
        }
        const pre = i > 0
        s = s.slice(i)

        // Fraction (Go leadingFraction: digits past int64 precision are
        // consumed but ignored).
        let f = 0n
        let scale = 1
        let post = false
        if (s[0] === '.') {
            s = s.slice(1)
            let j = 0
            let overflow = false
            while (isDigit(s[j])) {
                if (!overflow) {
                    const y = f * 10n + BigInt(s.charCodeAt(j) - 48)
                    if (f > (LIMIT - 1n) / 10n || y > LIMIT) {
                        overflow = true
                    } else {
                        f = y
                        scale *= 10
                    }
                }
                j++
            }
            post = j > 0
            s = s.slice(j)
        }
        if (!pre && !post) throw invalid(orig)

        let k = 0
        while (k < s.length && s[k] !== '.' && !isDigit(s[k])) k++
        if (k === 0) throw invalid(orig)
        const unit = UNITS.get(s.slice(0, k))
        if (unit === undefined) throw invalid(orig)
        s = s.slice(k)

        if (v > LIMIT / unit) throw invalid(orig)
        v *= unit
        if (f > 0n) {
            // Go computes this part in float64 and truncates.
            v += BigInt(Math.trunc(Number(f) * (Number(unit) / scale)))
            if (v > LIMIT) throw invalid(orig)
        }
        d += v
        if (d > LIMIT) throw invalid(orig)
    }
    if (neg) return -d
    if (d > LIMIT - 1n) throw invalid(orig)
    return d
}

export function isGoDuration (s:string):boolean {
    try {
        parseGoDuration(s)
        return true
    } catch {
        return false
    }
}

// Whole milliseconds, truncated toward zero, for timers.
export function toMillis (ns:GoDuration):number {
    return Number(ns / MS)
}

// `v / 10**prec` as a fraction string like `.5` with trailing zeros
// dropped (empty when the fraction is zero), and the integer part.
function fmtFrac (v:bigint, prec:number):[string, bigint] {
    const base = 10n ** BigInt(prec)
    let frac = (v % base).toString().padStart(prec, '0').replace(/0+$/, '')
    if (frac !== '') frac = '.' + frac
    return [frac, v / base]
}

// Go Duration.String: `0s`; under a second `1.5ms`, `1.5\u00b5s`, `12ns`;
// otherwise `[<h>h][<m>m]<s>s` such as `3m0s` and `1h30m0s`.
export function formatGoDuration (d:GoDuration):string {
    if (d === 0n) return '0s'
    const neg = d < 0n
    let u = neg ? -d : d
    let out:string
    if (u < SECOND) {
        let prec:number
        let unit:string
        if (u < US) {
            prec = 0
            unit = 'ns'
        } else if (u < MS) {
            prec = 3
            unit = '\u00b5s'
        } else {
            prec = 6
            unit = 'ms'
        }
        const [frac, whole] = fmtFrac(u, prec)
        out = `${whole}${frac}${unit}`
    } else {
        const [frac, whole] = fmtFrac(u, 9)
        u = whole
        out = `${u % 60n}${frac}s`
        u /= 60n
        if (u > 0n) {
            out = `${u % 60n}m` + out
            u /= 60n
            if (u > 0n) out = `${u}h` + out
        }
    }
    return neg ? '-' + out : out
}
