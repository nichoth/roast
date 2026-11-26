// The agent loop over the real `chat` adapter against the fake inference
// server (spec 07, 5.2, 5.5, and 5.6 [HTTP] items).
import type { ServerResponse } from 'node:http'
import { test, type CleanupTest } from '../helpers/test.js'
import {
    startInferenceServer,
    type InferenceServer,
    type Script,
} from '../helpers/inference-server.js'
import { createClient, createModelClient } from '../../src/llm/client.js'
import type { LlmError } from '../../src/llm/errors.js'
import { hasSentinel } from '../../src/llm/errors.js'
import { defaultSleep, type Sleep } from '../../src/llm/retry.js'
import type { ClientConfig } from '../../src/llm/types.js'
import {
    failure,
    finalTool,
    options,
    readTool,
    signal,
} from './agent-helpers.js'

async function server (t:CleanupTest, script:Script):Promise<InferenceServer> {
    const s = await startInferenceServer(script)
    t.cleanup(() => s.close())
    return s
}

function cfg (url:string, over:Partial<ClientConfig> = {}):ClientConfig {
    return {
        role:'finder',
        baseUrl:`${url}/v1`,
        apiKey:'sk-test',
        model:'deepseek-chat',
        protocol:'chat',
        maxOutputTokens:4096,
        maxAttempts:0,
        requestTimeoutMs:0,
        ...over,
    }
}

const USAGE = { prompt_tokens:10, completion_tokens:2, total_tokens:12 }

function response (
    message:Record<string, unknown>,
    finish:string,
    usage:unknown = USAGE
) {
    return {
        id:'c1',
        model:'m',
        choices:[{
            index:0,
            message:{ role:'assistant', ...message },
            finish_reason:finish,
        }],
        usage,
    }
}

function toolCall (name:string, args:unknown, id = 'call-1') {
    return response({
        tool_calls:[{
            id,
            type:'function',
            function:{ name, arguments:JSON.stringify(args) },
        }],
    }, 'tool_calls')
}

function client (
    url:string,
    over:Partial<ClientConfig> = {},
    sleep:Sleep = async () => {}
) {
    return createClient(createModelClient(cfg(url, over)), {
        sleep,
    })
}

test('http: usage normalization through Client.usage()', async t => {
    const s = await server(t, () => ({
        stream:{
            ...toolCall('submit', { summary:'ok' }),
            usage:{
                prompt_tokens:8,
                prompt_tokens_details:{ cached_tokens:4 },
                completion_tokens:3,
                total_tokens:11,
            },
        },
    }))
    const c = client(s.url)
    await c.converse('sys', 'user', options([finalTool()], { maxTurns:1 }),
        signal())
    t.deepEqual(c.usage(), {
        uncached_input_tokens:4,
        cached_input_tokens:4,
        cache_write_tokens:0,
        output_tokens:3,
        calls:1,
    }, 'disjoint counts, cached subtracted once')
})

test('http: a truncated response names finish reason length', async t => {
    const s = await server(t, () => ({
        stream:response({ content:'partial' }, 'length'),
    }))
    const err = await failure(client(s.url).converse('sys', 'user',
        options([readTool(), finalTool()]), signal()))
    t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
    t.equal((err as LlmError).details.finishReason, 'length',
        'details name finish reason length')
    t.equal((err as LlmError).details.stopCause, 'finish-reason',
        'stopped on the finish reason')
    t.equal(s.requests.length, 1, 'not retried')
})

test('http: prose names the model and the attempt count', async t => {
    const s = await server(t, () => ({
        stream:response({ content:'looks fine' }, 'stop'),
    }))
    const err = await failure(client(s.url, { maxAttempts:2 }).converse(
        'sys', 'user', options([readTool(), finalTool()], { maxTurns:1 }),
        signal()))
    const details = (err as LlmError).details
    t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
    t.equal(details.model, 'deepseek-chat', 'names the model')
    t.equal(details.submissionAttempts, 2, 'names the attempt count')
    t.equal(details.stopCause, 'answered-without-final', 'prose')
})

test('http: a reasoning-only length finish is a no-submission error',
    async t => {
        const s = await server(t, () => ({
            stream:response({ reasoning_content:'thinking hard' }, 'length'),
        }))
        const err = await failure(client(s.url, { maxAttempts:3 }).converse(
            'sys', 'user', options([readTool(), finalTool()]), signal()))
        t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
        t.ok(!hasSentinel(err, 'endpoint'), 'not endpoint')
        t.equal((err as LlmError).details.finishReason, 'length',
            'names the ceiling')
        t.equal(s.requests.length, 1, 'one request')
    })

test('http: one session ID per conversation', async t => {
    const s = await server(t, (req, n) => {
        if (n === 0) return { status:503, body:'{"error":{"message":"busy"}}' }
        if (n === 1) return { stream:toolCall('submit', { summary:5 }) }
        return { stream:toolCall('submit', { summary:'ok' }) }
    })
    const c = client(s.url, { model:'deepseek-reasoner' })
    await c.converse('sys', 'user', options([readTool(), finalTool()],
        { maxTurns:1 }), signal())
    await c.converse('sys', 'user', options([readTool(), finalTool()],
        { maxTurns:1 }), signal())
    const ids = s.requests.map(r => r.headers['x-agent-session-id'])
    t.equal(s.requests.length, 4, 'retry, correction, and a second run')
    t.ok(typeof ids[0] === 'string' && ids[0].startsWith('roast-'),
        'a roast session ID')
    t.ok(ids[0] === ids[1] && ids[1] === ids[2],
        'shared by requests, retries, and corrections')
    t.ok(ids[3] !== ids[0], 'distinct across conversations')
    for (const r of s.requests.slice(1)) {
        t.equal((r.body as Record<string, unknown>).tool_choice, 'auto',
            'thinking-mode model gets automatic tool choice')
    }
})

test('http: cancellation during a provider-directed retry delay', async t => {
    const s = await server(t, (_req, n) => n === 0 ? {
        status:503,
        headers:{ 'retry-after-ms':'1' },
        body:'{"error":{"message":"busy"}}',
    } : { stream:toolCall('submit', { summary:'ok' }) })
    const controller = new AbortController()
    const reason = new Error('cancel during retry')
    const delays:number[] = []
    const c = client(s.url, { maxAttempts:2 }, async (ms, retrySignal) => {
        delays.push(ms)
        const pending = defaultSleep(ms, retrySignal)
        controller.abort(reason)
        await pending
    })
    const err = await failure(c.converse('sys', 'user',
        options([finalTool()], { maxTurns:1 }), controller.signal))
    t.equal(err, reason, 'returns the cancellation reason')
    t.deepEqual(delays, [1], 'uses the provider retry delay')
    t.equal(s.requests.length, 1, 'does not send another request')
})

test('http: a call buffered before a request timeout is never run',
    async t => {
        const read = readTool()
        const s = await server(t, () => (res:ServerResponse) => {
            res.writeHead(200, { 'Content-Type':'text/event-stream' })
            const chunk = {
                id:'c1',
                object:'chat.completion.chunk',
                created:1,
                model:'m',
                choices:[{
                    index:0,
                    delta:{
                        tool_calls:[{
                            index:0,
                            id:'call-1',
                            type:'function',
                            function:{
                                name:'read',
                                arguments:'{"path":"a"}',
                            },
                        }],
                    },
                    finish_reason:null,
                }],
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            // The stream never finishes.
        })
        const started = Date.now()
        const err = await failure(client(s.url, {
            requestTimeoutMs:200,
            maxAttempts:3,
        }).converse('sys', 'user', options([read, finalTool()]), signal()))
        t.ok(hasSentinel(err, 'endpoint'), 'endpoint')
        t.equal(s.requests.length, 1, 'after one call')
        t.equal(read.runs, 0, 'the buffered call never ran')
        t.ok(Date.now() - started < 5000, 'promptly')
    })
