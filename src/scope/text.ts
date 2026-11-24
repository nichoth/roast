// Byte-level text helpers for git output (spec 04, 2.15 and 3.4).
export { compareBytes } from '../gocompat/strings.js'

// Splits on "\n" and drops empty strings (no trimming).
export function nonEmptyLines (s:string):string[] {
    return s.split('\n').filter(line => line !== '')
}

// Splits raw git output on NUL, dropping exactly one trailing empty
// element. Empty input yields no elements.
export function splitNul (buf:Buffer):Buffer[] {
    const out:Buffer[] = []
    let start = 0
    while (start < buf.length) {
        const nul = buf.indexOf(0, start)
        if (nul === -1) {
            out.push(buf.subarray(start))
            break
        }
        out.push(buf.subarray(start, nul))
        start = nul + 1
    }
    return out
}

export interface DecodedPaths {
    paths:string[];
    // Names that are not valid UTF-8 and were dropped.
    skipped:number;
}

const fatal = new TextDecoder('utf-8', { fatal:true })

// One raw name as a string, or null when it is not valid UTF-8.
export function decodeName (raw:Buffer):string|null {
    try {
        return fatal.decode(raw)
    } catch {
        return null
    }
}

// Decodes NUL-separated path names. A name that is not valid UTF-8
// cannot round-trip through a JS string, so it is skipped and counted.
export function decodePaths (buf:Buffer):DecodedPaths {
    const paths:string[] = []
    let skipped = 0
    for (const raw of splitNul(buf)) {
        const name = decodeName(raw)
        if (name === null) skipped++
        else paths.push(name)
    }
    return { paths, skipped }
}
