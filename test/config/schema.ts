// The editor schema (roast.schema.json) is generated from the zod schema
// (spec 02, "Schema"; spec 15, 5.5).
import fs from 'node:fs'
import path from 'node:path'
import { Ajv } from 'ajv'
import { parse as parseJsonc } from 'jsonc-parser'
import { test } from '../helpers/test.js'
import { ROOT } from '../helpers/spawn.js'
import { renderProjectSchema } from '../../src/config/json-schema.js'
import { EXAMPLE_CONFIGS, GATE_EXAMPLE } from './examples.js'

const SCHEMA_FILE = path.join(ROOT, 'roast.schema.json')

test('renderProjectSchema matches the committed roast.schema.json', t => {
    const text = renderProjectSchema()
    t.ok(text.endsWith('}\n'), 'ends with a newline')
    const committed = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'))
    t.deepEqual(JSON.parse(text), committed,
        'run npm run schema to regenerate roast.schema.json')
})

test('example configs validate against the generated schema', t => {
    const ajv = new Ajv({ strict:false, validateFormats:false })
    const validate = ajv.compile(JSON.parse(renderProjectSchema()))
    for (const text of [...EXAMPLE_CONFIGS, GATE_EXAMPLE]) {
        const ok = validate(parseJsonc(text, [], {
            allowTrailingComma:true,
        }))
        t.ok(ok, `valid: ${JSON.stringify(validate.errors ?? [])}`)
    }
    // The schema is not vacuous: an unknown field fails it.
    t.equal(validate({ version:1, bogus:true }), false,
        'an unknown field is invalid')
    t.equal(validate({ version:1, gate:{ severity:'SEVERE' } }), false,
        'an unknown severity is invalid')
})
