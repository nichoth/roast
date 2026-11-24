// Agent loop finalization (spec 07, 5.1), driven by a scripted fake
// ModelClient.
import { test } from '@substrate-system/tapzero'
import type { LlmError } from '../../src/llm/errors.js'
import {
    FinalArgumentsError,
    hasSentinel,
    ProviderError,
} from '../../src/llm/errors.js'
import { newLedger } from '../../src/llm/ledger.js'
import {
    call,
    calls,
    callPart,
    decodeSummary,
    failure,
    FINAL,
    FINAL_SCHEMA,
    finalTool,
    harness,
    lastResults,
    options,
    prose,
    readTool,
    signal,
    submit,
    turn,
    usage,
    aborted,
} from './agent-helpers.js'

const NUDGE = '__roast_continue'

function toolNames (tools:{ name:string }[]):string[] {
    return tools.map(t => t.name)
}

test('finalization: one valid submission ends the turn-budget wrap-up',
    async t => {
        const read = readTool()
        const h = harness([submit()])
        const out = await h.client.converse('sys', 'user',
            options([read, finalTool()], { maxTurns:1 }), signal())
        t.equal(out.summary, 'ok', 'result returned')
        t.equal(h.requests.length, 1, 'one call')
        t.deepEqual(toolNames(h.requests[0].tools), ['read', FINAL, NUDGE],
            'the final-phase request offers the full tool set')
    })

test('finalization: one valid submission after a budget refusal',
    async t => {
        let budget = 0
        const read = readTool()
        const h = harness([submit()], { maxOutputTokens:100 },
            { ledger:newLedger(1500) })
        const out = await h.client.converse('sys', 'user',
            options([read, finalTool()], {
                onBudgetExhausted:() => { budget++ },
            }), signal())
        t.equal(out.summary, 'ok', 'result returned')
        t.equal(h.requests.length, 1, 'one call')
        t.equal(budget, 1, 'onBudgetExhausted fired once')
        t.deepEqual(toolNames(h.requests[0].tools), ['read', FINAL, NUDGE],
            'the wrap-up request offers the full tool set')
    })

test('finalization: one valid submission after the deadline', async t => {
    let fired = 0
    const h = harness([submit()])
    const out = await h.client.converse('sys', 'user',
        options([readTool(), finalTool()], {
            workDeadline:Date.now() - 1000,
            onWorkDeadline:() => { fired++ },
        }), signal())
    t.equal(out.summary, 'ok', 'result returned')
    t.equal(h.requests.length, 1, 'one call')
    t.equal(fired, 1, 'onWorkDeadline fired once')
    t.deepEqual(toolNames(h.requests[0].tools), ['read', FINAL, NUDGE],
        'the wrap-up request offers the full tool set')
})

test('finalization: reminders never reopen exploration', async t => {
    const read = readTool()
    const h = harness([
        call('read', { path:'a' }),
        call('nope', {}),
        prose(),
        submit(),
    ])
    const out = await h.client.converse('sys', 'user',
        options([read, finalTool()], { maxTurns:1 }), signal())
    t.equal(out.summary, 'ok', 'the next valid submission succeeds')
    t.equal(read.runs, 0, 'the exploration tool never ran')
    t.equal(h.requests.length, 4, 'four calls')
    for (let i = 1; i < 4; i++) {
        const results = lastResults(h.requests[i])
        const nudge = results.find(r => r.name === NUDGE)
        t.ok(nudge && !nudge.isError,
            `request ${i + 1} carries a reminder result`)
    }
    const blocked = lastResults(h.requests[1])
        .find(r => r.name === 'read')
    t.ok(blocked?.isError, 'the exploration call got an error result')
})

test('finalization: a model that never submits is bounded', async t => {
    for (const maxAttempts of [1, 3]) {
        const h = harness(() => prose(), { maxAttempts })
        const err = await failure(h.client.converse('sys', 'user',
            options([readTool(), finalTool()], { maxTurns:1 }), signal()))
        t.ok(hasSentinel(err, 'no-final-call'), 'converse: no-final-call')
        t.equal(h.requests.length, maxAttempts,
            `converse: exactly ${maxAttempts} final responses`)

        const s = harness(() => prose(), { maxAttempts })
        const serr = await failure(s.client.completeStructured('sys', 'user',
            'result', { schema:FINAL_SCHEMA, decode:decodeSummary },
            signal()))
        t.ok(hasSentinel(serr, 'no-final-call'),
            'completeStructured: no-final-call')
        t.equal(s.requests.length, maxAttempts,
            `completeStructured: exactly ${maxAttempts} final responses`)
    }
})

test('finalization: no reminders after a cutoff', async t => {
    const budget = harness(() => prose(), { maxOutputTokens:100 },
        { ledger:newLedger(1500) })
    const berr = await failure(budget.client.converse('sys', 'user',
        options([readTool(), finalTool()]), signal()))
    t.equal(budget.requests.length, 1, 'budget: one wrap-up call')
    t.ok(hasSentinel(berr, 'budget-exhausted'), 'budget: cutoff sentinel')
    t.ok(hasSentinel(berr, 'no-final-call'), 'budget: no-final-call')

    const deadline = harness(() => prose())
    const derr = await failure(deadline.client.converse('sys', 'user',
        options([readTool(), finalTool()], {
            workDeadline:Date.now() - 1,
        }), signal()))
    t.equal(deadline.requests.length, 1, 'deadline: one wrap-up call')
    t.ok(hasSentinel(derr, 'work-deadline'), 'deadline: cutoff sentinel')
    t.ok(hasSentinel(derr, 'no-final-call'), 'deadline: no-final-call')
    t.ok(!hasSentinel(derr, 'budget-exhausted'),
        'deadline: no budget sentinel')
})

test('finalization: invalid submissions and prose share one allowance',
    async t => {
        const h = harness([submit({ summary:5 }), prose()],
            { maxAttempts:2 })
        const err = await failure(h.client.converse('sys', 'user',
            options([readTool(), finalTool()], { maxTurns:1 }), signal()))
        t.equal(h.requests.length, 2, 'two calls')
        t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
        t.ok(!(err instanceof FinalArgumentsError),
            'not the stale schema error')
        t.equal((err as LlmError).details.stopCause,
            'answered-without-final', 'stopped on the prose')
    })

test('finalization: a reminder needs ledger admission', async t => {
    const spent = usage({ uncachedInputTokens:20_000 })
    const h = harness([turn([{ type:'text', text:'hm' }], 'stop', spent)],
        { maxOutputTokens:100 }, { ledger:newLedger(10_000) })
    const err = await failure(h.client.converse('sys', 'user',
        options([readTool(), finalTool()], { maxTurns:1 }), signal()))
    t.equal(h.requests.length, 1, 'one call')
    t.ok(hasSentinel(err, 'budget-exhausted'), 'budget-exhausted')
    t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
})

test('finalization: caller cancellation during a reminder', async t => {
    const controller = new AbortController()
    const reason = new Error('caller went away')
    const h = harness([
        prose(),
        async req => {
            controller.abort(reason)
            await aborted(req.signal)
            throw req.signal.reason
        },
    ])
    const err = await failure(h.client.converse('sys', 'user',
        options([readTool(), finalTool()], { maxTurns:1 }),
        controller.signal))
    t.equal(err, reason, "the caller's abort reason")
    t.equal(h.requests.length, 2, 'two calls')
})

test('finalization: a missing required property is never accepted',
    async t => {
        const h = harness(() => submit({}), { maxAttempts:3 })
        const err = await failure(h.client.converse('sys', 'user',
            options([readTool(), finalTool()], { maxTurns:1 }), signal()))
        t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
        t.equal(h.requests.length, 3, 'bounded by maxAttempts')
        const r = lastResults(h.requests[1]).find(x => x.name === FINAL)
        t.ok(r?.isError, 'the final call got an error result')
    })

test('finalization: an exploration required-field rejection keeps the ' +
    'allowance', async t => {
    const read = readTool()
    const h = harness([submit({}), call('read', { path:'a' }), submit()],
        { maxAttempts:1 })
    const out = await h.client.converse('sys', 'user',
        options([read, finalTool()], { maxTurns:3 }), signal())
    t.equal(out.summary, 'ok', 'succeeds on the third call')
    t.equal(h.requests.length, 3, 'three calls')
    t.equal(read.runs, 1, 'exploration ran in turn 2')
})

test('finalization: an invalid submission is retried with feedback',
    async t => {
        const bad = callPart(FINAL, { summary:5 }, 'bad-1')
        const h = harness([calls(bad), submit()])
        const out = await h.client.converse('sys', 'user',
            options([readTool(), finalTool()], { maxTurns:1 }), signal())
        t.equal(out.summary, 'ok', 'the corrected submission is returned')
        t.equal(h.requests.length, 2, 'two calls')
        const feedback = lastResults(h.requests[1])
            .find(r => r.callId === 'bad-1')
        t.ok(feedback?.isError, 'validation feedback in the next request')

        const s = harness([
            call('result', { summary:5 }),
            call('result', { summary:'ok' }),
        ])
        const sout = await s.client.completeStructured('sys', 'user',
            'result', { schema:FINAL_SCHEMA, decode:decodeSummary },
            signal())
        t.equal(sout.summary, 'ok', 'structured: corrected result')
        t.equal(s.requests.length, 2, 'structured: two calls')
    })

test('finalization: a provider failure after a provisional rejection',
    async t => {
        const h = harness([
            submit({ summary:5 }),
            new ProviderError('400 Bad Request', { status:400 }),
        ])
        const err = await failure(h.client.converse('sys', 'user',
            options([readTool(), finalTool()], { maxTurns:1 }), signal()))
        t.ok(hasSentinel(err, 'endpoint'), 'reported as endpoint')
        t.ok(!(err instanceof FinalArgumentsError), 'not a schema error')
    })

test('finalization: persistently malformed final arguments', async t => {
    const h = harness(() => submit('{"summary": '), { maxAttempts:2 })
    const err = await failure(h.client.converse('sys', 'user',
        options([readTool(), finalTool()], { maxTurns:1 }), signal()))
    t.ok(err instanceof FinalArgumentsError, 'a schema error')
    t.equal((err as FinalArgumentsError).details.stopCause,
        'invalid-arguments', 'stopCause is invalid arguments')
    t.equal(h.requests.length, 2, 'bounded by maxAttempts')
})

test('finalization: an invalid final call during exploration ends the run',
    async t => {
        const h = harness([submit({ summary:5 }), submit()])
        const err = await failure(h.client.converse('sys', 'user',
            options([readTool(), finalTool()]), signal()))
        t.ok(err instanceof FinalArgumentsError, 'a schema error')
        t.equal(h.requests.length, 1, 'no reminder')
    })

test('finalization: large integers reach the caller exactly', async t => {
    const h = harness([submit('{"summary":"x","id":9007199254740993}')])
    const out = await h.client.converse('sys', 'user',
        options([finalTool()], { maxTurns:1 }), signal())
    t.equal(out.id, 9007199254740993n, 'exact bigint')
})
