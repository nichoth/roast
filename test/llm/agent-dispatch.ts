// Dispatch, retries, and ledger admission in the agent loop (spec 07,
// 5.3 to 5.5).
import { test } from '@substrate-system/tapzero'
import type { LlmError } from '../../src/llm/errors.js'
import {
    hasSentinel,
    ProviderError,
} from '../../src/llm/errors.js'
import { newLedger } from '../../src/llm/ledger.js'
import type { FinishReason, TurnInfo } from '../../src/llm/types.js'
import {
    aborted,
    call,
    calls,
    callPart,
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
} from './agent-helpers.js'

const NUDGE = '__roast_continue'

test('dispatch: prose during exploration gets a nudge', async t => {
    const h = harness([prose(), submit()])
    const out = await h.client.converse('sys', 'user',
        options([readTool(), finalTool()]), signal())
    t.equal(out.summary, 'ok', 'the conversation continues to a result')
    t.equal(h.requests.length, 2, 'two calls')
    const nudge = lastResults(h.requests[1]).find(r => r.name === NUDGE)
    t.ok(nudge && !nudge.isError, 'a nudge result was sent')
})

test('dispatch: an unknown tool gets an error result', async t => {
    const turns:TurnInfo[] = []
    const h = harness([call('nope', { a:1 }), submit()])
    const out = await h.client.converse('sys', 'user',
        options([readTool(), finalTool()], {
            onTurn:info => { turns.push(info) },
        }), signal())
    t.equal(out.summary, 'ok', 'the run recovers')
    const r = lastResults(h.requests[1]).find(x => x.name === 'nope')
    t.ok(r?.isError, 'an error result')
    t.equal(turns.length, 1, 'reported once to onTurn')
    t.equal(turns[0].tool, 'nope', 'naming the unknown tool')
    t.deepEqual(turns[0].args, { a:1 }, 'with its arguments')
})

test('dispatch: several calls run sequentially in call order', async t => {
    const log:string[] = []
    const delays:Record<string, number> = { a:30, b:0, c:10 }
    const step = {
        name:'step',
        description:'d',
        schema:{ type:'object', properties:{ k:{ type:'string' } } },
        async run (args:Record<string, unknown>) {
            const k = String(args.k)
            log.push(`start:${k}`)
            await new Promise(resolve => setTimeout(resolve, delays[k]))
            log.push(`end:${k}`)
            return k
        },
    }
    const turns:string[] = []
    const h = harness([
        calls(
            callPart('step', { k:'a' }, 'id-a'),
            callPart('step', { k:'b' }, 'id-b'),
            callPart('step', { k:'c' }, 'id-c')),
        submit(),
    ])
    await h.client.converse('sys', 'user',
        options([step, finalTool()], {
            onTurn:info => { turns.push(String(info.args.k)) },
        }), signal())
    t.deepEqual(log,
        ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'],
        'one finishes before the next starts')
    t.deepEqual(lastResults(h.requests[1]).map(r => r.callId),
        ['id-a', 'id-b', 'id-c'], 'results in call order')
    t.deepEqual(turns, ['a', 'b', 'c'], 'onTurn in call order')
})

test('dispatch: a final call suppresses exploration calls', async t => {
    const read = readTool()
    const h = harness([
        calls(callPart('read', { path:'a' }), callPart(FINAL,
            { summary:'ok' })),
    ])
    const out = await h.client.converse('sys', 'user',
        options([read, finalTool()]), signal())
    t.equal(out.summary, 'ok', 'the submission is accepted')
    t.equal(read.runs, 0, 'the exploration call never ran')
    t.equal(h.requests.length, 1, 'one call')
})

test('dispatch: abnormal finishes never dispatch any tool', async t => {
    const reasons:FinishReason[] = ['length', 'content-filter', 'error',
        'unknown']
    for (const reason of reasons) {
        const read = readTool()
        const h = harness([
            turn([
                callPart('read', { path:'a' }),
                callPart(FINAL, { summary:'ok' }),
            ], reason),
            submit(),
        ])
        const err = await failure(h.client.converse('sys', 'user',
            options([read, finalTool()]), signal()))
        t.ok(hasSentinel(err, 'no-final-call'), `${reason}: no-final-call`)
        t.equal((err as LlmError).details.finishReason, reason,
            `${reason}: names the finish reason`)
        t.equal(read.runs, 0, `${reason}: exploration not run`)
        t.equal(h.requests.length, 1, `${reason}: one call`)
    }
})

test('dispatch: the complete caller schema reaches the adapter', async t => {
    const tool = finalTool()
    const h = harness([submit()])
    await h.client.converse('sys', 'user', options([tool], { maxTurns:1 }),
        signal())
    const sent = h.requests[0].tools.find(x => x.name === FINAL)
    t.deepEqual(sent?.schema, FINAL_SCHEMA, 'schema intact')
    t.equal(sent?.schema.additionalProperties, false,
        'additionalProperties: false kept')
    t.deepEqual(tool.schema, FINAL_SCHEMA, "the caller's copy unchanged")
})

test('retry: a transient failure is retried once', async t => {
    const h = harness([
        new ProviderError('503 Service Unavailable', {
            status:503,
            headers:{ 'retry-after-ms':'1234' },
        }),
        submit(),
    ], { maxAttempts:2 })
    const out = await h.client.converse('sys', 'user',
        options([finalTool()], { maxTurns:1 }), signal())
    t.equal(out.summary, 'ok', 'the retry succeeds')
    t.equal(h.requests.length, 2, 'two requests')
    t.deepEqual(h.sleeps, [1234], 'honors retry-after-ms')
    t.equal(h.requests[0].sessionId, h.requests[1].sessionId,
        'the retry keeps the session ID')
})

test('retry: maxAttempts 1 means no retries', async t => {
    const h = harness([
        new ProviderError('503 Service Unavailable', { status:503 }),
        submit(),
    ], { maxAttempts:1 })
    const err = await failure(h.client.converse('sys', 'user',
        options([finalTool()], { maxTurns:1 }), signal()))
    t.ok(hasSentinel(err, 'endpoint'), 'endpoint')
    t.equal(h.requests.length, 1, 'one request')
})

test('ledger: a refused first exploration call goes to one wrap-up call',
    async t => {
        let budget = 0
        const read = readTool()
        const h = harness([submit()], { maxOutputTokens:100 },
            { ledger:newLedger(1500) })
        const out = await h.client.converse('sys', 'user',
            options([read, finalTool()], {
                onBudgetExhausted:() => { budget++ },
            }), signal())
        t.equal(out.summary, 'ok', 'the wrap-up succeeds')
        t.equal(h.requests.length, 1, 'one call')
        t.equal(budget, 1, 'onBudgetExhausted fired')
    })

test('ledger: aborting a call mid-flight releases its reservation',
    async t => {
        const ledger = newLedger(1_000_000)!
        const controller = new AbortController()
        const reason = new Error('stop')
        let during = -1
        const h = harness([
            async req => {
                during = ledger.outstanding()
                controller.abort(reason)
                await aborted(req.signal)
                throw req.signal.reason
            },
        ], {}, { ledger })
        const err = await failure(h.client.converse('sys', 'user',
            options([finalTool()]), controller.signal))
        t.equal(err, reason, "the caller's abort reason")
        t.ok(during > 0, 'a reservation was held during the call')
        t.ok(h.requests[0].signal.aborted, 'the request signal aborted')
        t.equal(ledger.outstanding(), 0, 'outstanding back to 0')
    })

test('dispatch: an adapter cannot mutate the caller schema', async t => {
    const tool = finalTool()
    const h = harness([
        req => {
            const s = req.tools.find(x => x.name === FINAL)!.schema
            s.additionalProperties = true
            delete s.required
            return prose()
        },
        submit(),
    ])
    await h.client.converse('sys', 'user', options([readTool(), tool]),
        signal())
    t.deepEqual(tool.schema, FINAL_SCHEMA, "the caller's copy unchanged")
    t.deepEqual(h.requests[1].tools.find(x => x.name === FINAL)?.schema,
        FINAL_SCHEMA, 'the next request sends the complete schema')
})
