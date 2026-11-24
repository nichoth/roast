import { test } from '@substrate-system/tapzero'
import {
    anthropicUrl,
    decodeAnthropic,
    encodeAnthropic,
} from '../../src/llm/anthropic.js'
import { parseSse, type SseEvent } from '../../src/llm/sse.js'
import {
    IncompleteStreamError,
    ProviderError,
    isRetryable,
} from '../../src/llm/errors.js'
import {
    writeInferenceStream,
    type StreamSink,
} from '../helpers/inference-stream.js'
import type {
    ConversationItem,
    ToolDefinition,
} from '../../src/llm/types.js'

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

function body (
    model = 'claude-test',
    items:ConversationItem[] = [{ role:'user', text:'u' }],
    t = tools,
    maxOutputTokens = 4096
) {
    return encodeAnthropic({ model, maxOutputTokens }, {
        system:'sys', items, tools:t,
    })
}

test('anthropic url trims slashes and one trailing /v1', t => {
    t.equal(anthropicUrl('https://api.anthropic.com/v1'),
        'https://api.anthropic.com/v1/messages')
    t.equal(anthropicUrl('https://api.anthropic.com/v1//'),
        'https://api.anthropic.com/v1/messages')
    t.equal(anthropicUrl('https://gw.example/anthropic'),
        'https://gw.example/anthropic/v1/messages')
    t.equal(anthropicUrl('https://gw.example/v1/v1'),
        'https://gw.example/v1/v1/messages')
})

test('anthropic request shape', t => {
    const b = body()
    t.equal(b.model, 'claude-test', 'model verbatim')
    t.equal(b.max_tokens, 4096, 'max_tokens is the budget')
    t.equal(body('m', undefined, tools, 32768).max_tokens, 32768,
        'large budget unchanged')
    t.deepEqual(b.system, [{ type:'text', text:'sys' }], 'system blocks')
    t.equal(b.stream, true, 'stream')
    t.deepEqual(b.tool_choice, {
        type:'auto',
        disable_parallel_tool_use:false,
    }, 'auto tool choice, parallel calls allowed')
    t.ok(!('thinking' in b), 'no thinking field')
    t.ok(!JSON.stringify(b).includes('cache_control'), 'no cache_control')
    t.deepEqual(b.tools, [
        { name:'read', description:'Read a file', input_schema:schema },
        {
            name:'done',
            description:'',
            input_schema:{ type:'object', required:[] },
        },
    ], 'full input schemas, required always present')
    const noTools = body('m', undefined, [])
    t.ok(!('tools' in noTools) && !('tool_choice' in noTools),
        'tools omitted when empty')
})

test('input_schema is a deep copy', t => {
    const own = structuredClone(schema)
    const b = encodeAnthropic({ model:'m', maxOutputTokens:1 }, {
        system:'s', items:[], tools:[{ name:'x', description:'', schema:own }],
    })
    const sent = (b.tools as { input_schema:typeof schema }[])[0]
    sent.input_schema.properties.range.required.push('extra')
    t.deepEqual(own, schema, 'caller schema untouched')
})

test('claude-mythos-preview gets adaptive thinking', t => {
    t.deepEqual(body('Claude-Mythos-Preview-2').thinking,
        { type:'adaptive', display:'summarized' })
    t.ok(!('thinking' in body('claude-opus-5')), 'others none')
})

test('anthropic message grouping and replay', t => {
    const items:ConversationItem[] = [
        { role:'user', text:'one' },
        { role:'user', text:'two' },
        {
            role:'assistant',
            parts:[
                { type:'reasoning', text:'t1', signature:'s1' },
                { type:'text', text:'hello' },
                { type:'tool-call', id:'a', name:'read', input:'{"p":1}' },
                { type:'reasoning', text:'after', signature:'s2' },
                { type:'reasoning', text:'', redactedData:'RD' },
                { type:'reasoning', text:'unsigned' },
                { type:'tool-call', id:'b', name:'read', input:'' },
                { type:'tool-call', id:'c', name:'read', input:'[1]' },
                { type:'tool-call', id:'d', name:'read', input:'{bad' },
            ],
        },
        {
            role:'tool',
            results:[
                { callId:'a', name:'read', output:'x', isError:false },
                { callId:'b', name:'read', output:'y', isError:true },
            ],
        },
        { role:'user', text:'notice' },
        { role:'assistant', parts:[{ type:'text', text:'next' }] },
        { role:'assistant', parts:[{ type:'text', text:'more' }] },
        { role:'user', text:'last' },
        {
            role:'assistant',
            parts:[{
                type:'reasoning',
                text:'only',
                signature:'s3'
            }]
        },
    ]
    t.deepEqual(body('m', items).messages, [
        {
            role:'user',
            content:[
                { type:'text', text:'one' },
                { type:'text', text:'two' },
            ],
        },
        {
            role:'assistant',
            content:[
                { type:'thinking', thinking:'t1', signature:'s1' },
                { type:'text', text:'hello' },
                { type:'tool_use', id:'a', name:'read', input:{ p:1 } },
                { type:'thinking', thinking:'after', signature:'s2' },
                { type:'redacted_thinking', data:'RD' },
                { type:'tool_use', id:'b', name:'read', input:{} },
                { type:'tool_use', id:'c', name:'read', input:{} },
                { type:'tool_use', id:'d', name:'read', input:{} },
            ],
        },
        {
            role:'user',
            content:[
                {
                    type:'tool_result',
                    tool_use_id:'a',
                    content:[{ type:'text', text:'x' }],
                },
                {
                    type:'tool_result',
                    tool_use_id:'b',
                    content:[{ type:'text', text:'y' }],
                    is_error:true,
                },
                { type:'text', text:'notice' },
            ],
        },
        {
            role:'assistant',
            content:[
                { type:'text', text:'next' },
                { type:'text', text:'more' },
            ],
        },
        { role:'user', content:[{ type:'text', text:'last' }] },
    ], 'thinking-only assistant message dropped')
})

type Obj = Record<string, unknown>

async function * events (...objs:Obj[]):AsyncGenerator<SseEvent> {
    for (const o of objs) {
        yield { event:String(o.type), data:JSON.stringify(o) }
    }
}

const start = (usage:object = { input_tokens:10, output_tokens:0 }) => ({
    type:'message_start',
    message:{ id:'m', type:'message', role:'assistant', content:[], usage },
})
const blockStart = (index:number, block:object) =>
    ({ type:'content_block_start', index, content_block:block })
const delta = (index:number, d:object) =>
    ({ type:'content_block_delta', index, delta:d })
const blockStop = (index:number) => ({ type:'content_block_stop', index })
const messageDelta = (stop:string|null, usage:object = {}) =>
    ({ type:'message_delta', delta:{ stop_reason:stop }, usage })
const stop = { type:'message_stop' }

async function failure (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

test('anthropic decodes blocks by index in close order', async t => {
    const turn = await decodeAnthropic(events(
        start({
            input_tokens:10,
            cache_read_input_tokens:3,
            cache_creation_input_tokens:2,
            output_tokens:1,
        }),
        blockStart(0, { type:'thinking', thinking:'', signature:'' }),
        delta(0, { type:'thinking_delta', thinking:'hm' }),
        delta(0, { type:'thinking_delta', thinking:'m' }),
        delta(0, { type:'signature_delta', signature:'SIG' }),
        blockStop(0),
        blockStart(1, { type:'text', text:'' }),
        delta(1, { type:'text_delta', text:'hi' }),
        blockStop(1),
        blockStart(2, { type:'tool_use', id:'t1', name:'read', input:{} }),
        delta(2, { type:'input_json_delta', partial_json:'{"path"' }),
        delta(2, { type:'input_json_delta', partial_json:':"a"}' }),
        blockStop(2),
        blockStart(3, { type:'redacted_thinking', data:'RD' }),
        blockStop(3),
        blockStart(4, {
            type:'tool_use',
            id:'t2',
            name:'x',
            input:{ q:1 }
        }),
        blockStop(4),
        blockStart(5, { type:'tool_use', id:'t3', name:'y', input:{} }),
        blockStop(5),
        { type:'ping' },
        messageDelta('tool_use', { output_tokens:4, input_tokens:null }),
        stop,
    ))
    t.deepEqual(turn.parts, [
        { type:'reasoning', text:'hmm', signature:'SIG' },
        { type:'text', text:'hi' },
        { type:'tool-call', id:'t1', name:'read', input:'{"path":"a"}' },
        { type:'reasoning', text:'', redactedData:'RD' },
        { type:'tool-call', id:'t2', name:'x', input:'{"q":1}' },
        { type:'tool-call', id:'t3', name:'y', input:'{}' },
    ])
    t.equal(turn.finishReason, 'tool-calls')
    t.deepEqual(turn.usage, {
        uncachedInputTokens:10,
        cachedInputTokens:3,
        cacheWriteTokens:2,
        outputTokens:4,
        calls:1,
    })
})

test('message_delta usage replaces present fields', async t => {
    const turn = await decodeAnthropic(events(
        start({ input_tokens:10, output_tokens:0 }),
        messageDelta('end_turn', {
            output_tokens:7,
            input_tokens:12,
            cache_read_input_tokens:5,
            cache_creation_input_tokens:1,
        }),
        stop,
    ))
    t.deepEqual(turn.usage, {
        uncachedInputTokens:12,
        cachedInputTokens:5,
        cacheWriteTokens:1,
        outputTokens:7,
        calls:1,
    })
})

test('anthropic finish mapping', async t => {
    const cases:[string, string, boolean][] = [
        ['end_turn', 'stop', false],
        ['pause_turn', 'stop', false],
        ['stop_sequence', 'stop', false],
        ['max_tokens', 'length', true],
        ['model_context_window_exceeded', 'length', true],
        ['tool_use', 'tool-calls', false],
        ['refusal', 'content-filter', true],
        ['content_filtered', 'content-filter', true],
        ['guardrail_intervened', 'content-filter', true],
        ['something_new', 'unknown', true],
    ]
    for (const [raw, want, exposed] of cases) {
        const turn = await decodeAnthropic(events(
            start(), messageDelta(raw), stop))
        t.equal(turn.finishReason, want, raw)
        t.equal(turn.rawFinishReason, exposed ? raw : undefined,
            `${raw} raw exposed: ${exposed}`)
    }
})

test('missing message_stop or stop reason is incomplete', async t => {
    const noStop = await failure(decodeAnthropic(events(
        start(),
        blockStart(0, { type:'tool_use', id:'t', name:'read', input:{} }),
        delta(0, { type:'input_json_delta', partial_json:'{}' }),
        blockStop(0),
        messageDelta('tool_use'),
    )))
    t.ok(noStop instanceof IncompleteStreamError, 'no message_stop')
    t.ok(isRetryable(noStop), 'retryable')
    const empty = await failure(decodeAnthropic(events(
        start(), messageDelta(null), stop)))
    t.ok(empty instanceof IncompleteStreamError, 'empty stop reason')
})

test('anthropic error event is a stream error', async t => {
    const over = await failure(decodeAnthropic(events(start(), {
        type:'error',
        error:{ type:'overloaded_error', message:'busy' },
    })))
    t.ok(over instanceof ProviderError, 'provider error')
    t.ok(isRetryable(over), 'overloaded is retryable')
    const bad = await failure(decodeAnthropic(events(start(), {
        type:'error',
        error:{ type:'invalid_request_error', message:'no' },
    })))
    t.ok(bad instanceof ProviderError && !isRetryable(bad),
        'invalid request is not retryable')
})

test('malformed event JSON is a non-retryable protocol error', async t => {
    async function * bad ():AsyncGenerator<SseEvent> {
        yield { event:'message_start', data:'{' }
    }
    const err = await failure(decodeAnthropic(bad()))
    t.ok(err instanceof ProviderError && !isRetryable(err))
})

test('lone surrogates in model text become U+FFFD', async t => {
    async function * ev ():AsyncGenerator<SseEvent> {
        yield * events(start(), blockStart(0, { type:'text', text:'' }))
        yield {
            event:'content_block_delta',
            data:'{"type":"content_block_delta","index":0,' +
                '"delta":{"type":"text_delta","text":"a\\ud800b"}}',
        }
        yield * events(blockStop(0), messageDelta('end_turn'), stop)
    }
    const turn = await decodeAnthropic(ev())
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

test('writeInferenceStream anthropic round-trips through the decoder',
    async t => {
        const sink = new Sink()
        writeInferenceStream(sink, 'anthropic', {
            id:'msg',
            type:'message',
            role:'assistant',
            model:'claude-test',
            content:[
                { type:'thinking', thinking:'hmm', signature:'S' },
                { type:'text', text:'hi' },
                { type:'tool_use', id:'t', name:'read', input:{ a:1 } },
            ],
            stop_reason:'tool_use',
            usage:{ input_tokens:10, output_tokens:4 },
        })
        t.equal(sink.headers['Content-Type'], 'text/event-stream')
        t.ok(sink.out.startsWith('event: message_start\ndata: '),
            'named events')
        const turn = await decodeAnthropic(parseSse(bytes(sink.out)))
        t.deepEqual(turn.parts, [
            { type:'reasoning', text:'hmm', signature:'S' },
            { type:'text', text:'hi' },
            { type:'tool-call', id:'t', name:'read', input:'{"a":1}' },
        ])
        t.equal(turn.finishReason, 'tool-calls')
        t.equal(turn.usage.outputTokens, 4)
    })
