// pattern: Functional Core
import { wellFormed } from '../llm/json.js'
import type { WireFinding, FindingsResponse } from './types.js'

function freeze<T extends object> (value:T):T {
    for (const v of Object.values(value)) {
        if (v !== null && typeof v === 'object') freeze(v)
    }
    return Object.freeze(value)
}

export const WIRE_FINDING_SCHEMA = freeze({
    additionalProperties:false,
    properties:{
        code_quote:{
            description:'Verbatim copy of the cited lines, ' +
                'exactly as they appear in <files>',
            type:'string'
        },
        confidence:{
            maximum:1,
            minimum:0,
            type:'number'
        },
        cwe:{
            description:'CWE id when applicable, else empty string',
            type:'string'
        },
        description:{
            type:'string'
        },
        file:{
            type:'string'
        },
        fixed_code:{
            description:'Concrete replacement for code_quote ' +
                'that resolves the issue',
            type:'string'
        },
        frontend_category:{
            description:'Which frontend-addendum dimension produced this ' +
                'finding; use none for other findings',
            enum:[
                'none',
                'hooks',
                'security',
                'a11y',
                'perf',
                'ts'
            ],
            type:'string'
        },
        lines:{
            items:{
                type:'integer'
            },
            type:'array'
        },
        reasoning:{
            type:'string'
        },
        severity:{
            enum:[
                'INFO',
                'LOW',
                'MEDIUM',
                'HIGH',
                'CRITICAL'
            ],
            type:'string'
        }
    },
    required:[
        'reasoning',
        'severity',
        'confidence',
        'cwe',
        'description',
        'file',
        'lines',
        'code_quote',
        'fixed_code',
        'frontend_category'
    ],
    type:'object'
})

export const FINDINGS_RESPONSE_SCHEMA = freeze({
    additionalProperties:false,
    properties:{
        assessment:{
            enum:['FINDINGS_PRESENT', 'NO_FINDINGS'],
            type:'string',
        },
        findings:{ items:WIRE_FINDING_SCHEMA, type:'array' },
    },
    required:['assessment', 'findings'],
    type:'object',
})

export type Decoded<T> =
    | { ok:true, value:T }
    | { ok:false, error:string }

// Retain numeric spelling only for direct submission decoding. Reported
// arguments have already been parsed as float64 by the agent loop.
class NumericLiteral {
    readonly value:number
    readonly source:string

    constructor (value:number, source:string) {
        this.value = value
        this.source = source
    }
}

function parseRaw (text:string):unknown {
    return JSON.parse(text, (_key:string, value:unknown,
        context?:{ source?:string }) => {
        return typeof value === 'number' && context?.source !== undefined ?
            new NumericLiteral(value, context.source) : value
    })
}

function object (v:unknown):Record<string, unknown> {
    if (v === null) return {}
    if (typeof v !== 'object' || Array.isArray(v) ||
        v instanceof NumericLiteral) {
        throw new Error('expected an object')
    }
    return v as Record<string, unknown>
}

function field (v:Record<string, unknown>, key:string):unknown {
    return Object.hasOwn(v, key) ? v[key] : null
}

function string (value:unknown):string {
    if (value === null || value === undefined) return ''
    if (typeof value !== 'string') throw new Error('expected a string')
    return wellFormed(value)
}

function number (value:unknown):number {
    if (value === null || value === undefined) return 0
    if (value instanceof NumericLiteral) value = value.value
    if (typeof value === 'bigint') value = Number(value)
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('expected a finite number')
    }
    return value
}

function line (value:unknown):number {
    let exact:bigint
    if (value instanceof NumericLiteral) {
        if (!/^-?\d+$/.test(value.source)) {
            throw new Error('expected an integer literal in lines')
        }
        exact = BigInt(value.source)
    } else if (typeof value === 'bigint') exact = value
    else {
        const n = number(value)
        if (!Number.isInteger(n)) throw new Error('expected integer in lines')
        exact = BigInt(n)
    }
    if (exact < -9223372036854775808n || exact > 9223372036854775807n) {
        throw new Error('line outside int64 range')
    }
    return Number(exact)
}

function wire (raw:unknown):WireFinding {
    const v = object(raw)
    const lines = field(v, 'lines')
    if (lines != null && !Array.isArray(lines)) {
        throw new Error('expected an array in lines')
    }
    return {
        reasoning:string(field(v, 'reasoning')),
        severity:string(field(v, 'severity')),
        confidence:number(field(v, 'confidence')),
        cwe:string(field(v, 'cwe')),
        description:string(field(v, 'description')),
        file:string(field(v, 'file')),
        lines:lines == null ? null : lines.map(line),
        code_quote:string(field(v, 'code_quote')),
        fixed_code:string(field(v, 'fixed_code')),
        frontend_category:string(field(v, 'frontend_category')),
    }
}

function decode<T> (fn:() => T):Decoded<T> {
    try {
        return { ok:true, value:fn() }
    } catch (err) {
        return {
            ok:false,
            error:err instanceof Error ?
                err.message : String(err)
        }
    }
}

export function decodeWireFinding (
    raw:unknown,
    rawText?:string
):Decoded<WireFinding> {
    return decode(() => wire(rawText === undefined ? raw : parseRaw(rawText)))
}

export function decodeFindingsResponse (
    raw:unknown,
    rawText?:string
):Decoded<FindingsResponse> {
    return decode(() => {
        const v = object(rawText === undefined ? raw : parseRaw(rawText))
        const findings = field(v, 'findings')
        if (findings != null && !Array.isArray(findings)) {
            throw new Error('expected an array in findings')
        }
        return {
            assessment:string(field(v, 'assessment')),
            findings:findings == null ? [] : findings.map(wire),
        }
    })
}
