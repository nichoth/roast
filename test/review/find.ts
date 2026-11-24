import { test } from '../helpers/test.js'
import {
    find, FindingAccumulator, type FindInput,
} from '../../src/review/find.js'
import { wire } from './fixtures.js'
import {
    call, harness, signal, prose, lastResults, failure,
    readTool,
} from '../llm/agent-helpers.js'
import { newLedger } from '../../src/llm/ledger.js'
import type { WireFinding } from '../../src/review/types.js'
import { AuthError } from '../../src/llm/errors.js'

function input (over:Partial<FindInput> = {}):FindInput {
    return { system:'sys', user:'diff', confidenceFloor:0.6, ...over }
}

test('finder validates single-shot and interactive structured submissions',
    async t => {
        for (const interactive of [false, true]) {
            const h = harness([call(interactive ?
                'submit_findings' : 'findings', {
                assessment:'NO_FINDINGS',
                findings:[wire({ severity:'low' }),
                    wire({ file:'b.ts', fixed_code:'' })],
            })])
            const r = await find(h.client, input({ interactive }), signal())
            t.equal(r.assessment, 'FINDINGS_PRESENT')
            t.equal(r.findings[0].severity, 'LOW')
            t.equal(r.dropped[0]._drop_reason, 'missing_fixed_code')
            t.ok(!r.incomplete)
            t.equal(h.requests.length, 1)
            t.equal(h.requests[0].system, 'sys')
            t.deepEqual(h.requests[0].tools
                .filter(tool => tool.name !== '__roast_continue')
                .map(tool => tool.name),
            interactive ? ['report_finding', 'submit_findings'] :
                ['findings'])
        }
    })

test('early reports reach capture immediately and survive a cutoff',
    async t => {
        for (const fixedCode of ['return value ?? 0', '']) {
            const captured:WireFinding[] = []
            const h = harness([
                call('report_finding', wire({ fixed_code:fixedCode })),
                () => {
                    t.equal(captured.length, 1,
                        'captured before the next call')
                    return prose('unfinished')
                },
            ], { maxAttempts:1 })
            const r = await find(h.client, input({
                interactive:true,
                maxTurns:1,
                capture:w => captured.push(w)
            }), signal())
            t.equal(captured.length, 1)
            t.equal(r.incomplete, true)
            t.equal(r.stopReason, 'budget_exhausted')
            t.equal(r.assessment, fixedCode ? 'FINDINGS_PRESENT' :
                'INCOMPLETE_NO_SUBMISSION')
            t.equal(r.findings.length, fixedCode ? 1 : 0)
            t.equal(r.dropped.length, fixedCode ? 0 : 1)
            t.equal(r.notes.length, 2)
        }
    })

test('accumulator and submissions merge last content in first-seen order',
    async t => {
        const a = wire({ description:'first' })
        const b = wire({ file:'b.ts', description:'second' })
        const refined = wire({
            severity:'LOW',
            description:'refined',
            code_quote:'return\tvalue'
        })
        const submitted = wire({ description:'final' })
        const seen:WireFinding[] = []
        const acc = new FindingAccumulator(w => seen.push(w))
        for (const w of [a, b, refined]) acc.add(w)
        t.deepEqual(acc.ordered(), [refined, b])
        t.equal(acc.count, 2)
        t.deepEqual(seen, [a, b, refined])
        const captured:WireFinding[] = []
        const h = harness([
            call('report_finding', a), call('report_finding', b),
            call('report_finding', refined),
            call('submit_findings', {
                assessment:'NO_FINDINGS',
                findings:[submitted]
            }),
        ])
        const r = await find(h.client, input({
            interactive:true,
            capture:w => captured.push(w)
        }), signal())
        t.deepEqual(r.findings.map(f => f.description), ['final', 'second'])
        t.deepEqual(captured.map(f => f.description),
            ['first', 'second', 'refined', 'final'])
        t.equal(r.assessment, 'FINDINGS_PRESENT')
        t.ok(!r.incomplete)
        for (const [i, count] of [1, 2, 2].entries()) {
            t.deepEqual(JSON.parse(lastResults(h.requests[i + 1])[0].output),
                { recorded:true, reported_so_far:count })
        }
    })

test('successful deadline wrap-up remains incomplete', async t => {
    const h = harness([call('submit_findings', {
        assessment:'NO_FINDINGS', findings:[wire()],
    })], {}, { now:() => 100 })
    const r = await find(h.client, input({ interactive:true, deadline:50 }),
        signal())
    t.equal(r.assessment, 'FINDINGS_PRESENT')
    t.equal(r.incomplete, true)
    t.equal(r.stopReason, 'deadline')
    t.equal(r.notes.length, 1)
    t.equal(h.requests.length, 1)
})

test('non-cutoff client errors and caller cancellation propagate unchanged',
    async t => {
        for (const interactive of [false, true]) {
            const error = new AuthError('rejected key')
            const h = harness([error])
            t.equal(await failure(find(h.client, input({ interactive }),
                signal())), error)
            const controller = new AbortController()
            const canceled = new Error('caller canceled')
            controller.abort(canceled)
            t.equal(await failure(find(h.client, input({ interactive }),
                controller.signal)), canceled)
        }
    })

test('invalid report JSON records an empty finding for later validation',
    async t => {
        const captured:WireFinding[] = []
        const h = harness([
            call('report_finding', '{broken'), prose(),
        ], { maxAttempts:1 })
        const r = await find(h.client, input({
            interactive:true,
            maxTurns:1,
            capture:w => captured.push(w)
        }), signal())
        t.equal(captured.length, 1)
        t.equal(captured[0]?.severity, '')
        t.equal(r.assessment, 'INCOMPLETE_NO_SUBMISSION')
        t.equal(r.incomplete, true)
        t.equal(r.dropped.length, 1)
        t.equal(r.dropped[0]?._drop_reason, 'invalid_severity')
        t.deepEqual(JSON.parse(lastResults(h.requests[1])[0].output),
            { recorded:true, reported_so_far:1 })
    })

test('accepted token-budget wrap-up is incomplete and keeps findings',
    async t => {
        // The agent's exploration admission leaves room for wrap-up.
        const h = harness([call('submit_findings', {
            assessment:'FINDINGS_PRESENT', findings:[wire()],
        })], { maxOutputTokens:100 }, { ledger:newLedger(1500) })
        const r = await find(h.client, input({
            interactive:true,
            tools:[readTool()]
        }), signal())
        t.equal(r.incomplete, true)
        t.equal(r.stopReason, 'token_budget')
        t.equal(r.findings.length, 1)
        t.equal(h.requests.length, 1)
    })

test('reported maps round-trip floats and return errors without throwing',
    async t => {
        const raw = JSON.stringify(wire()).replace('"lines":[3]',
            '"lines":[3.0,1e2]')
        const captured:WireFinding[] = []
        const h = harness([
            call('report_finding', { ...wire(), confidence:'wrong' }),
            call('report_finding', raw),
            call('submit_findings', { assessment:'NO_FINDINGS', findings:[] }),
        ])
        const r = await find(h.client, input({
            interactive:true,
            capture:w => captured.push(w)
        }), signal())
        t.equal(r.findings.length, 1)
        t.deepEqual(r.findings[0].lines, [3, 100])
        t.equal(captured.length, 1)
        const rejected = JSON.parse(lastResults(h.requests[1])[0].output)
        t.ok(rejected.error.startsWith('malformed finding: '))
        t.deepEqual(JSON.parse(lastResults(h.requests[2])[0].output),
            { recorded:true, reported_so_far:1 })
    })

test('unsubmitted conversations keep cause and map all graceful cutoffs',
    async t => {
        const reasons = ['deadline', 'token_budget', 'budget_exhausted']
        for (const reason of reasons) {
            const h = harness([prose('unfinished')], { maxAttempts:1 }, {
                now:() => 100,
                ledger:reason === 'token_budget' ? newLedger(1) : undefined,
            })
            const r = await find(h.client, input({
                interactive:true,
                maxTurns:1,
                deadline:reason === 'deadline' ? 50 : undefined,
            }), signal())
            t.equal(r.assessment, 'INCOMPLETE_NO_SUBMISSION')
            t.equal(r.incomplete, true)
            t.equal(r.stopReason, reason)
            t.deepEqual(r.findings, [])
            t.ok(r.notes[0].includes('cause: '))
            t.ok(r.notes[0].includes(reason === 'token_budget' ?
                'run token budget exhausted' : h.client.name))
        }
    })
