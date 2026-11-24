import { test } from '../helpers/test.js'
import { toJSON } from '../../src/render/render.js'
import { fingerprint } from '../../src/review/fingerprint.js'
import { finding, report } from './fixtures.js'

test('JSON report preserves findings and field ordering', t => {
    const f = finding({ id:'id', alias:'R-123456' })
    const r = report({
        result:{
            findings:[f],
            dropped:[f],
            assessment:'FINDINGS_PRESENT',
            notes:['note']
        },
        runId:'run-1',
        prior:new Map([[fingerprint(f), 'earlier run']]),
    })
    const raw = toJSON(r)
    const out = JSON.parse(raw)
    t.deepEqual(Object.keys(out), [
        'assessment', 'dropped_findings', 'files_reviewed', 'findings',
        'mode', 'notes', 'prompt_packs', 'quick', 'run_id', 'usage',
        'verified',
    ])
    const expected = {
        ...f,
        fingerprint:fingerprint(f),
        prior_sighting:'earlier run'
    }
    t.deepEqual(out.findings, [expected])
    t.deepEqual(out.dropped_findings, [expected])
    t.deepEqual(Object.keys(out.findings[0]), [
        'reasoning', 'severity', 'confidence', 'cwe', 'description',
        'file', 'lines', 'code_quote', 'fixed_code', 'frontend_category',
        'id', 'alias', 'fingerprint', 'prior_sighting',
    ])
    t.ok(out.findings[0].fingerprint.length > 0)
    t.ok(!raw.includes('\n'))
    t.ok(!('task' in out))
})

test('JSON distinguishes absent and present empty collections', t => {
    const f = finding()
    Reflect.deleteProperty(f, 'lines')
    const r = report({
        result:{
            findings:[f],
            dropped:[],
            assessment:'FINDINGS_PRESENT'
        }
    })
    const out = JSON.parse(toJSON(r))
    for (const key of ['files_reviewed', 'prompt_packs', 'usage', 'notes']) {
        t.deepEqual(out[key], null, key + ' absent')
    }
    t.deepEqual(out.findings[0].lines, null)
    r.result.findings = [finding({ lines:[] })]
    r.filesReviewed = []
    r.promptPacks = []
    r.usage = {}
    r.result.notes = []
    const empty = JSON.parse(toJSON(r))
    t.deepEqual(empty.files_reviewed, [])
    t.deepEqual(empty.prompt_packs, [])
    t.deepEqual(empty.usage, {})
    t.deepEqual(empty.notes, [])
    t.deepEqual(empty.findings[0].lines, [])
    r.result.findings = []
    const none = JSON.parse(toJSON(r))
    t.deepEqual(none.findings, [])
    t.deepEqual(none.dropped_findings, [])
})

test('JSON includes truncation metadata only for truncated diffs', t => {
    const r = report({
        originalDiffBytes:500000,
        sizeBreakdown:[{ path:'big.ts', bytes:500000 }]
    })
    const normal = JSON.parse(toJSON(r))
    for (const key of [
        'diff_truncated', 'original_diff_bytes', 'size_breakdown',
    ]) t.ok(!(key in normal))
    r.diffTruncated = true
    const out = JSON.parse(toJSON(r))
    t.deepEqual(out.diff_truncated, true)
    t.deepEqual(out.original_diff_bytes, 500000)
    t.deepEqual(out.size_breakdown, [{ path:'big.ts', bytes:500000 }])
    t.deepEqual(Object.keys(out.size_breakdown[0]), ['path', 'bytes'])
})

test('JSON keeps raw strings and sorts budgets recursively', t => {
    const rawText = '<>&\u2028\u2029'
    const r = report({
        result:{
            findings:[finding({ description:rawText })],
            dropped:[],
            assessment:'FINDINGS_PRESENT',
            notes:[]
        },
        budgets:{ z:[{ z:2, a:1 }], a:{ z:4, a:3 } },
        usage:{
            verifier:{
                calls:1,
                output_tokens:4,
                cache_write_tokens:3,
                cached_input_tokens:2,
                uncached_input_tokens:1
            },
            finder:{
                calls:0,
                output_tokens:0,
                cache_write_tokens:0,
                cached_input_tokens:0,
                uncached_input_tokens:0
            }
        },
    })
    const raw = toJSON(r)
    const out = JSON.parse(raw)
    t.ok(raw.includes(rawText))
    t.deepEqual(out.findings[0].description, rawText)
    t.deepEqual(Object.keys(out.budgets), ['a', 'z'])
    t.deepEqual(Object.keys(out.budgets.a), ['a', 'z'])
    t.deepEqual(Object.keys(out.budgets.z[0]), ['a', 'z'])
    t.deepEqual(Object.keys(out.usage), ['finder', 'verifier'])
    t.deepEqual(Object.keys(out.usage.verifier), [
        'uncached_input_tokens', 'cached_input_tokens', 'cache_write_tokens',
        'output_tokens', 'calls',
    ])
})

test('JSON verdicts use field order and omit zero optional fields', t => {
    const f = finding({
        verdict:{
            verifier:'model',
            undecided:true,
            recalibrated_severity:'LOW',
            grounding:'guard',
            confidence:0.8,
            status:'confirmed',
            reasoning:'valid'
        },
        _drop_reason:'reason'
    })
    const r = report()
    r.result.findings = [f]
    let out = JSON.parse(toJSON(r)).findings[0]
    t.deepEqual(Object.keys(out.verdict), [
        'reasoning', 'status', 'confidence', 'grounding',
        'recalibrated_severity', 'verifier', 'undecided',
    ])
    t.deepEqual(out.verdict, f.verdict)
    t.deepEqual(Object.keys(out).slice(10), [
        'verdict', '_drop_reason', 'fingerprint',
    ])
    f.verdict = {
        reasoning:'',
        status:'confirmed',
        confidence:0,
        grounding:'',
        recalibrated_severity:'',
        verifier:'',
        undecided:false
    }
    f._drop_reason = ''
    f.id = ''
    f.alias = ''
    r.prior = new Map([[fingerprint(f), '']])
    out = JSON.parse(toJSON(r)).findings[0]
    t.deepEqual(Object.keys(out.verdict), [
        'reasoning', 'status', 'confidence', 'grounding',
    ])
    for (const key of ['_drop_reason', 'id', 'alias', 'prior_sighting']) {
        t.ok(!(key in out))
    }
})
