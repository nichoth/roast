// Renders roast.schema.json, the editor schema for .roast.jsonc, from the
// zod schema (spec 02, "Schema generation"; spec 15, 2.7).
import { z } from 'zod'
import { ConfigSchema } from './schema.js'

type JsonSchema = Record<string, unknown>

const SAFE_INT_BOUNDS = new Set([
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
])

function isObject (v:unknown):v is JsonSchema {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Rewrites zod's draft-7 output into the editor schema's plain form:
// - `{description, allOf:[{$ref}]}` (zod's way to describe a reference)
//   becomes `{$ref, description}`, the form editors and the Go drift
//   test read;
// - z.int()'s implicit safe-integer bounds and z.record()'s
//   `propertyNames: {type: string}` are dropped (they say nothing);
// - the literal `version` is an integer, not a number.
function tidy (node:unknown):unknown {
    if (Array.isArray(node)) return node.map(tidy)
    if (!isObject(node)) return node
    const out:JsonSchema = {}
    for (const [key, value] of Object.entries(node)) {
        if (key === 'propertyNames') continue
        if ((key === 'minimum' || key === 'maximum') &&
            SAFE_INT_BOUNDS.has(value as number)) continue
        out[key] = tidy(value)
    }
    const allOf = out.allOf
    if (Array.isArray(allOf) && allOf.length === 1 && isObject(allOf[0]) &&
        typeof allOf[0].$ref === 'string') {
        delete out.allOf
        out.$ref = allOf[0].$ref
    }
    if (out.type === 'number' && typeof out.const === 'number' &&
        Number.isInteger(out.const)) {
        out.type = 'integer'
    }
    return out
}

export function projectSchema ():JsonSchema {
    const generated = z.toJSONSchema(ConfigSchema, {
        target:'draft-7',
        io:'input',
    }) as JsonSchema
    const { $schema, ...rest } = tidy(generated) as JsonSchema
    return {
        $schema,
        $id:'https://github.com/nichoth/roast/roast.schema.json',
        title:'Roast project config (.roast.jsonc)',
        description:'Every non-secret Roast setting. Credentials come ' +
            'only from environment variables; a profile names its ' +
            'variable with api_key_env.',
        ...rest,
    }
}

// The full text of roast.schema.json.
export function renderProjectSchema ():string {
    return JSON.stringify(projectSchema(), null, 2) + '\n'
}
