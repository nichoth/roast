// pattern: Functional Core
import type { Meta } from './meta-types.js'
import { FIELDS, META_FIELDS } from './meta-json.js'
import { wellFormed } from '../llm/json.js'

class NumberToken {
    constructor (value:number, source:string) {
        this.value = value
        this.source = source
    }

    readonly value:number
    readonly source:string
}

const BOOLS = new Set([
    'uncommitted_only', 'staged_only', 'include_vendored', 'survey',
    'staged', 'quick', 'interactive', 'do_verify', 'captured',
])
const NUMBERS = new Set([
    'max_turns', 'confidence_floor', 'max_diff_bytes', 'max_file_ctx_bytes',
    'max_output_tokens', 'input_bytes', ...FIELDS.usage,
])
const ARRAYS = new Set([
    'argv', 'paths', 'excludes', 'files', 'langs', 'excluded_paths',
    'env_names_only', 'caveats',
])

function object (value:unknown):Record<string, unknown> {
    if (value == null) return {}
    if (typeof value !== 'object' || Array.isArray(value) ||
        value instanceof NumberToken) throw new Error('expected an object')
    return value as Record<string, unknown>
}

function scalar (key:string, value:unknown):unknown {
    if (ARRAYS.has(key)) {
        if (value == null) return []
        if (!Array.isArray(value)) throw new Error('expected an array')
        return value.map(item => scalar('', item))
    }
    if (BOOLS.has(key)) {
        if (value == null) return false
        if (typeof value !== 'boolean') throw new Error('expected boolean')
        return value
    }
    if (NUMBERS.has(key)) {
        if (value == null) return 0
        if (!(value instanceof NumberToken) ||
            !Number.isFinite(value.value)) throw new Error('expected number')
        if (key !== 'confidence_floor' && !/^-?\d+$/.test(value.source)) {
            throw new Error('expected an integer literal')
        }
        return value.value
    }
    if (value == null) return ''
    if (typeof value !== 'string') throw new Error('expected a string')
    return wellFormed(value)
}

function plain (value:unknown):unknown {
    if (value instanceof NumberToken) return value.value
    if (Array.isArray(value)) return value.map(plain)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
        .map(([key, v]) => [key, plain(v)]))
}

function struct (value:unknown, fields:readonly string[]):object {
    const source = object(value)
    return Object.fromEntries(fields.map(field => {
        const key = field.replace(/\?$/, '')
        const v = Object.hasOwn(source, key) ? source[key] : null
        let decoded:unknown
        if (['roles', 'usage'].includes(key)) {
            decoded = Object.fromEntries(Object.entries(object(v))
                .map(([role, item]) => [role,
                    struct(item, FIELDS[key === 'roles' ? 'role' : 'usage'])]))
        } else if (Object.hasOwn(FIELDS, key)) {
            decoded = struct(v, FIELDS[key])
        } else if (key === 'budgets') decoded = plain(object(v))
        else decoded = scalar(key, v)
        return [key, decoded]
    }))
}

export function decodeMeta (text:string):Meta {
    const raw:unknown = JSON.parse(text, (_key:string, value:unknown,
        context?:{ source?:string }) => {
        return typeof value === 'number' ?
            new NumberToken(value, context?.source ?? String(value)) : value
    })
    // Every declared field is decoded and type-checked above; unknown keys
    // are discarded and null/missing values become Go zero values.
    return struct(raw, META_FIELDS) as Meta
}
