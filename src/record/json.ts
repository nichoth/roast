// pattern: Functional Core
export { compareBytes } from '../gocompat/strings.js'

// The spec index overrides the area's older HTML-escaping rule.
export function goStringify (value:unknown, indent?:number):string {
    const text = JSON.stringify(value, null, indent)
    if (text === undefined) throw new Error('value is not JSON')
    return text
}

export function compactJSON (text:string):string {
    try {
        JSON.parse(text)
    } catch {
        throw new Error('record provider response: body is not valid JSON')
    }
    let out = ''
    let quoted = false
    let escaped = false
    for (const ch of text) {
        if (quoted) {
            out += ch
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') quoted = false
        } else if (![' ', '\t', '\r', '\n'].includes(ch)) {
            out += ch
            if (ch === '"') quoted = true
        }
    }
    return out
}

export function encodeResponseBody (
    contentType:string,
    body:Uint8Array
):string {
    if (contentType === 'application/json') {
        return compactJSON(Buffer.from(body).toString('utf8'))
    }
    if (contentType === 'text/event-stream') {
        let text:string
        try {
            text = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true })
                .decode(body)
        } catch {
            throw new Error('record provider response: ' +
                'event stream is not valid UTF-8')
        }
        return goStringify(text)
    }
    throw new Error('record provider response: unsupported content type ' +
        goStringify(contentType))
}

export function rfc3339NanoUTC (d:Date):string {
    return d.toISOString().replace(/\.([0-9]*?)0+Z$/, '.$1Z')
        .replace('.Z', 'Z')
}

export function rfc3339Local (d:Date):string {
    const pad = (n:number):string => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-` +
        `${pad(d.getDate())}T${pad(d.getHours())}:` +
        `${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const offset = -d.getTimezoneOffset()
    if (offset === 0) return day + 'Z'
    const abs = Math.abs(offset)
    return day + (offset < 0 ? '-' : '+') +
        `${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function sortedMap (value:unknown):unknown {
    if (Array.isArray(value)) return value.map(sortedMap)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([key, item]) => [key, sortedMap(item)]))
}
