// RFC 8785 (JCS) canonical JSON for documents of objects, arrays, and
// strings only (spec 03, 2.4): members sorted by key in UTF-16 code-unit
// order, no whitespace, strings as ECMAScript JSON.stringify writes them.

export type CanonicalValue =
    string|CanonicalValue[]|{ [key:string]:CanonicalValue }

// Every high surrogate is followed by a low one, and every low one
// follows a high one.
function wellFormed (s:string):boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 0xdc00 && c <= 0xdfff) return false
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(i + 1)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false
            i++
        }
    }
    return true
}

function str (s:string):string {
    if (!wellFormed(s)) {
        throw new Error('canonical JSON: string contains a lone surrogate')
    }
    return JSON.stringify(s)
}

export function canonicalJson (value:CanonicalValue):string {
    if (typeof value === 'string') return str(value)
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`
    }
    // The default sort compares UTF-16 code units, as RFC 8785 requires.
    const keys = Object.keys(value).sort()
    const members = keys.map(k => `${str(k)}:${canonicalJson(value[k])}`)
    return `{${members.join(',')}}`
}
