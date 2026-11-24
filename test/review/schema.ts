import { test } from '../helpers/test.js'
import baseline from './schemas.json'
import {
    WIRE_FINDING_SCHEMA, FINDINGS_RESPONSE_SCHEMA,
    decodeWireFinding, decodeFindingsResponse,
} from '../../src/review/schema.js'
import { wire } from './fixtures.js'
import { typeValidate } from '../../src/llm/final-args.js'

test('tool schemas match the baseline JSON and are deeply frozen', t => {
    t.deepEqual(WIRE_FINDING_SCHEMA, baseline.wire)
    t.deepEqual(FINDINGS_RESPONSE_SCHEMA, baseline.response)
    function check (v:unknown):void {
        if (v === null || typeof v !== 'object') return
        t.ok(Object.isFrozen(v))
        if (!Array.isArray(v)) {
            t.deepEqual(Object.keys(v), Object.keys(v).sort())
        }
        Object.values(v).forEach(check)
    }
    check(WIRE_FINDING_SCHEMA)
    check(FINDINGS_RESPONSE_SCHEMA)
})

test('finding decoding uses exact keys, null zeros and typed fields', t => {
    const wrong = decodeWireFinding({ Severity:'HIGH' })
    t.ok(wrong.ok)
    if (wrong.ok) t.equal(wrong.value.severity, '')
    const zero = decodeWireFinding(null)
    t.deepEqual(zero, decodeWireFinding({
        reasoning:null, severity:null, confidence:null, lines:null,
    }))
    const decoded = decodeFindingsResponse({
        assessment:null,
        findings:[{
            ...wire(),
            lines:[null, -1, 3],
            description:'\ud800',
            frontend_category:'unknown',
            confidence:2
        }],
        Findings:[wire()],
    })
    t.ok(decoded.ok)
    if (decoded.ok) {
        t.equal(decoded.value.assessment, '')
        t.deepEqual(decoded.value.findings[0].lines, [0, -1, 3])
        t.equal(decoded.value.findings[0].description, '\ufffd')
        t.equal(decoded.value.findings[0].confidence, 2)
        t.equal(decoded.value.findings[0].frontend_category, 'unknown')
    }
    for (const field of Object.keys(wire())) {
        t.ok(!decodeWireFinding({ [field]:true }).ok, field)
    }
    for (const value of [[], '', 3, true]) {
        t.ok(!decodeWireFinding(value).ok)
        t.ok(!decodeFindingsResponse(value).ok)
    }
    t.ok(!decodeFindingsResponse({ assessment:3 }).ok)
    t.ok(!decodeFindingsResponse({ findings:{} }).ok)
    t.ok(!decodeFindingsResponse({ findings:[true] }).ok)
    t.deepEqual(decodeFindingsResponse(null), {
        ok:true, value:{ assessment:'', findings:[] },
    })
    t.deepEqual(decodeFindingsResponse({ findings:null }),
        decodeFindingsResponse(null))
})

test('direct final decoding preserves integer lexemes and int64 bounds', t => {
    for (const literal of ['3.0', '1e2', '3.5',
        '9223372036854775808', '-9223372036854775809']) {
        const raw = `{"findings":[{"lines":[${literal}]}]}`
        t.ok(!decodeFindingsResponse(JSON.parse(raw), raw).ok, literal)
    }
    for (const literal of ['3', '-1', '9223372036854775807',
        '-9223372036854775808', 'null']) {
        const raw = `{"findings":[{"lines":[${literal}]}]}`
        t.ok(decodeFindingsResponse(JSON.parse(raw), raw).ok, literal)
    }
    const raw = '{"findings":[{"confidence":1e2,"lines":[3]}]}'
    t.ok(decodeFindingsResponse(JSON.parse(raw), raw).ok)
    t.ok(decodeWireFinding({ lines:[3.0, 1e2] }).ok,
        'reported map already passed through float64')
    t.ok(!decodeWireFinding({ lines:[3.5] }).ok)
    t.ok(!decodeWireFinding({ lines:[Number(9223372036854775807n)] }).ok)
    const checked = typeValidate('{"findings":[{"lines":[3.0]}]}', {
        decode (value, raw) {
            const result = decodeFindingsResponse(value, raw)
            if (!result.ok) throw new Error(result.error)
            return result.value
        },
    })
    t.ok(!checked.ok, 'client final hook passes raw numeric spelling')
    const duplicates = '{"severity":"LOW","severity":"HIGH"}'
    const last = decodeWireFinding(JSON.parse(duplicates), duplicates)
    t.ok(last.ok)
    if (last.ok) t.equal(last.value.severity, 'HIGH')
})
