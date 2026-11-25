import { test } from '../helpers/test.js'
import {
    verify, VERDICT_SCHEMA, SUBMIT_VERDICT_TOOL_NAME, type VerifyDeps,
} from '../../src/verify/verify.js'
import type {
    Client, ConverseOptions, RecordUsage,
} from '../../src/llm/types.js'
import { Ledger } from '../../src/llm/ledger.js'
import {
    type Finding, type Result, effectiveSeverity, toFinding,
} from '../../src/review/types.js'
import { wire } from '../review/fixtures.js'

type Reply = Record<string, unknown>|Error|
    ((user:string) => Promise<Record<string, unknown>>)

interface FakeCall {
    system:string;
    user:string;
    opts:ConverseOptions<unknown>;
}

// An in-process verifier client: each conversation is answered by
// `reply(user)`, decoded through the caller's final spec as the agent
// loop would.
function fakeClient (
    reply:(user:string, n:number) => Reply,
    name = 'verifier-model'
):Client&{ calls:FakeCall[], inFlight:number, maxInFlight:number } {
    const calls:FakeCall[] = []
    const fake = {
        name,
        calls,
        inFlight:0,
        maxInFlight:0,
        async converse<T> (
            system:string,
            user:string,
            opts:ConverseOptions<T>,
            signal:AbortSignal
        ):Promise<T> {
            const n = calls.length
            calls.push({ system, user, opts:opts as ConverseOptions<unknown> })
            fake.inFlight++
            fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight)
            try {
                signal.throwIfAborted()
                let r = reply(user, n)
                if (typeof r === 'function') r = await r(user)
                if (r instanceof Error) throw r
                return opts.final.decode(structuredClone(r),
                    JSON.stringify(r))
            } finally {
                fake.inFlight--
            }
        },
        completeStructured<T> ():Promise<T> {
            throw new Error('not used')
        },
        usage ():RecordUsage {
            return {
                uncached_input_tokens:0,
                cached_input_tokens:0,
                cache_write_tokens:0,
                output_tokens:0,
                calls:calls.length,
            }
        },
    }
    return fake
}

function finding (description:string, over:Partial<Finding> = {}):Finding {
    return { ...toFinding(wire({ description })), ...over }
}

function result (findings:Finding[], over:Partial<Result> = {}):Result {
    return {
        findings,
        dropped:[],
        assessment:'FINDINGS_PRESENT',
        notes:['a note'],
        ...over,
    }
}

function deps (over:Partial<VerifyDeps> = {}):VerifyDeps {
    return {
        systemPrompt:'verifier system',
        userPrompt:f => f.description,
        tools:[],
        maxTurns:8,
        maxVerified:0,
        ...over,
    }
}

const signal = () => new AbortController().signal

function verdict (over:Record<string, unknown> = {}):Record<string, unknown> {
    return {
        reasoning:'checked',
        status:'confirmed',
        confidence:0.9,
        grounding:'line 3 has no guard',
        ...over,
    }
}

test('a confirmed verdict keeps the finding with the verifier name',
    async t => {
        const client = fakeClient(() => verdict())
        const input = result([finding('one')])
        const out = await verify(signal(), client, input, deps())
        t.equal(out.findings.length, 1)
        t.equal(out.dropped.length, 0)
        const v = out.findings[0].verdict
        t.equal(v?.status, 'confirmed')
        t.equal(v?.confidence, 0.9)
        t.equal(v?.grounding, 'line 3 has no guard')
        t.equal(v?.verifier, 'verifier-model')
        t.ok(!v?.undecided, 'not undecided')
        t.equal(out.assessment, 'FINDINGS_PRESENT')
        t.ok(input.findings[0].verdict === undefined, 'input not mutated')
        t.equal(client.calls[0].system, 'verifier system')
        t.equal(client.calls[0].user, 'one')
        t.equal(client.calls[0].opts.finalTool, SUBMIT_VERDICT_TOOL_NAME)
        t.equal(client.calls[0].opts.maxTurns, 8)
    })

test('grounded recalibration lowers effective severity only', async t => {
    const client = fakeClient(user => verdict(user === 'grounded' ?
        { recalibrated_severity:'LOW' } :
        { recalibrated_severity:'LOW', grounding:' \t\n' }))
    const out = await verify(signal(), client,
        result([finding('grounded'), finding('ungrounded')]), deps())
    const [grounded, ungrounded] = out.findings
    t.equal(grounded.verdict?.recalibrated_severity, 'LOW')
    t.equal(grounded.severity, 'HIGH', 'finder severity unchanged')
    t.equal(effectiveSeverity(grounded), 'LOW')
    t.equal(ungrounded.verdict?.recalibrated_severity, '')
    t.equal(ungrounded.severity, 'HIGH')
    t.equal(effectiveSeverity(ungrounded), 'HIGH')
})

test('grounded refutations drop after existing dropped findings',
    async t => {
        const client = fakeClient(() => verdict({
            status:'refuted', grounding:'the caller checks for null',
        }))
        const earlier = finding('earlier', {
            _drop_reason:'missing_fixed_code',
        })
        const out = await verify(signal(), client,
            result([finding('a'), finding('b')], { dropped:[earlier] }),
            deps())
        t.equal(out.findings.length, 0)
        t.deepEqual(out.dropped.map(f => f.description),
            ['earlier', 'a', 'b'])
        t.equal(out.dropped[1]._drop_reason, 'refuted_by_verifier')
        t.equal(out.dropped[2]._drop_reason, 'refuted_by_verifier')
        t.equal(out.assessment, 'NO_FINDINGS')
    })

test('assessment is kept when findings remain or the run was incomplete',
    async t => {
        const client = fakeClient(user => verdict(user === 'gone' ?
            { status:'refuted' } : {}))
        const kept = await verify(signal(), client,
            result([finding('gone'), finding('stays')]), deps())
        t.equal(kept.assessment, 'FINDINGS_PRESENT')
        t.equal(kept.findings.length, 1)

        const incomplete = await verify(signal(),
            fakeClient(() => verdict({ status:'refuted' })),
            result([finding('gone')], {
                assessment:'INCOMPLETE_NO_SUBMISSION',
                incomplete:true,
                stopReason:'deadline',
            }), deps())
        t.equal(incomplete.findings.length, 0)
        t.equal(incomplete.assessment, 'INCOMPLETE_NO_SUBMISSION')
        t.equal(incomplete.incomplete, true)
        t.equal(incomplete.stopReason, 'deadline')
    })

test('a refutation without grounding fails open', async t => {
    for (const grounding of ['', '  \t\n']) {
        const client = fakeClient(() => verdict({
            status:'refuted', grounding, confidence:0.7,
        }))
        const out = await verify(signal(), client,
            result([finding('x')]), deps())
        t.equal(out.findings.length, 1, 'kept')
        t.equal(out.dropped.length, 0)
        const v = out.findings[0].verdict
        t.equal(v?.status, 'insufficient_context')
        t.equal(v?.undecided, true)
        t.equal(v?.confidence, 0.7, 'confidence kept')
        t.equal(v?.grounding, grounding, 'grounding kept')
    }
})

test('a loop error yields an undecided verdict and keeps the finding',
    async t => {
        const errors:Reply[] = [
            new Error('no final call'),
            { status:42 },
        ]
        for (const e of errors) {
            const client = fakeClient(() => e)
            const out = await verify(signal(), client,
                result([finding('x')]), deps())
            t.equal(out.findings.length, 1)
            const v = out.findings[0].verdict
            t.equal(v?.status, 'insufficient_context')
            t.equal(v?.undecided, true)
            t.equal(v?.confidence, 0)
            t.equal(v?.grounding, '')
            t.equal(v?.verifier, 'verifier-model')
            t.ok((v?.reasoning ?? '').length > 0, 'reason recorded')
        }
    })

test('an aborted signal yields undecided verdicts without throwing',
    async t => {
        const ac = new AbortController()
        ac.abort()
        const client = fakeClient(() => verdict())
        const out = await verify(ac.signal, client,
            result([finding('a'), finding('b')]), deps())
        t.equal(out.findings.length, 2)
        t.ok(out.findings.every(f => f.verdict?.undecided === true))
    })

test('output order equals input order when completions reverse',
    async t => {
        const names = ['a', 'b', 'c', 'd']
        const finish:Record<string, () => void> = {}
        let started = 0
        let allStarted:() => void = () => {}
        const ready = new Promise<void>(resolve => { allStarted = resolve })
        const client = fakeClient(() => async user => {
            await new Promise<void>(resolve => {
                finish[user] = resolve
                if (++started === names.length) allStarted()
            })
            return verdict({ reasoning:user })
        })
        const done = verify(signal(), client,
            result(names.map(n => finding(n))), deps())
        await ready
        for (const n of [...names].reverse()) {
            finish[n]()
            await new Promise(resolve => setImmediate(resolve))
        }
        const out = await done
        t.deepEqual(out.findings.map(f => f.description), names)
        t.deepEqual(out.findings.map(f => f.verdict?.reasoning), names)
    })

test('findings past the cap get the cap verdict without a call',
    async t => {
        const client = fakeClient(() => verdict())
        const out = await verify(signal(), client,
            result(['a', 'b', 'c'].map(n => finding(n))),
            deps({ maxVerified:1 }))
        t.equal(client.calls.length, 1)
        t.equal(client.calls[0].user, 'a')
        t.ok(!out.findings[0].verdict?.undecided)
        for (const f of out.findings.slice(1)) {
            t.equal(f.verdict?.status, 'insufficient_context')
            t.equal(f.verdict?.undecided, true)
            t.equal(f.verdict?.verifier, 'verifier-model')
            t.ok((f.verdict?.reasoning ?? '').includes('(1)'),
                'reason names the cap')
        }
    })

test('an exhausted ledger yields the budget verdict without a call',
    async t => {
        const ledger = new Ledger(10)
        t.equal(ledger.reserve(1000, 1000, true), null, 'refused')
        t.ok(ledger.exhausted())
        const client = fakeClient(() => verdict())
        const out = await verify(signal(), client,
            result([finding('a'), finding('b')]), deps({ ledger }))
        t.equal(client.calls.length, 0)
        for (const f of out.findings) {
            t.equal(f.verdict?.status, 'insufficient_context')
            t.equal(f.verdict?.undecided, true)
            t.equal(f.verdict?.verifier, 'verifier-model')
        }
    })

test('never more than `concurrency` calls are in flight', async t => {
    const client = fakeClient(() => async () => {
        await new Promise(resolve => setTimeout(resolve, 2))
        return verdict()
    })
    const findings = Array.from({ length:10 }, (_, i) => finding(`f${i}`))
    await verify(signal(), client, result(findings), deps())
    t.equal(client.calls.length, 10)
    t.equal(client.maxInFlight, 4, 'default concurrency 4')

    const two = fakeClient(() => async () => {
        await new Promise(resolve => setTimeout(resolve, 2))
        return verdict()
    })
    await verify(signal(), two, result(findings), deps({ concurrency:2 }))
    t.equal(two.maxInFlight, 2)
})

test('refuted log lines are safe and emitted in input order', async t => {
    const order:string[] = []
    const client = fakeClient(() => async user => {
        // The first finding finishes last.
        await new Promise(resolve =>
            setTimeout(resolve, user.startsWith('first') ? 20 : 1))
        order.push(user)
        return verdict({ status:'refuted', grounding:'guarded' })
    })
    const lines:string[] = []
    const hostile = 'first\u001b[2J\nline\u009b' + 'x'.repeat(200)
    await verify(signal(), client, result([
        finding(hostile, { severity:'HIGH\u0007' }),
        finding('second'),
    ]), deps({ log:l => { lines.push(l) } }))
    t.deepEqual(order.map(u => u.slice(0, 5)), ['secon', 'first'],
        'completions arrive out of order')
    t.equal(lines.length, 2)
    t.ok(lines[0].includes('first'), 'first finding logged first')
    t.ok(lines[1].includes('second'))
    for (const l of lines) {
        t.ok(![...l].some(c => c.charCodeAt(0) < 0x20 ||
            (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f)),
        'no control characters')
    }
    t.ok(lines[0].includes('\\x1b'), 'escape stays visible')
})

test('notes, assessment, incomplete and stopReason are copied',
    async t => {
        const client = fakeClient(() => verdict())
        const empty = await verify(signal(), client,
            result([finding('a')], { notes:[] }), deps())
        t.equal(empty.notes, null, 'empty notes become null')

        const input = result([finding('a')], {
            notes:['n1', 'n2'],
            assessment:'FINDINGS_PRESENT',
            incomplete:true,
            stopReason:'token_budget',
        })
        const out = await verify(signal(), client, input, deps())
        t.deepEqual(out.notes, ['n1', 'n2'])
        t.ok(out.notes !== input.notes, 'notes copied')
        t.equal(out.assessment, 'FINDINGS_PRESENT')
        t.equal(out.incomplete, true)
        t.equal(out.stopReason, 'token_budget')
    })

test('the submit_verdict tool follows the exploration tools', async t => {
    const client = fakeClient(() => verdict())
    const explore = {
        name:'read_file',
        description:'read',
        schema:{ type:'object' },
        run:() => 'x',
    }
    await verify(signal(), client, result([finding('a')]),
        deps({ tools:[explore] }))
    const tools = client.calls[0].opts.tools
    t.deepEqual(tools.map(x => x.name), ['read_file', 'submit_verdict'])
    t.ok(tools[1].run === undefined, 'final tool has no runner')
    t.deepEqual(tools[1].schema, VERDICT_SCHEMA)
})

test('VERDICT_SCHEMA matches the spec with alphabetical keys', t => {
    const expected = {
        additionalProperties:false,
        properties:{
            confidence:{ maximum:1, minimum:0, type:'number' },
            grounding:{
                description:'The exact lines / contradicting code / ' +
                    'language-semantics fact the verdict rests on',
                type:'string',
            },
            reasoning:{ type:'string' },
            recalibrated_severity:{
                description:'If the finding is real but its severity is ' +
                    'overstated, the corrected LOWER severity, justified ' +
                    'in grounding. Omit to keep the finder\'s severity. ' +
                    'Never raise severity.',
                enum:['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
                type:'string',
            },
            status:{
                enum:['confirmed', 'refuted', 'insufficient_context'],
                type:'string',
            },
        },
        required:['reasoning', 'status', 'confidence', 'grounding'],
        type:'object',
    }
    t.deepEqual(VERDICT_SCHEMA, expected)
    const sorted = (keys:string[]) => [...keys].sort()
    const check = (v:unknown):void => {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return
        const keys = Object.keys(JSON.parse(JSON.stringify(v)))
        t.deepEqual(keys, sorted(keys), 'keys alphabetical')
        for (const child of Object.values(v)) check(child)
    }
    check(VERDICT_SCHEMA)
})
