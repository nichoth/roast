// JSONC parsing for .roast.json (spec 02, section 3 "Parsing pipeline",
// step 1): comments and trailing commas allowed, exactly one value, and
// objects with a null prototype so `__proto__` is an ordinary key.
import { type Node, type ParseError, parseTree } from 'jsonc-parser'

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | JsonObject

export interface JsonObject {
    [key:string]:JsonValue;
}

export interface ParsedJsonc {
    value:JsonValue;
    // Paths (keys and array indexes) of numbers whose raw token text is
    // not a plain integer, such as `1.0` or `1e3`.
    nonIntegerLexemes:(string|number)[][];
}

const PARSE_ERRORS:Record<number, string> = {
    1:'invalid symbol',
    2:'invalid number format',
    3:'property name expected',
    4:'value expected',
    5:'colon expected',
    6:'comma expected',
    7:'closing brace expected',
    8:'closing bracket expected',
    9:'config must contain exactly one JSON object',
    10:'invalid comment token',
    11:'unexpected end of comment',
    12:'unexpected end of string',
    13:'unexpected end of number',
    14:'invalid unicode',
    15:'invalid escape character',
    16:'invalid character',
}

// The 1-based line and column of `offset` in `text`.
function position (text:string, offset:number):string {
    let line = 1
    let col = 1
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            line++
            col = 1
        } else {
            col++
        }
    }
    return `line ${line}, column ${col}`
}

function describe (text:string, err:ParseError):string {
    const what = PARSE_ERRORS[err.error] ?? 'invalid JSON'
    return `${what} at ${position(text, err.offset)}`
}

// A plain integer lexeme: optional minus, then digits only.
function isIntegerLexeme (raw:string):boolean {
    let i = raw.startsWith('-') ? 1 : 0
    if (i >= raw.length) return false
    for (; i < raw.length; i++) {
        const c = raw.charCodeAt(i)
        if (c < 48 || c > 57) return false
    }
    return true
}

// An object with a null prototype.
export function newObject<T = JsonValue> ():Record<string, T> {
    return Object.create(null) as Record<string, T>
}

// Sets `obj[key]` as an own data property, even for `__proto__`.
export function setKey<T> (
    obj:Record<string, T>,
    key:string,
    value:T
):void {
    Object.defineProperty(obj, key, {
        value,
        enumerable:true,
        writable:true,
        configurable:true,
    })
}

// Parses JSONC text. Throws an Error describing the first parse error.
export function parseJsonc (text:string):ParsedJsonc {
    const errors:ParseError[] = []
    const root = parseTree(text, errors, {
        allowTrailingComma:true,
        disallowComments:false,
        allowEmptyContent:false,
    })
    if (errors.length > 0) throw new Error(describe(text, errors[0]))
    if (!root) throw new Error('value expected')

    const nonIntegerLexemes:(string|number)[][] = []
    function convert (node:Node, at:(string|number)[]):JsonValue {
        switch (node.type) {
            case 'object': {
                const obj = newObject()
                for (const prop of node.children ?? []) {
                    const [keyNode, valueNode] = prop.children ?? []
                    if (!keyNode || !valueNode) {
                        throw new Error('value expected')
                    }
                    const key = String(keyNode.value)
                    // A duplicate key keeps the last value, as in Go.
                    setKey(obj, key, convert(valueNode, [...at, key]))
                }
                return obj
            }
            case 'array':
                return (node.children ?? [])
                    .map((child, i) => convert(child, [...at, i]))
            case 'number': {
                const raw = text.slice(node.offset,
                    node.offset + node.length)
                if (!isIntegerLexeme(raw)) nonIntegerLexemes.push(at)
                return node.value as number
            }
            case 'string':
            case 'boolean':
            case 'null':
                return node.value as JsonValue
            default:
                throw new Error('value expected')
        }
    }
    return { value:convert(root, []), nonIntegerLexemes }
}

export function isJsonObject (v:unknown):v is JsonObject {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}
