// Validation of tool-call arguments (spec 07, 2.7): required-field
// validation for every dispatched call, and type validation of the final
// tool's arguments with exact integers.

import type { FinalSpec } from './types.js'

const INTEGER = /^-?\d+$/

type Reviver = (
    key:string,
    value:unknown,
    context?:{ source?:string }
) => unknown

// An integer literal outside the safe range becomes the exact `bigint`
// (the reviver reads the literal's source text). Throws on invalid JSON.
export function parsePreservingIntegers (text:string):unknown {
    const reviver:Reviver = (_key, value, context) => {
        if (typeof value !== 'number' || Number.isSafeInteger(value)) {
            return value
        }
        const source = context?.source
        if (source !== undefined && INTEGER.test(source)) {
            return BigInt(source)
        }
        return value
    }
    return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1])
}

function isObject (v:unknown):v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function errorText (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// The required-field validation error for `input` against a tool's
// schema, or null when the call may run.
export function checkRequired (
    schema:Record<string, unknown>,
    input:string
):string|null {
    let args:unknown
    try {
        args = JSON.parse(input)
    } catch (err) {
        return `invalid JSON input: ${errorText(err)}`
    }
    if (!isObject(args)) {
        return 'invalid JSON input: arguments are not a JSON object'
    }
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const name of required) {
        if (typeof name === 'string' && !Object.hasOwn(args, name)) {
            return `missing required parameter: ${name}`
        }
    }
    return null
}

export type TypeValidation<T> =
    | { ok:true, value:T }
    | { ok:false, error:string }

// Parses the final arguments with integer preservation and decodes them
// through the caller's spec.
export function typeValidate<T> (
    text:string,
    spec:FinalSpec<T>
):TypeValidation<T> {
    let value:unknown
    try {
        value = parsePreservingIntegers(text)
    } catch {
        return { ok:false, error:'invalid JSON' }
    }
    try {
        return { ok:true, value:spec.decode(value, text) }
    } catch (err) {
        return { ok:false, error:errorText(err) }
    }
}

// Tool arguments as the object a tool's `run` and `onTurn` receive.
export function decodeArgs (input:string):Record<string, unknown> {
    let args:unknown
    try {
        args = JSON.parse(input)
    } catch (err) {
        return { error:`args parse error: ${errorText(err)}` }
    }
    if (args === null) return {}
    if (!isObject(args)) {
        return { error:'args parse error: arguments are not a JSON object' }
    }
    return args
}
