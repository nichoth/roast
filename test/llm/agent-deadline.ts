// Record tools and the work deadline (spec 07, 5.2).
import { test } from '@substrate-system/tapzero'
import type { LlmError } from '../../src/llm/errors.js'
import {
    hasSentinel,
    ProviderError,
} from '../../src/llm/errors.js'
import {
    aborted,
    call,
    calls,
    callPart,
    failure,
    FINAL,
    finalTool,
    harness,
    options,
    readTool,
    recordTool,
    signal,
    submit,
} from './agent-helpers.js'

test('records: record-only wrap-up rounds are bounded', async t => {
    const record = recordTool()
    const h = harness(() => call('report', { title:'x' }), { maxAttempts:1 })
    const err = await failure(h.client.converse('sys', 'user',
        options([record, finalTool()], { maxTurns:1 }), signal()))
    t.equal(h.requests.length, 2, 'two calls')
    t.equal(record.runs, 2, 'two records')
    t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
    t.equal((err as LlmError).details.recordRounds, 2, 'two record rounds')
})

test('records: a deadline passing during a wrap-up record', async t => {
    let clock = 1_000_000
    let fired = 0
    const record = recordTool(() => { clock += 10_000 })
    const h = harness(() => call('report', { title:'x' }), {},
        { now:() => clock })
    const err = await failure(h.client.converse('sys', 'user',
        options([readTool(), record, finalTool()], {
            maxTurns:1,
            workDeadline:clock + 5000,
            onWorkDeadline:() => { fired++ },
        }), signal()))
    t.equal(record.runs, 1, 'the record finished')
    t.equal(fired, 1, 'onWorkDeadline fired')
    t.equal(h.requests.length, 1, 'no further call')
    t.ok(hasSentinel(err, 'work-deadline'), 'work-deadline')
    t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
})

test('records: record tools run after the deadline cutoff', async t => {
    for (const withExploration of [false, true]) {
        const record = recordTool()
        const read = readTool()
        const parts = [callPart('report', { title:'x' })]
        if (withExploration) parts.push(callPart('read', { path:'a' }))
        const h = harness(() => calls(...parts))
        const err = await failure(h.client.converse('sys', 'user',
            options([read, record, finalTool()], {
                workDeadline:Date.now() - 1,
            }), signal()))
        const label = withExploration ? 'with exploration' : 'alone'
        t.equal(record.runs, 1, `${label}: the record ran`)
        t.equal(read.runs, 0, `${label}: exploration blocked`)
        t.equal(h.requests.length, 1, `${label}: no second call`)
        t.ok(hasSentinel(err, 'work-deadline'), `${label}: work-deadline`)
    }
})

test('deadline: an exploration call cut by the deadline is replaced',
    async t => {
        let fired = 0
        const read = readTool()
        const h = harness([
            async req => {
                await aborted(req.signal)
                // A tool call buffered before the abort.
                return call('read', { path:'a' })
            },
            submit(),
        ])
        const out = await h.client.converse('sys', 'user',
            options([read, finalTool()], {
                workDeadline:Date.now() + 50,
                onWorkDeadline:() => { fired++ },
            }), signal())
        t.equal(out.summary, 'ok', 'the wrap-up submission succeeds')
        t.equal(h.requests.length, 2, 'two calls')
        t.equal(read.runs, 0, 'the buffered call never ran')
        t.equal(fired, 1, 'onWorkDeadline fired')
        t.ok(!h.requests[1].abortedAtSend,
            'the wrap-up call has a fresh window')
        t.deepEqual(h.requests[1].tools.map(x => x.name),
            ['read', FINAL, '__roast_continue'],
            'the wrap-up call keeps the full tool set')
    })

test('deadline: a failed wrap-up call after the deadline is not retried',
    async t => {
        const h = harness([
            async req => {
                await aborted(req.signal)
                throw req.signal.reason
            },
            new ProviderError('503 Service Unavailable', { status:503 }),
            submit(),
        ], { maxAttempts:3 })
        const err = await failure(h.client.converse('sys', 'user',
            options([readTool(), finalTool()], {
                workDeadline:Date.now() + 50,
            }), signal()))
        t.equal(h.requests.length, 2, 'not retried')
        t.equal(h.sleeps.length, 0, 'no retry delay')
        t.ok(hasSentinel(err, 'work-deadline'), 'work-deadline')
        t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
    })

test('deadline: an exploration tool past the deadline is not started',
    async t => {
        let clock = 1_000_000
        const read = readTool()
        const slow = {
            name:'slow',
            description:'Advances the clock past the deadline.',
            schema:{ type:'object' },
            run:() => {
                clock += 10_000
                return 'done'
            },
        }
        const h = harness([
            calls(callPart('slow'), callPart('read', { path:'a' })),
            submit(),
        ], {}, { now:() => clock })
        const out = await h.client.converse('sys', 'user',
            options([slow, read, finalTool()], {
                workDeadline:clock + 5000,
            }), signal())
        t.equal(out.summary, 'ok', 'wrap-up succeeds')
        t.equal(read.runs, 0, 'the later call was short-circuited')
        const results = h.requests[1].items
            .flatMap(i => (i.role === 'tool' ? i.results : []))
        const r = results.find(x => x.name === 'read')
        t.ok(r && !r.isError && JSON.parse(r.output).error,
            'its result is an error value')
    })

test('abort: a buffered call is never dispatched after a caller abort',
    async t => {
        const controller = new AbortController()
        const reason = new Error('cancelled')
        const read = readTool()
        const h = harness([
            () => {
                controller.abort(reason)
                return call('read', { path:'a' })
            },
        ])
        const err = await failure(h.client.converse('sys', 'user',
            options([read, finalTool()]), controller.signal))
        t.equal(err, reason, "the caller's abort reason")
        t.equal(read.runs, 0, 'the buffered call never ran')
        t.equal(h.requests.length, 1, 'one call')
    })
