// pattern: Functional Core
// The exchange accepts the first JSON value, as Go's Decoder does.
import { parseTree } from 'jsonc-parser'

export function exchangeKey (body:string):string|null {
    const root = parseTree(body)
    if (!root) return null
    try {
        // parseTree finds the boundary; JSON.parse enforces strict JSON.
        const value:unknown = JSON.parse(body.slice(0,
            root.offset + root.length))
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null
        }
        const key = (value as Record<string, unknown>).key
        return typeof key === 'string' && key !== '' ? key : null
    } catch {
        return null
    }
}
