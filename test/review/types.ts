import { test } from '../helpers/test.js'
import {
    parseSeverity, severityRank, SEVERITIES,
    effectiveSeverity, maxSeverity, toFinding,
} from '../../src/review/types.js'
import { wire } from './fixtures.js'

test('severity parsing accepts Go whitespace and canonicalizes case', t => {
    for (const severity of SEVERITIES) {
        t.equal(parseSeverity(`\u0085 ${severity.toLowerCase()}\n`), severity)
    }
    for (const value of ['', ' ', 'unknown', '\ufeffHIGH']) {
        t.equal(parseSeverity(value), null)
    }
    t.deepEqual(SEVERITIES.map(severityRank), [0, 1, 2, 3, 4])
    for (const value of ['', 'high', 'unknown']) {
        t.equal(severityRank(value), 0)
    }
})

test('finding conversion copies lines and serializes empty lines as null',
    t => {
        const w = wire()
        const f = toFinding(w)
        w.lines!.push(99)
        t.deepEqual(f.lines, [3])
        for (const lines of [null, []]) {
            const converted = toFinding(wire({ lines }))
            t.equal(JSON.parse(JSON.stringify(converted)).lines, null)
            t.deepEqual(Object.keys(converted), [
                'reasoning', 'severity', 'confidence', 'cwe', 'description',
                'file', 'lines', 'code_quote', 'fixed_code',
                'frontend_category',
            ])
        }
    })

test('only confirmed lower recalibrations affect severity and maximum', t => {
    const f = toFinding(wire())
    t.equal(effectiveSeverity(f), 'HIGH')
    for (const status of ['confirmed', 'refuted', 'insufficient_context']) {
        for (const severity of ['low', 'HIGH', 'CRITICAL', 'bad', '']) {
            f.verdict = { status, recalibrated_severity:severity }
            t.equal(effectiveSeverity(f),
                status === 'confirmed' && severity === 'low' ? 'LOW' : 'HIGH')
        }
    }
    t.equal(maxSeverity({ findings:[] }), -1)
    f.verdict = { status:'confirmed', recalibrated_severity:'low' }
    t.equal(maxSeverity({ findings:[f] }), 1)
    const medium = toFinding(wire({ severity:'MEDIUM' }))
    t.equal(maxSeverity({ findings:[f, medium] }), 2)
})

test('model category sentinel is normalized only at the report boundary',
    t => {
        for (const category of ['none', '', 'hooks', 'unknown']) {
            const input = wire({ frontend_category:category })
            t.equal(toFinding(input).frontend_category,
                category === 'none' ? '' : category)
            t.equal(input.frontend_category, category, 'wire is unchanged')
        }
    })
