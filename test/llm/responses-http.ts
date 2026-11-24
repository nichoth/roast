// The `responses` adapter behind `createModelClient` and the agent loop,
// against the fake inference server (spec 06, 2.2 to 2.5, 2.10; spec 06
// section 5 responses rows).
import type { ServerResponse } from 'node:http'
import { test, type CleanupTest } from '../helpers/test.js'
import {
    startInferenceServer,
    type InferenceServer,
    type Script,
} from '../helpers/inference-server.js'
import { createClient, createModelClient } from '../../src/llm/client.js'
import { newSessionId } from '../../src/llm/session.js'
import {
    EndpointError,
    errorStatus,
    hasSentinel,
    isRetryable,
} from '../../src/llm/errors.js'
import type {
    ClientConfig,
    ModelRequest,
    RawResponse,
} from '../../src/llm/types.js'
import {
    failure,
    finalTool,
    options,
    readTool,
    signal,
} from './agent-helpers.js'

const USAGE = {
    input_tokens:10,
    input_tokens_details:{ cached_tokens:4 },
    output_tokens:2,
    total_tokens:12,
}

type Call = { name:string, args:unknown, id?:string }

// A complete Responses API response calling `calls`, or with a message.
function responsesReply (calls:Call[], extra:Record<string, unknown> = {}) {
    return {
        id:'resp_1',
        object:'response',
        model:'m',
        status:'completed',
        output:calls.map((c, i) => ({
            type:'function_call',
            id:`fc_${i}`,
            call_id:c.id ?? `call_${i}`,
            name:c.name,
            arguments:JSON.stringify(c.args),
            status:'completed',
        })),
        usage:USAGE,
        ...extra,
    }
}

const ok:Script = () => ({
    stream:responsesReply([{ name:'read', args:{ path:'a' } }]),
})

function cfg (url:string, over:Partial<ClientConfig> = {}):ClientConfig {
    return {
        role:'finder',
        baseUrl:`${url}/v1/`,
        apiKey:'sk-test',
        model:'gpt-5',
        protocol:'responses',
        maxOutputTokens:4096,
        maxAttempts:0,
        requestTimeoutMs:0,
        ...over,
    }
}

function req (over:Partial<ModelRequest> = {}):ModelRequest {
    return {
        system:'sys',
        items:[{ role:'user', text:'review this' }],
        tools:[{ name:'read', description:'d', schema:{ type:'object' } }],
        sessionId:newSessionId(),
        signal:new AbortController().signal,
        ...over,
    }
}

async function server (t:CleanupTest, script:Script):Promise<InferenceServer> {
    const s = await startInferenceServer(script)
    t.cleanup(() => s.close())
    return s
}

function client (url:string, over:Partial<ClientConfig> = {}) {
    return createClient(createModelClient(cfg(url, over)), {
        sleep:async () => {},
    })
}

type Body = Record<string, unknown>&{ input:Body[], tools:unknown[] }

const AMBIENT:Record<string, string> = {
    OPENAI_API_KEY:'sk-ambient-openai',
    OPENAI_ORG_ID:'org-ambient',
    OPENAI_PROJECT_ID:'proj-ambient',
    OPENAI_CUSTOM_HEADERS:'User-Agent: ambient-ua\nX-Ambient: yes',
    OPENROUTER_API_KEY:'sk-or-ambient',
}

const TRANSPORT = new Set(['host', 'connection', 'content-length',
    'accept-encoding', 'accept-language', 'sec-fetch-mode'])

test('responses request: endpoint, Roast headers only, whatever the env',
    async t => {
        const s = await server(t, ok)
        const decoy = await server(t, ok)
        const vars = { ...AMBIENT, OPENAI_BASE_URL:`${decoy.url}/v1` }
        const saved:Record<string, string|undefined> = {}
        for (const [k, v] of Object.entries(vars)) {
            saved[k] = process.env[k]
            process.env[k] = v
        }
        t.cleanup(() => {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        })
        const r = req()
        const turn = await createModelClient(cfg(s.url)).send(r)
        t.equal(turn.finishReason, 'tool-calls', 'turn returned')
        t.equal(s.requests.length, 1, 'one request')
        t.equal(decoy.requests.length, 0, 'decoy saw nothing')
        const got = s.requests[0]
        t.equal(got.path, '/v1/responses', 'posts to <base>/responses')
        const names = Object.keys(got.headers)
            .filter(n => !TRANSPORT.has(n))
        t.deepEqual(names.sort(), ['accept', 'authorization',
            'content-type', 'user-agent', 'x-agent-session-id'],
        'only Roast headers')
        t.equal(got.headers.authorization, 'Bearer sk-test',
            'configured key')
        t.equal(got.headers['x-agent-session-id'], r.sessionId, 'session')
        const values = Object.values(got.headers).join('\n')
        for (const v of Object.values(AMBIENT)) {
            t.ok(!values.includes(v), `no ambient value ${v}`)
        }
    })

test('responses: a 3xx is refused, never followed, and sends no key',
    async t => {
        const target = await server(t, ok)
        for (const status of [301, 302, 307, 308]) {
            const s = await server(t, () => ({
                status,
                headers:{ Location:`${target.url}/v1/responses` },
            }))
            const err = await failure(createModelClient(
                cfg(s.url, { maxAttempts:3 })).send(req()))
            t.ok(err instanceof EndpointError, `${status}: endpoint error`)
            t.ok(hasSentinel(err, 'endpoint'), `${status}: sentinel`)
            t.ok(!isRetryable(err), `${status}: not retryable`)
            t.equal(errorStatus(err), status, `${status}: status kept`)
            t.equal(s.requests.length, 1, `${status}: one request`)
        }
        t.equal(target.requests.length, 0, 'redirect target never contacted')
    })

test('responses agent replays tool output and keeps tools on the final turn',
    async t => {
        const s = await server(t, (_req, n) => ({
            stream:n === 0 ?
                responsesReply([{
                    name:'read', args:{ path:'a' }, id:'call_read',
                }]) :
                responsesReply([{ name:'submit', args:{ summary:'ok' } }]),
        }))
        const read = readTool()
        const c = client(s.url)
        const out = await c.converse('sys', 'user',
            options([read, finalTool()], { maxTurns:2 }), signal())
        t.deepEqual(out, { summary:'ok' }, 'final result decoded')
        t.equal(read.runs, 1, 'tool ran once')
        t.equal(s.requests.length, 2, 'two requests')
        const bodies = s.requests.map(r => r.body as Body)
        for (const [i, b] of bodies.entries()) {
            t.equal(s.requests[i].path, '/v1/responses', `${i}: path`)
            t.equal(b.store, false, `${i}: store false`)
            t.equal(b.stream, true, `${i}: stream`)
            t.equal(b.tool_choice, 'auto', `${i}: tool choice auto`)
            t.ok(!('previous_response_id' in b),
                `${i}: no previous_response_id`)
        }
        t.deepEqual(bodies[1].tools, bodies[0].tools,
            'the final turn carries the same tools')
        const outputs = bodies[1].input
            .filter(item => item.type === 'function_call_output')
        t.equal(outputs.length, 1, 'one tool output replayed')
        t.equal(outputs[0].call_id, 'call_read', 'matching call_id')
        const call = bodies[1].input
            .find(item => item.type === 'function_call')
        t.equal(call?.call_id, 'call_read', 'the call is replayed too')
        t.deepEqual(c.usage(), {
            uncached_input_tokens:12,
            cached_input_tokens:8,
            cache_write_tokens:0,
            output_tokens:4,
            calls:2,
        }, 'usage: cached subtracted once per call')
    })

// A stream that sends one text delta and then ends without a terminal
// event.
function truncated (res:ServerResponse):void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('event: response.output_text.delta\n' +
        'data: {"type":"response.output_text.delta","delta":"x"}\n\n')
    res.end()
}

function failedEvent (type:'response.failed'|'error') {
    return (res:ServerResponse):void => {
        res.setHeader('Content-Type', 'text/event-stream')
        const data = type === 'error' ?
            { type, code:'server_error', message:'boom' } :
            { type, response:{ error:{ code:'server_error', message:'b' } } }
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
        res.end()
    }
}

test('responses: a stream without a terminal event is retried', async t => {
    const s = await server(t, (_req, n) => n === 0 ?
        truncated :
        { stream:responsesReply([{ name:'submit', args:{ summary:'ok' } }]) })
    const out = await client(s.url).converse('sys', 'user',
        options([finalTool()], { maxTurns:1 }), signal())
    t.deepEqual(out, { summary:'ok' }, 'second attempt succeeds')
    t.equal(s.requests.length, 2, 'retried once')
})

test('responses: failed and error events are not retried', async t => {
    for (const type of ['response.failed', 'error'] as const) {
        const s = await server(t, () => failedEvent(type))
        const err = await failure(client(s.url).converse('sys', 'user',
            options([finalTool()], { maxTurns:1 }), signal()))
        t.ok(err instanceof Error, `${type}: fails`)
        t.equal(s.requests.length, 1, `${type}: one request`)
    }
})

test('responses: the raw stream is captured byte for byte', async t => {
    const s = await server(t, ok)
    const captured:RawResponse[] = []
    const r = req()
    await createModelClient(cfg(s.url, {
        captureResponse:raw => { captured.push(raw) },
    })).send(r)
    t.equal(captured.length, 1, 'one capture')
    t.equal(captured[0].protocol, 'responses', 'protocol responses')
    t.equal(captured[0].contentType, 'text/event-stream', 'sse')
    const text = new TextDecoder().decode(captured[0].body)
    t.ok(text.startsWith('event: response.created\n'), 'starts at created')
    t.ok(text.trimEnd().endsWith('}'), 'ends with the completed event')
    t.ok(text.includes('"type":"response.completed"'), 'includes completed')
})
