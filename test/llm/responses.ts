// The `responses` adapter: pure encoder, stream decoder, usage stage 1,
// and the fixture writer round trip (spec 06, 2.6.2, 2.8.2, 2.9).
import { test } from '@substrate-system/tapzero'
import {
    decodeResponses,
    encodeResponses,
    responsesUrl,
} from '../../src/llm/responses.js'
import { parseSse, type SseEvent } from '../../src/llm/sse.js'
import {
    IncompleteStreamError,
    ProviderError,
    isRetryable,
} from '../../src/llm/errors.js'
import { normalizeUsage, responsesUsage } from '../../src/llm/usage.js'
import { responsesSystemMode } from '../../src/llm/models.js'
import type {
    ConversationItem,
    ToolDefinition,
} from '../../src/llm/types.js'
import {
    writeInferenceStream,
    type StreamSink,
} from '../helpers/inference-stream.js'

const schema = {
    type:'object',
    properties:{
        path:{ type:'string' },
        range:{
            type:'object',
            properties:{ start:{ type:'integer' }, end:{ type:'integer' } },
            required:['start', 'end'],
            additionalProperties:false,
        },
    },
    required:['path'],
    additionalProperties:false,
}

const tools:ToolDefinition[] = [
    { name:'read', description:'Read a file', schema },
    { name:'done', description:'', schema:{ type:'object' } },
]

function body (model:string, items:ConversationItem[] = [], t = tools) {
    return encodeResponses({ model, maxOutputTokens:4096 }, {
        system:'sys', items, tools:t,
    })
}

async function * events (...chunks:unknown[]):AsyncGenerator<SseEvent> {
    for (const c of chunks) {
        const data = typeof c === 'string' ? c : JSON.stringify(c)
        const type = (c as { type?:string })?.type ?? ''
        yield { event:type, data }
    }
}

async function failure (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

const usage = {
    input_tokens:100,
    input_tokens_details:{ cached_tokens:30 },
    output_tokens:9,
    output_tokens_details:{ reasoning_tokens:0 },
    total_tokens:109,
}

function completed (extra:Record<string, unknown> = {}) {
    return {
        type:'response.completed',
        response:{ id:'r1', status:'completed', usage, ...extra },
    }
}

function callAdded (index:number, id:string, name:string) {
    return {
        type:'response.output_item.added',
        output_index:index,
        item:{
            type:'function_call',
            id:`fc${index}`,
            call_id:id,
            name,
            arguments:'',
        },
    }
}

function callDone (index:number, id:string, name:string, args:string) {
    return {
        type:'response.output_item.done',
        output_index:index,
        item:{
            type:'function_call',
            id:`fc${index}`,
            call_id:id,
            name,
            arguments:args,
        },
    }
}

test('responses url trims trailing slashes', t => {
    t.equal(responsesUrl('https://x.example/v1//'),
        'https://x.example/v1/responses')
})

test('responses request shape', t => {
    const b = body('gpt-5')
    t.equal(b.model, 'gpt-5', 'model verbatim')
    t.equal(b.max_output_tokens, 4096, 'max_output_tokens')
    t.equal(b.store, false, 'store false')
    t.equal(b.stream, true, 'stream')
    t.equal(b.tool_choice, 'auto', 'tool choice auto')
    for (const k of ['previous_response_id', 'include', 'reasoning']) {
        t.ok(!(k in b), `no ${k}`)
    }
    t.deepEqual(b.tools, [
        {
            type:'function',
            name:'read',
            description:'Read a file',
            parameters:schema,
            strict:false,
        },
        {
            type:'function',
            name:'done',
            description:'',
            parameters:{ type:'object' },
            strict:false,
        },
    ], 'tools carry the full schema and strict false')
    const params = (b.tools as { parameters:unknown }[])[0].parameters
    t.ok(params !== schema, 'schema is a copy')
    const none = body('m', [], [])
    t.ok(!('tools' in none) && !('tool_choice' in none),
        'no tools, no tool_choice')
})

test('responses input encoding replays everything but reasoning', t => {
    const items:ConversationItem[] = [
        { role:'user', text:'hello' },
        {
            role:'assistant',
            parts:[
                { type:'reasoning', text:'secret' },
                { type:'text', text:'a' },
                { type:'text', text:'b' },
                {
                    type:'tool-call',
                    id:'c1',
                    name:'read',
                    input:'{"path":"x"}',
                },
            ]
        },
        {
            role:'tool',
            results:[
                {
                    callId:'c1',
                    name:'read',
                    output:'contents',
                    isError:false,
                },
                { callId:'c2', name:'read', output:'boom', isError:true },
            ]
        },
        { role:'assistant', parts:[{ type:'reasoning', text:'only' }] },
    ]
    t.deepEqual(body('gpt-5', items).input, [
        { role:'developer', content:'sys' },
        { role:'user', content:[{ type:'input_text', text:'hello' }] },
        { role:'assistant', content:'a' },
        { role:'assistant', content:'b' },
        {
            type:'function_call',
            call_id:'c1',
            name:'read',
            arguments:'{"path":"x"}',
        },
        { type:'function_call_output', call_id:'c1', output:'contents' },
        { type:'function_call_output', call_id:'c2', output:'boom' },
    ])
})

test('responsesSystemMode and the encoded system prompt', t => {
    const cases:[string, string][] = [
        ['gpt-3.5-turbo', 'system'],
        ['GPT-4o', 'system'],
        ['chatgpt-4o-latest', 'system'],
        ['deepseek-chat', 'system'],
        ['o1-mini', 'remove'],
        ['openai/o1-preview', 'remove'],
        ['gpt-5', 'developer'],
        ['o3', 'developer'],
    ]
    for (const [model, mode] of cases) {
        t.equal(responsesSystemMode(model), mode, `${model} mode`)
        const input = body(model, [{ role:'user', text:'u' }])
            .input as Record<string, unknown>[]
        if (mode === 'remove') {
            t.equal(input.length, 1, `${model}: system dropped`)
            t.equal(input[0].role, 'user', `${model}: user first`)
        } else {
            t.deepEqual(input[0], { role:mode, content:'sys' },
                `${model}: system role`)
        }
    }
    const empty = encodeResponses({ model:'gpt-5', maxOutputTokens:1 }, {
        system:'', items:[{ role:'user', text:'u' }], tools:[],
    })
    t.equal((empty.input as unknown[]).length, 1, 'empty system omitted')
})

test('responses usage subtracts cached tokens once', t => {
    const u = (cached:number) => normalizeUsage(responsesUsage({
        input_tokens:100,
        input_tokens_details:{ cached_tokens:cached },
        output_tokens:7,
    }))
    t.equal(u(30).uncachedInputTokens, 70, 'cached 30 uncached')
    t.equal(u(30).cachedInputTokens, 30, 'cached 30 cached')
    t.equal(u(80).uncachedInputTokens, 20, 'cached 80 uncached')
    t.equal(u(80).cachedInputTokens, 80, 'cached 80 cached')
    t.equal(u(30).outputTokens, 7, 'output')
    const r = normalizeUsage(responsesUsage({
        input_tokens:1,
        output_tokens:4,
        output_tokens_details:{ reasoning_tokens:10 },
    }))
    t.equal(r.outputTokens, 14, 'reasoning above output is added')
})

test('responses decodes text, reasoning, tool calls, usage', async t => {
    const turn = await decodeResponses(events(
        { type:'response.created', response:{ id:'r1' } },
        { type:'response.reasoning_summary_text.delta', delta:'think' },
        { type:'response.output_text.delta', delta:'hel' },
        { type:'response.output_text.delta', delta:'lo' },
        callAdded(2, 'call_a', 'read'),
        {
            type:'response.function_call_arguments.delta',
            output_index:2,
            delta:'{"path"',
        },
        callDone(2, 'call_a', 'read', '{"path":"a"}'),
        { type:'response.something.new' },
        completed(),
    ))
    t.deepEqual(turn.parts, [
        { type:'reasoning', text:'think' },
        { type:'text', text:'hello' },
        { type:'tool-call', id:'call_a', name:'read', input:'{"path":"a"}' },
    ], 'parts in arrival order')
    t.equal(turn.finishReason, 'tool-calls', 'tool-calls finish')
    t.deepEqual(turn.usage, {
        uncachedInputTokens:70,
        cachedInputTokens:30,
        cacheWriteTokens:0,
        outputTokens:9,
        calls:1,
    }, 'usage from the terminal response')
})

test('responses ignores a done item with no open call', async t => {
    const turn = await decodeResponses(events(
        callDone(0, 'call_a', 'read', '{}'),
        { type:'response.output_text.delta', delta:'x' },
        completed(),
    ))
    t.deepEqual(turn.parts, [{ type:'text', text:'x' }], 'no call')
    t.equal(turn.finishReason, 'stop', 'stop')
})

test('responses finish mapping', async t => {
    async function finish (reason:string|undefined, call:boolean,
        type = 'response.completed') {
        const details = reason === undefined ? null : { reason }
        const evs:unknown[] = []
        if (call) {
            evs.push(callAdded(0, 'c', 'read'), callDone(0, 'c', 'read', '{}'))
        } else {
            evs.push({ type:'response.output_text.delta', delta:'t' })
        }
        evs.push({
            type,
            response:{ usage, incomplete_details:details },
        })
        return decodeResponses(events(...evs))
    }
    t.equal((await finish(undefined, false)).finishReason, 'stop',
        'absent -> stop')
    t.equal((await finish('', true)).finishReason, 'tool-calls',
        'empty with call -> tool-calls')
    const len = await finish('max_output_tokens', true,
        'response.incomplete')
    t.equal(len.finishReason, 'length', 'max_output_tokens -> length')
    t.equal(len.rawFinishReason, 'max_output_tokens', 'raw reason kept')
    t.ok(len.parts.some(p => p.type === 'tool-call'),
        'tool calls kept on length')
    t.equal((await finish('max_tokens', false)).finishReason, 'length',
        'max_tokens -> length')
    t.equal((await finish('content_filter', false)).finishReason,
        'content-filter', 'content_filter')
    t.equal((await finish('weird', false)).finishReason, 'other',
        'unknown without call -> other')
    t.equal((await finish('weird', true)).finishReason, 'tool-calls',
        'unknown with call -> tool-calls')
})

test('responses failures are not retryable', async t => {
    const failed = await failure(decodeResponses(events(
        { type:'response.output_text.delta', delta:'x' },
        {
            type:'response.failed',
            response:{ error:{ code:'server_error', message:'boom' } },
        },
    )))
    t.ok(failed instanceof ProviderError, 'response.failed provider error')
    t.equal((failed as Error).message,
        'response failed: boom (code: server_error)', 'failed message')
    t.ok(!isRetryable(failed), 'response.failed not retryable')

    const noCode = await failure(decodeResponses(events(
        { type:'response.failed', response:{ error:{ message:'boom' } } },
    )))
    t.equal((noCode as Error).message, 'response failed: boom',
        'no code suffix')

    const errored = await failure(decodeResponses(events(
        { type:'error', code:'rate_limit_error', message:'slow down' },
    )))
    t.ok(errored instanceof ProviderError, 'error event provider error')
    t.equal((errored as Error).message,
        'response error: slow down (code: rate_limit_error)',
        'error message')
    t.ok(!isRetryable(errored), 'error event not retryable')
})

test('responses stream without a terminal event is incomplete',
    async t => {
        const err = await failure(decodeResponses(events(
            { type:'response.created', response:{} },
            { type:'response.output_text.delta', delta:'x' },
        )))
        t.ok(err instanceof IncompleteStreamError, 'incomplete stream')
        t.ok(isRetryable(err), 'retryable')
        const bad = await failure(decodeResponses(events('{not json')))
        t.ok(bad instanceof ProviderError && !isRetryable(bad),
            'malformed event is a protocol error')
    })

test('responses decoding replaces lone surrogates', async t => {
    const turn = await decodeResponses(events(
        { type:'response.output_text.delta', delta:'a\ud800b' },
        completed(),
    ))
    t.deepEqual(turn.parts, [{ type:'text', text:'a\ufffdb' }])
})

class Sink implements StreamSink {
    headers:Record<string, string> = {}
    out = ''
    setHeader (name:string, value:string) { this.headers[name] = value }
    write (s:string) { this.out += s; return true }
    end () {}
}

async function * bytes (s:string) { yield new TextEncoder().encode(s) }

test('writeInferenceStream responses round trip', async t => {
    const response = {
        id:'resp_1',
        object:'response',
        model:'m',
        status:'completed',
        output:[
            {
                type:'message',
                id:'msg_1',
                role:'assistant',
                status:'completed',
                content:[{ type:'output_text', text:'hi' }],
            },
            {
                type:'function_call',
                id:'fc_1',
                call_id:'call_a',
                name:'read',
                arguments:'{"path":"a"}',
                status:'completed',
            },
        ],
        usage,
    }
    const sink = new Sink()
    writeInferenceStream(sink, 'responses', response)
    t.equal(sink.headers['Content-Type'], 'text/event-stream', 'sse')
    const parsed:{ event:string, data:Record<string, unknown> }[] = []
    for await (const ev of parseSse(bytes(sink.out))) {
        parsed.push({ event:ev.event, data:JSON.parse(ev.data) })
    }
    t.deepEqual(parsed.map(p => p.data.sequence_number),
        parsed.map((_, i) => i), 'sequence numbers in emission order')
    t.ok(parsed.every(p => p.event === p.data.type), 'event names')
    t.equal(parsed[0].data.type, 'response.created', 'created first')
    t.equal(parsed.at(-1)?.data.type, 'response.completed',
        'completed last')
    const turn = await decodeResponses(parseSse(bytes(sink.out)))
    t.deepEqual(turn.parts, [
        { type:'tool-call', id:'call_a', name:'read', input:'{"path":"a"}' },
    ], 'the fixture round-trips the tool call')
    t.equal(turn.finishReason, 'tool-calls', 'finish')
    t.equal(turn.usage.cachedInputTokens, 30, 'usage')
})
