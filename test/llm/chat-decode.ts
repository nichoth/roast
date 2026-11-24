import { test } from '@substrate-system/tapzero'
import { decodeChat } from '../../src/llm/chat.js'
import { parseSse, type SseEvent } from '../../src/llm/sse.js'
import {
    IncompleteStreamError,
    ProviderError,
    isRetryable,
} from '../../src/llm/errors.js'
import {
    writeInferenceStream,
    writeJSONStream,
    type StreamSink,
} from '../helpers/inference-stream.js'

async function * events (...chunks:unknown[]):AsyncGenerator<SseEvent> {
    for (const c of chunks) {
        yield { event:'', data:typeof c === 'string' ? c : JSON.stringify(c) }
    }
}

function chunk (delta:Record<string, unknown>, finish:string|null = null,
    usage?:unknown) {
    const c:Record<string, unknown> = {
        choices:[{ index:0, delta, finish_reason:finish }],
    }
    if (usage !== undefined) c.usage = usage
    return c
}

const usageA = {
    prompt_tokens:100,
    completion_tokens:5,
    total_tokens:105,
    prompt_tokens_details:{ cached_tokens:30 }
}

class Sink implements StreamSink {
    headers:Record<string, string> = {}
    out = ''
    ended = false
    setHeader (name:string, value:string) { this.headers[name] = value }
    write (s:string) { this.out += s; return true }
    end () { this.ended = true }
}

async function * bytes (s:string) { yield new TextEncoder().encode(s) }

async function failure (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

test('chat decodes text, reasoning, and tool calls', async t => {
    const turn = await decodeChat(events(
        chunk({ reasoning_content:'think' }),
        chunk({ reasoning_content:' more' }),
        chunk({ content:'hi' }),
        chunk({
            tool_calls:[{
                index:1,
                id:'b',
                type:'function',
                function:{ name:'grep', arguments:'{"q":' }
            }]
        }),
        chunk({
            tool_calls:[{
                index:0,
                id:'a',
                function:{ name:'read', arguments:'' }
            }]
        }),
        chunk({ tool_calls:[{ index:1, function:{ arguments:'"x"}' } }] }),
        chunk({ tool_calls:[{ index:2, function:{ name:'', arguments:'' } }] }),
        chunk({}, 'tool_calls'),
        { choices:[], usage:usageA },
        '[DONE]',
    ))
    t.deepEqual(turn.parts, [
        { type:'reasoning', text:'think more' },
        { type:'text', text:'hi' },
        { type:'tool-call', id:'a', name:'read', input:'{}' },
        { type:'tool-call', id:'b', name:'grep', input:'{"q":"x"}' },
    ], 'parts, calls sorted by index, empty args become {}')
    t.equal(turn.finishReason, 'tool-calls', 'finish')
    t.equal(turn.rawFinishReason, undefined, 'no raw reason for tool-calls')
    t.equal(turn.usage.uncachedInputTokens, 70, 'uncached')
    t.equal(turn.usage.cachedInputTokens, 30, 'cached')
    t.equal(turn.usage.calls, 1, 'one call')
})

test('chat keeps the last usage across chunks without usage', async t => {
    const turn = await decodeChat(events(
        chunk({ content:'x' }, null, usageA),
        chunk({}, 'stop'),
        chunk({}, null, { total_tokens:0, prompt_tokens:999 }),
        '[DONE]',
    ))
    t.equal(turn.usage.uncachedInputTokens, 70, 'earlier usage kept')
    t.equal(turn.usage.outputTokens, 5, 'output kept')
})

test('chat finish reasons map to categories with the raw reason',
    async t => {
        const cases:[string, string, string|undefined][] = [
            ['stop', 'stop', undefined],
            ['length', 'length', 'length'],
            ['content_filter', 'content-filter', 'content_filter'],
            ['function_call', 'tool-calls', undefined],
            ['insufficient_system_resource', 'error',
                'insufficient_system_resource'],
            ['weird_new_reason', 'unknown', 'weird_new_reason'],
            ['constructor', 'unknown', 'constructor'],
        ]
        for (const [raw, category, exposed] of cases) {
            const turn = await decodeChat(events(
                chunk({ content:'x' }), chunk({}, raw), '[DONE]'))
            t.equal(turn.finishReason, category, raw)
            t.equal(turn.rawFinishReason, exposed, `${raw} raw`)
        }
    })

test('chat suppresses tool calls on abnormal finishes', async t => {
    for (const raw of ['length', 'content_filter',
        'insufficient_system_resource']) {
        const turn = await decodeChat(events(
            chunk({
                tool_calls:[{
                    index:0,
                    id:'a',
                    function:{ name:'read', arguments:'{}' }
                }]
            }),
            chunk({}, raw),
            '[DONE]'))
        t.equal(turn.parts.length, 0, `${raw}: no tool call parts`)
        t.equal(turn.rawFinishReason, raw, `${raw}: raw exposed`)
    }
})

test('chat without a finish reason', async t => {
    const done = await decodeChat(events(
        chunk({
            tool_calls:[{
                index:0,
                id:'a',
                function:{ name:'read', arguments:'{"a":1}' }
            }]
        }),
        '[DONE]'))
    t.equal(done.finishReason, 'tool-calls', 'complete calls -> tool-calls')
    for (const args of ['', '{"a":']) {
        const err = await failure(decodeChat(events(
            chunk({
                tool_calls:[{
                    index:0,
                    id:'a',
                    function:{ name:'read', arguments:args }
                }]
            })
        )))
        t.ok(err instanceof IncompleteStreamError,
            `args ${JSON.stringify(args)} -> incomplete stream`)
        t.ok(isRetryable(err), 'retryable')
    }
    const text = await failure(decodeChat(events(chunk({ content:'x' }))))
    t.ok(text instanceof IncompleteStreamError, 'text only -> incomplete')
})

test('chat stream errors, protocol errors', async t => {
    const se = await failure(decodeChat(events(
        chunk({ content:'x' }),
        { error:{ type:'server_error', message:'oops' } })))
    t.ok(se instanceof ProviderError, 'stream error')
    t.ok(isRetryable(se), 'transient type retryable')
    const bad = await failure(decodeChat(events('{not json')))
    t.ok(bad instanceof ProviderError && !isRetryable(bad),
        'malformed JSON not retryable')
    const ty = await failure(decodeChat(events(
        chunk({
            tool_calls:[{
                index:0,
                id:'a',
                type:'retrieval',
                function:{ name:'read', arguments:'{}' }
            }]
        }))))
    t.ok(ty instanceof ProviderError && !isRetryable(ty),
        'non-function call type fails, not retryable')
})

test('chat reasoning boundaries and OpenRouter reasoning', async t => {
    const turn = await decodeChat(events(
        chunk({ reasoning:'' }),
        chunk({ reasoning:'r1' }),
        chunk({ content:'t' }),
        chunk({ reasoning_content:'' }),
        chunk({ reasoning:'r2' }),
        chunk({}, 'stop'),
        '[DONE]'))
    t.deepEqual(turn.parts, [
        { type:'reasoning', text:'r1' },
        { type:'text', text:'t' },
        { type:'reasoning', text:'r2' },
    ], 'empty field after an ended reasoning opens nothing')
})

test('chat model text with lone surrogates becomes U+FFFD', async t => {
    const turn = await decodeChat(events(
        '{"choices":[{"index":0,"delta":{"content":"a\\ud800b"}}]}',
        chunk({}, 'stop'), '[DONE]'))
    t.deepEqual(turn.parts, [{ type:'text', text:'a\ufffdb' }])
})

test('writeInferenceStream chat round trip', async t => {
    const response = {
        id:'chatcmpl-1',
        object:'chat.completion',
        model:'m',
        choices:[{
            index:0,
            message:{
                role:'assistant',
                content:'',
                tool_calls:[
                    {
                        id:'call_a',
                        type:'function',
                        function:{ name:'read', arguments:'{"path":"a"}' }
                    },
                    {
                        id:'call_b',
                        type:'function',
                        function:{ name:'grep', arguments:'{"q":"b"}' }
                    },
                ],
            },
            finish_reason:'tool_calls',
        }],
        usage:usageA,
    }
    const sink = new Sink()
    writeInferenceStream(sink, 'chat', response)
    t.equal(sink.headers['Content-Type'], 'text/event-stream', 'SSE type')
    t.ok(sink.ended, 'ended')
    const raw:SseEvent[] = []
    for await (const ev of parseSse(bytes(sink.out))) raw.push(ev)
    t.equal(raw.length, 4, 'three chunks plus [DONE]')
    t.equal(raw[3].data, '[DONE]', 'DONE last')
    t.ok(raw.every(ev => ev.event === ''), 'no event lines')
    const first = JSON.parse(raw[0].data)
    t.equal(first.object, 'chat.completion.chunk', 'chunk object')
    t.deepEqual(first.choices[0].delta.tool_calls.map(
        (c:{ index:number }) => c.index), [0, 1], 're-indexed')
    t.equal(first.choices[0].finish_reason, null, 'first has no finish')
    t.deepEqual(JSON.parse(raw[2].data).choices, [], 'usage chunk')

    const turn = await decodeChat(parseSse(bytes(sink.out)))
    t.deepEqual(turn.parts, [
        { type:'tool-call', id:'call_a', name:'read', input:'{"path":"a"}' },
        { type:'tool-call', id:'call_b', name:'grep', input:'{"q":"b"}' },
    ], 'tool calls back')
    t.equal(turn.finishReason, 'tool-calls', 'finish back')
    t.equal(turn.usage.uncachedInputTokens, 70, 'usage back')
    t.equal(turn.usage.outputTokens, 5, 'output back')

    const sink2 = new Sink()
    writeJSONStream(sink2, 'chat', JSON.stringify(response))
    t.equal(sink2.out, sink.out, 'writeJSONStream parses first')
    let threw = false
    try {
        writeInferenceStream(new Sink(), 'bogus', response)
    } catch {
        threw = true
    }
    t.ok(threw, 'unknown protocol is an error')
})
