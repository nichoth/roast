// The one tool-result JSON encoder, and decoding of model text (spec 06,
// 3.5; spec.md cross-cutting "JSON encoding" and "Bytes and text").

// Object keys sorted in UTF-16 code-unit order at every depth, matching
// Go's map ordering so prompts stay stable. JSON.stringify never escapes
// `<`, `>`, `&`, U+2028 or U+2029.
export function encodeToolResult (value:unknown):string {
    return JSON.stringify(value, (_key, v:unknown) => {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
            return v
        }
        const sorted:Record<string, unknown> = {}
        for (const k of Object.keys(v).sort()) {
            sorted[k] = (v as Record<string, unknown>)[k]
        }
        return sorted
    })
}

// `s` with every lone UTF-16 surrogate replaced by U+FFFD.
export function wellFormed (s:string):string {
    let out = ''
    let start = 0
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c < 0xd800 || c > 0xdfff) continue
        if (c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1)
            if (d >= 0xdc00 && d <= 0xdfff) {
                i++
                continue
            }
        }
        out += s.slice(start, i) + '\ufffd'
        start = i + 1
    }
    return start === 0 ? s : out + s.slice(start)
}

// UTF-8 bytes from a provider as text: invalid sequences become U+FFFD.
export function decodeModelText (bytes:Uint8Array):string {
    return wellFormed(new TextDecoder('utf-8').decode(bytes))
}
