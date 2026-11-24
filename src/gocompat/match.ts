// Go path.Match (and filepath.Match on `/` paths): `*` matches any run of
// non-`/` characters, `?` one non-`/` character, `[...]` a class with `^`
// negation and `a-z` ranges, and `\` escapes the next character. A
// malformed pattern never matches (Go returns ErrBadPattern).
//
// A port of Go's algorithm over code points; for valid UTF-8 that is
// equivalent to Go's byte-wise comparison.

type Chars = number[]

class BadPattern extends Error {}

const SLASH = 0x2f
const STAR = 0x2a
const BACKSLASH = 0x5c
const OPEN = 0x5b
const CLOSE = 0x5d
const CARET = 0x5e
const DASH = 0x2d
const QUESTION = 0x3f

function chars (s:string):Chars {
    const out:Chars = []
    for (const ch of s) out.push(ch.codePointAt(0)!)
    return out
}

// Splits the next chunk off the pattern: leading stars, then everything
// up to the next unescaped star outside a class.
function scanChunk (pattern:Chars):[boolean, Chars, Chars] {
    let star = false
    let p = 0
    while (p < pattern.length && pattern[p] === STAR) {
        p++
        star = true
    }
    pattern = pattern.slice(p)
    let inrange = false
    let i = 0
    for (; i < pattern.length; i++) {
        const c = pattern[i]
        if (c === BACKSLASH) {
            if (i + 1 < pattern.length) i++
        } else if (c === OPEN) {
            inrange = true
        } else if (c === CLOSE) {
            inrange = false
        } else if (c === STAR && !inrange) {
            break
        }
    }
    return [star, pattern.slice(0, i), pattern.slice(i)]
}

function getEsc (chunk:Chars):[number, Chars] {
    if (chunk.length === 0 || chunk[0] === DASH || chunk[0] === CLOSE) {
        throw new BadPattern()
    }
    if (chunk[0] === BACKSLASH) {
        chunk = chunk.slice(1)
        if (chunk.length === 0) throw new BadPattern()
    }
    const r = chunk[0]
    const rest = chunk.slice(1)
    if (rest.length === 0) throw new BadPattern()
    return [r, rest]
}

// Matches one chunk against the start of `s`. Returns the unmatched rest
// of `s`, or null on no match. Keeps scanning the chunk after a failure so
// a malformed pattern always throws.
function matchChunk (chunk:Chars, s:Chars):Chars|null {
    let failed = false
    let si = 0
    while (chunk.length > 0) {
        if (!failed && si >= s.length) failed = true
        switch (chunk[0]) {
            case OPEN: {
                let r = -1
                if (!failed) r = s[si++]
                chunk = chunk.slice(1)
                let negated = false
                if (chunk.length > 0 && chunk[0] === CARET) {
                    negated = true
                    chunk = chunk.slice(1)
                }
                let match = false
                let nrange = 0
                for (;;) {
                    if (chunk.length > 0 && chunk[0] === CLOSE &&
                        nrange > 0) {
                        chunk = chunk.slice(1)
                        break
                    }
                    let lo:number
                    let hi:number
                    [lo, chunk] = getEsc(chunk)
                    hi = lo
                    if (chunk[0] === DASH) {
                        [hi, chunk] = getEsc(chunk.slice(1))
                    }
                    if (lo <= r && r <= hi) match = true
                    nrange++
                }
                if (match === negated) failed = true
                break
            }
            case QUESTION:
                if (!failed) {
                    if (s[si] === SLASH) failed = true
                    si++
                }
                chunk = chunk.slice(1)
                break
            case BACKSLASH:
                chunk = chunk.slice(1)
                if (chunk.length === 0) throw new BadPattern()
                // falls through
            default:
                if (!failed) {
                    if (chunk[0] !== s[si]) failed = true
                    si++
                }
                chunk = chunk.slice(1)
        }
    }
    return failed ? null : s.slice(si)
}

// After a star: retries the chunk after skipping i+1 characters, never
// skipping a slash. Returns the rest of the name, or null.
function matchAfterStar (chunk:Chars, name:Chars, last:boolean):Chars|null {
    for (let i = 0; i < name.length && name[i] !== SLASH; i++) {
        const t = matchChunk(chunk, name.slice(i + 1))
        // The last chunk must consume the whole name.
        if (t !== null && !(last && t.length > 0)) return t
    }
    return null
}

function match (patternStr:string, nameStr:string):boolean {
    let pattern = chars(patternStr)
    let name = chars(nameStr)
    while (pattern.length > 0) {
        let star:boolean
        let chunk:Chars
        [star, chunk, pattern] = scanChunk(pattern)
        if (star && chunk.length === 0) {
            // A trailing star matches the rest unless it holds a slash.
            return !name.includes(SLASH)
        }
        const last = pattern.length === 0
        const t = matchChunk(chunk, name)
        if (t !== null && (t.length === 0 || !last)) {
            name = t
            continue
        }
        const skipped = star ? matchAfterStar(chunk, name, last) : null
        if (skipped !== null) {
            name = skipped
            continue
        }
        // Before reporting no match, check the rest of the pattern is
        // well formed.
        while (pattern.length > 0) {
            [, chunk, pattern] = scanChunk(pattern)
            matchChunk(chunk, [])
        }
        return false
    }
    return name.length === 0
}

export function goPathMatch (pattern:string, name:string):boolean {
    try {
        return match(pattern, name)
    } catch (err) {
        if (err instanceof BadPattern) return false
        throw err
    }
}
