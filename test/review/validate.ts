import { test } from '../helpers/test.js'
import { assignIdentity, validate } from '../../src/review/validate.js'
import { wire } from './fixtures.js'

test('validation applies forcing functions in order and keeps the floor',
    t => {
        const seen:string[] = []
        const result = validate({
            assessment:'NO_FINDINGS',
            findings:[
                wire({ severity:'bad', code_quote:'', fixed_code:'' }),
                wire({ code_quote:' \u0085', fixed_code:'' }),
                wire({ fixed_code:'\t\u3000', confidence:0 }),
                wire({ file:'ungrounded', confidence:0 }),
                wire({ confidence:0.599999 }),
                wire({ code_quote:' return value ', confidence:0.6 }),
            ],
        }, 0.6, (file, quote) => {
            seen.push(quote)
            return file !== 'ungrounded'
        })
        t.deepEqual(result.dropped.map(f => f._drop_reason), [
            'invalid_severity', 'missing_code_quote', 'missing_fixed_code',
            'ungrounded_code_quote', 'below_confidence_floor',
        ])
        t.deepEqual(seen, ['return value', 'return value', ' return value '])
        t.equal(result.findings.length, 1)
        t.equal(result.findings[0].confidence, 0.6)
        t.equal(result.assessment, 'FINDINGS_PRESENT')
        t.deepEqual(result.notes, [])
    })

test('identities are v4 UUIDs and aliases include dropped ids in collisions',
    t => {
        const r = validate({
            assessment:'',
            findings:[
                wire(), wire({ severity:'bad' }), wire(),
            ]
        }, 0)
        const all = [...r.findings, ...r.dropped]
        for (const f of all) {
            const uuid = new RegExp('^[\\da-f]{8}-[\\da-f]{4}-' +
                '4[\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}$')
            t.ok(uuid.test(f.id!))
            delete f.id
        }
        const ids = [
            'abcdef00-0000-4000-8000-000000000000',
            'abcdef10-0000-4000-8000-000000000000',
            'abcdef01-0000-4000-8000-000000000000',
        ]
        assignIdentity(r, () => ids.shift()!)
        t.deepEqual(all.map(f => f.alias), [
            'R-abcdef00', 'R-abcdef1', 'R-abcdef01',
        ])
        for (const f of all) {
            const prefix = f.alias!.slice(2)
            t.ok(prefix.length >= 6)
            t.equal(all.filter(other =>
                other.id!.replaceAll('-', '').startsWith(prefix)).length, 1)
        }
        const before = all.map(f => f.id)
        assignIdentity(r, () => { throw new Error('must preserve ids') })
        t.deepEqual(all.map(f => f.id), before)
    })

test('validation canonicalizes known severities and preserves invalid ones',
    t => {
        const input = [
            wire({ severity:' high ' }), wire({ severity:'not-real' }),
            wire({ severity:' low ', fixed_code:'' }),
        ]
        const r = validate({ assessment:'', findings:input }, 0)
        t.equal(r.findings[0].severity, 'HIGH')
        t.equal(r.dropped[0].severity, 'not-real')
        t.equal(r.dropped[0]._drop_reason, 'invalid_severity')
        t.equal(r.dropped[1].severity, 'LOW')
        t.equal(input[0].severity, ' high ', 'wire data is not mutated')
    })

test('validation demotes only FINDINGS_PRESENT when none survive', t => {
    for (const assessment of [
        'FINDINGS_PRESENT', 'NO_FINDINGS', '', 'unknown',
        'INCOMPLETE_NO_SUBMISSION',
    ]) {
        const result = validate({ assessment, findings:[] }, 0.6)
        t.equal(result.assessment, assessment === 'FINDINGS_PRESENT' ?
            'NO_FINDINGS' : assessment)
        t.deepEqual(result.findings, [])
        t.deepEqual(result.dropped, [])
    }
    t.equal(validate({ assessment:'', findings:[wire()] }, 0).findings.length,
        1, 'grounding may be disabled')
})
