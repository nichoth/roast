import { fingerprint } from '../../src/review/fingerprint.js'
import { test } from '../helpers/test.js'
import { toJSON, toMarkdown } from '../../src/render/render.js'
import { finding, report } from './fixtures.js'

test('survey coverage appears only for survey reports', t => {
    const r = report({
        reviewKind:'survey_triage',
        completion:'complete',
        manifestFileCount:2,
        stopReason:'converged'
    })
    const out = JSON.parse(toJSON(r))
    t.deepEqual(out.review_kind, 'survey_triage')
    t.deepEqual(out.completion, 'complete')
    t.deepEqual(out.manifest_file_count, 2)
    t.deepEqual(out.stop_reason, 'converged')
    t.ok(toMarkdown(r, false).split('\n')[0].startsWith('> '))
    r.reviewKind = ''
    const normal = JSON.parse(toJSON(r))
    for (const key of [
        'review_kind', 'completion', 'manifest_file_count', 'stop_reason',
    ]) t.ok(!(key in normal))
    t.ok(!toMarkdown(r, false).split('\n').some(l => l.startsWith('> ')))
    r.result.incomplete = true
    r.result.stopReason = 'deadline'
    const cutoff = JSON.parse(toJSON(r))
    t.deepEqual(cutoff.incomplete, true)
    t.deepEqual(cutoff.stop_reason, 'deadline')
    r.reviewKind = 'survey_triage'
    t.deepEqual(JSON.parse(toJSON(r)).stop_reason, 'converged')
})

test('Markdown neutralizes every untrusted finding field', t => {
    const controls = Array.from({ length:160 }, (_, i) => i)
        .filter(i => i < 32 || i >= 127)
        .map(i => String.fromCharCode(i)).join('')
    const hostile = 'value' + controls + '\n# forged'
    const f = finding({
        severity:hostile,
        alias:hostile,
        cwe:hostile,
        file:'`' + hostile,
        description:hostile,
        reasoning:hostile,
        code_quote:'first\n```\n# forged\n````\n' + hostile,
        fixed_code:'second\n`````\n' + hostile,
    })
    const r = report({ prior:new Map([[fingerprint(f), hostile]]) })
    r.result.findings = [f]
    const md = toMarkdown(r, false)
    t.ok(md.split('\n').some(l => l.startsWith('### ')))
    const rawControls = Array.from(md).filter(ch => {
        const c = ch.charCodeAt(0)
        return (c < 32 && c !== 10 && c !== 9) || (c >= 127 && c <= 159)
    })
    t.deepEqual(rawControls, [])
    t.ok(md.includes('\\x1b'))
    t.ok(md.includes('\\u009b'))
    t.ok(!md.split('\n').some(l => /^#{1,2} forged/.test(l)))
    for (const [label, expected] of [['Current', 5], ['Proposed fix', 6]]) {
        const start = md.split('\n').indexOf(`- **${label}:**`)
        const lines = md.split('\n').slice(start + 1)
        const fence = '  ' + '`'.repeat(Number(expected))
        t.deepEqual(lines[0], fence)
        const end = lines.indexOf(fence, 1)
        t.ok(end > 1)
        t.ok(lines.slice(1, end).every(l => l.startsWith('  ')))
    }
    t.deepEqual(JSON.parse(toJSON(r)).findings[0].description, hostile)
    t.ok(md.includes('`` `value'))
})

test('Markdown sorts effective severity and confidence stably', t => {
    const fs = [
        finding({ alias:'R-low', severity:'LOW', confidence:1 }),
        finding({
            alias:'R-demoted',
            severity:'CRITICAL',
            confidence:1,
            verdict:{ status:'confirmed', recalibrated_severity:'INFO' }
        }),
        finding({ alias:'R-tie1', confidence:0.9 }),
        finding({ alias:'R-high', confidence:1 }),
        finding({ alias:'R-tie2', confidence:0.9 }),
        finding({ alias:'R-medium', severity:'MEDIUM' }),
    ]
    const r = report()
    r.result.findings = fs
    const before = JSON.stringify(fs)
    const aliases = toMarkdown(r, false).split('\n')
        .filter(l => l.startsWith('### ')).map(l => l.split(' ')[1])
    t.deepEqual(aliases, [
        'R-high', 'R-tie1', 'R-tie2', 'R-medium', 'R-low', 'R-demoted',
    ])
    t.deepEqual(JSON.stringify(fs), before)
})

test('dropped findings appear only when requested, in stored order', t => {
    const r = report()
    r.result.dropped = [
        finding({
            alias:'R-drop1',
            _drop_reason:'missing_code_quote',
            code_quote:'',
            fixed_code:''
        }),
        finding({ alias:'R-drop2', _drop_reason:'refuted_by_verifier' }),
        finding({ alias:'R-drop3', _drop_reason:'bad\n# forged\u001b' }),
        finding({ alias:'R-drop4' }),
    ]
    const hidden = toMarkdown(r, false)
    t.ok(!hidden.includes('[DROPPED:'))
    t.ok(!hidden.split('\n').some(l => l.startsWith('## Dropped')))
    const shown = toMarkdown(r, true)
    t.deepEqual(shown.split('\n').filter(l => l.startsWith('### '))
        .map(l => l.split(' ')[1]),
    ['1.', 'R-drop1', 'R-drop2', 'R-drop3', 'R-drop4'])
    t.ok(shown.split('\n').some(l => l.startsWith('## Dropped')))
    t.deepEqual((shown.match(/\[DROPPED:/g) ?? []).length, 4)
    t.ok(shown.includes('[DROPPED:?]'))
    t.ok(shown.includes('bad\\n# forged\\x1b'))
    t.ok(!shown.includes('\u001b'))
    t.deepEqual((shown.match(/\*\(not provided\)\*/g) ?? []).length, 2)
})

test('recalibration is annotated only for effective severity changes', t => {
    for (const [status, severity, changed] of [
        ['confirmed', 'LOW', true],
        ['confirmed', ' high ', false],
        ['confirmed', 'CRITICAL', false],
        ['confirmed', 'nonsense', false],
        ['confirmed', '', false],
        ['insufficient_context', 'LOW', false],
    ] as const) {
        const r = report()
        r.result.findings = [finding({
            verdict:{
                status,
                recalibrated_severity:severity
            }
        })]
        const heading = toMarkdown(r, false).split('\n')
            .find(l => l.startsWith('### ')) ?? ''
        t.deepEqual(heading.includes('(finder claimed '), changed)
        if (changed) t.ok(heading.includes('[LOW ('))
    }
    const r = report()
    r.result.findings = [finding({
        confidence:0.125,
        description:'\u0085trim me\u0085'
    })]
    const heading = toMarkdown(r, false).split('\n')
        .find(l => l.startsWith('### ')) ?? ''
    t.ok(heading.includes('conf 0.12]'))
    t.ok(heading.endsWith('trim me'))
})

test('headlines distinguish empty scope, incomplete and completed runs', t => {
    const summaries = new Set<string>()
    for (const assessment of [
        'NO_DIFF', 'INCOMPLETE_NO_SUBMISSION', 'NO_FINDINGS',
    ]) {
        const r = report({
            result:{
                findings:[],
                dropped:[],
                assessment,
                notes:[]
            }
        })
        const md = toMarkdown(r, false)
        t.ok(md.startsWith('## '))
        t.ok(!md.split('\n').some(l => l.startsWith('### ')))
        summaries.add(md.split('\n')[0])
        if (assessment === 'NO_DIFF') {
            t.ok(md.includes('`--staged`'))
            t.ok(md.includes('`--base <ref>`'))
        }
    }
    t.deepEqual(summaries.size, 3)
    const r = report({ verified:true })
    const md = toMarkdown(r, false)
    t.ok(md.startsWith('## '))
    t.ok(md.split('\n').some(l => l.startsWith('### ')))
    t.ok(!summaries.has(md.split('\n')[0]))
    r.result.stopReason = 'deadline'
    t.deepEqual(toMarkdown(r, false).split('\n')
        .filter(l => l.startsWith('## ')).length, 2)
    r.result.findings = []
    r.result.assessment = 'INCOMPLETE_NO_SUBMISSION'
    t.ok(toMarkdown(r, false).split('\n')[0].includes('(deadline)'))
    r.result.stopReason = 'token_budget'
    t.ok(toMarkdown(r, false).split('\n')[0].includes('(token_budget)'))
    r.result.assessment = 'NO_DIFF'
    t.ok(!toMarkdown(r, false).split('\n')[0].includes('(token_budget)'))
})

test('verified finding renders sanitized verdict, grounding and file span',
    t => {
        const r = report({ verified:true })
        r.result.findings = [finding({
            verdict:{
                status:'confirmed',
                confidence:0.625,
                reasoning:'private verifier reasoning',
                grounding:'guard\u001b\n# forged',
                verifier:'model\u009b'
            }
        })]
        const md = toMarkdown(r, false)
        const lines = md.split('\n')
        t.ok(lines.some(l => /^- \*\*Verifier \(/.test(l)))
        t.ok(md.includes('model\\u009b'))
        t.ok(md.includes('conf 0.62'))
        t.ok(md.includes('guard\\x1b\n    # forged'))
        t.ok(lines.includes('- **File:** `main.ts:10-12`'))
        t.ok(!md.includes('private verifier reasoning'))
        t.ok(!md.includes('\u001b') && !md.includes('\u009b'))
    })
