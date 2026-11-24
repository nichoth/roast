import { test } from '../helpers/test.js'
import {
    startInferenceServer,
    type InferenceServer,
    type Script,
} from '../helpers/inference-server.js'
import { createModelClient } from '../../src/llm/client.js'
import { newSessionId } from '../../src/llm/session.js'
import {
    CaptureError,
    EndpointError,
    ProviderError,
    errorStatus,
    hasSentinel,
    isRetryable,
} from '../../src/llm/errors.js'
import type {
    ClientConfig,
    ModelRequest,
    RawResponse,
    Usage,
} from '../../src/llm/types.js'
import type { CleanupTest } from '../helpers/test.js'

function chatResponse (content = 'hi', finish = 'stop') {
    return {
        id:'c1',
        model:'m',
        choices:[{
            index:0,
            message:{ role:'assistant', content },
            finish_reason:finish,
        }],
        usage:{ prompt_tokens:10, completion_tokens:2, total_tokens:12 },
    }
}

const ok:Script = () => ({ stream:chatResponse() })

function cfg (url:string, over:Partial<ClientConfig> = {}):ClientConfig {
    return {
        role:'finder',
        baseUrl:`${url}/v1/`,
        apiKey:'sk-test',
        model:'deepseek-chat',
        protocol:'chat',
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

async function failure (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

function constructionError (c:ClientConfig):string {
    try {
        createModelClient(c)
    } catch (err) {
        if (!(err instanceof Error)) return 'non-error'
        if (err.message.includes('max output')) return 'max'
        if (err.message.includes('API key')) return 'key'
        if (err.message.includes('protocol')) return 'protocol'
        return 'other'
    }
    return 'none'
}

test('construction fails in the spec order', t => {
    const base = cfg('http://127.0.0.1:1')
    t.equal(constructionError(base), 'none', 'valid config')
    t.equal(constructionError({ ...base, protocol:'' }), 'none',
        'empty protocol is chat')
    for (const key of ['', '   ', '\t\n']) {
        t.equal(constructionError({ ...base, apiKey:key }), 'key',
            `blank key ${JSON.stringify(key)}`)
    }
    t.equal(constructionError({ ...base, maxOutputTokens:0 }), 'max',
        'zero max tokens')
    t.equal(constructionError({ ...base, maxOutputTokens:-1 }), 'max',
        'negative max tokens')
    const bogus = { ...base, protocol:'bogus' as 'chat' }
    t.equal(constructionError(bogus), 'protocol', 'unknown protocol')
    t.equal(constructionError({ ...bogus, apiKey:'', maxOutputTokens:0 }),
        'max', 'max tokens checked first')
    t.equal(constructionError({ ...bogus, apiKey:' ' }), 'key',
        'key checked before protocol')
    t.equal(constructionError({ ...base, protocol:'responses' }),
        'none', 'responses is implemented')
    t.equal(constructionError({ ...base, protocol:'anthropic' }),
        'none', 'anthropic is implemented')
    t.equal(createModelClient({ ...base, protocol:'' }).protocol, 'chat',
        'normalized protocol')
    t.equal(createModelClient({ ...base, maxAttempts:-3 }).maxAttempts, 4,
        'default attempts')
})

const AMBIENT:Record<string, string> = {
    OPENAI_API_KEY:'sk-ambient-openai',
    OPENAI_ADMIN_KEY:'sk-ambient-admin',
    OPENAI_ORG_ID:'org-ambient',
    OPENAI_PROJECT_ID:'proj-ambient',
    OPENAI_CUSTOM_HEADERS:'User-Agent: ambient-ua\nX-Ambient: yes',
    ANTHROPIC_API_KEY:'sk-ant-ambient',
    ANTHROPIC_AUTH_TOKEN:'ambient-token',
    ANTHROPIC_CUSTOM_HEADERS:'X-Agent-Session-Id: ambient-session',
    ANTHROPIC_WORKSPACE_ID:'ambient-workspace',
    OPENROUTER_API_KEY:'sk-or-ambient',
    X_OPENCODE_SESSION:'ambient-session-header',
}

function withAmbient (t:CleanupTest, decoy:string):void {
    const vars = {
        ...AMBIENT,
        OPENAI_BASE_URL:`${decoy}/v1`,
        ANTHROPIC_BASE_URL:decoy,
    }
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
}

// Headers undici adds itself to every request.
const TRANSPORT = new Set(['host', 'connection', 'content-length',
    'accept-encoding', 'accept-language', 'sec-fetch-mode'])

test('chat request carries only Roast headers, whatever the env', async t => {
    const s = await server(t, ok)
    const decoy = await server(t, ok)
    withAmbient(t, decoy.url)
    const client = createModelClient(cfg(s.url, {
        sessionHeader:'x-opencode-session',
    }))
    const r = req()
    const turn = await client.send(r)
    t.equal(turn.finishReason, 'stop', 'turn returned')
    t.equal(s.requests.length, 1, 'one request')
    t.equal(decoy.requests.length, 0, 'decoy saw nothing')
    const got = s.requests[0]
    t.equal(got.method, 'POST', 'POST')
    t.equal(got.path, '/v1/chat/completions', 'configured endpoint')
    const names = Object.keys(got.headers).filter(n => !TRANSPORT.has(n))
    t.deepEqual(names.sort(), ['accept', 'authorization', 'content-type',
        'user-agent', 'x-agent-session-id', 'x-opencode-session'],
    'only Roast headers')
    t.equal(got.headers.authorization, 'Bearer sk-test', 'configured key')
    t.ok(String(got.headers['user-agent']).startsWith('roast/'),
        'user agent')
    t.equal(got.headers['x-agent-session-id'], r.sessionId, 'session id')
    t.equal(got.headers['x-opencode-session'], r.sessionId,
        'session header mirrored despite the environment')
    const values = Object.values(got.headers).join('\n')
    for (const v of Object.values(AMBIENT)) {
        t.ok(!values.includes(v), `no ambient value ${v}`)
    }
})

test('requestBytes equals the byte length of the body sent', async t => {
    const s = await server(t, ok)
    const client = createModelClient(cfg(s.url))
    const r = req({ items:[{ role:'user', text:'caf\u00e9 \u2713 <&>' }] })
    const n = client.requestBytes(r)
    await client.send(r)
    t.equal(n, s.requests[0].rawBody.length, 'byte length')
    t.equal(String(n), s.requests[0].headers['content-length'],
        'content-length')
    const body = s.requests[0].body as Record<string, unknown>
    t.equal(body.stream, true, 'body parsed as JSON')
})

test('a 3xx is refused, never followed, and sends no key onward',
    async t => {
        const target = await server(t, ok)
        for (const status of [301, 302, 303, 307, 308]) {
            const s = await server(t, () => ({
                status,
                headers:{ Location:`${target.url}/v1/chat/completions` },
            }))
            const client = createModelClient(cfg(s.url, { maxAttempts:3 }))
            const err = await failure(client.send(req()))
            t.ok(err instanceof EndpointError, `${status}: endpoint error`)
            t.ok(hasSentinel(err, 'endpoint'), `${status}: sentinel`)
            t.ok(!isRetryable(err), `${status}: not retryable`)
            t.equal(errorStatus(err), status, `${status}: status kept`)
            t.equal(s.requests.length, 1, `${status}: one request`)
        }
        t.equal(target.requests.length, 0, 'redirect target never contacted')
    })

// A body of `total` bytes in `chunk`-byte pieces that counts what was
// pulled and how often it was cancelled.
function countedStream (pieces:Uint8Array[]) {
    const stats = { pulled:0, pulls:0, cancels:0 }
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
        pull (c) {
            if (i >= pieces.length) {
                c.close()
                return
            }
            stats.pulls++
            stats.pulled += pieces[i].length
            c.enqueue(pieces[i++])
        },
        cancel () { stats.cancels++ },
    }, { highWaterMark:0 })
    return { stream, stats }
}

function fixedFetch (response:() => Response):typeof globalThis.fetch {
    return async () => response()
}

test('an error body is read only up to 32768 bytes', async t => {
    const pieces = Array.from({ length:1024 },
        () => new Uint8Array(1000).fill(120))
    const { stream, stats } = countedStream(pieces)
    const client = createModelClient(cfg('http://fake.invalid', {
        fetch:fixedFetch(() => new Response(stream, { status:500 })),
    }))
    const err = await failure(client.send(req()))
    t.ok(err instanceof ProviderError, 'provider error')
    t.equal(errorStatus(err), 500, 'status')
    t.ok(isRetryable(err), '500 retryable')
    t.ok(stats.pulled >= 32768 && stats.pulled < 32768 + 1000,
        `read ${stats.pulled} bytes, stopping at the cap`)
    t.equal(stats.cancels, 1, 'rest discarded')
})

test('concurrent conversations get distinct session IDs, set once',
    async t => {
        const s = await server(t, ok)
        const client = createModelClient(cfg(s.url, {
            sessionHeader:'X-Agent-Session-Id',
        }))
        const client2 = createModelClient(cfg(s.url, {
            sessionHeader:'x-opencode-session',
        }))
        const a = req()
        const b = req()
        await Promise.all([client2.send(a), client2.send(b),
            client.send(a)])
        t.notEqual(a.sessionId, b.sessionId, 'distinct IDs')
        for (const id of [a.sessionId, b.sessionId]) {
            t.ok(/^roast-[A-Z2-7]{26}$/.test(id), `${id} format`)
        }
        const seen = s.requests.slice(0, 2)
            .map(r => r.headers['x-agent-session-id'])
        t.deepEqual(seen.sort(), [a.sessionId, b.sessionId].sort(),
            'each conversation its own ID')
        for (const r of s.requests.slice(0, 2)) {
            t.equal(r.headers['x-opencode-session'],
                r.headers['x-agent-session-id'], 'mirrored')
        }
        for (const r of s.requests) {
            for (const name of ['x-agent-session-id', 'x-opencode-session',
                'user-agent', 'authorization']) {
                const count = r.rawHeaders.filter((h, i) =>
                    i % 2 === 0 && h.toLowerCase() === name).length
                t.ok(count <= 1, `${name} at most once`)
            }
        }
        t.equal(s.requests[2].headers['x-agent-session-id'], a.sessionId,
            'session header spelled like X-Agent-Session-Id is one header')
    })

test('usage accumulates and onUsage runs once per call', async t => {
    const s = await server(t, ok)
    const client = createModelClient(cfg(s.url))
    const reports:Usage[] = []
    await client.send(req({ onUsage:u => reports.push(u) }))
    await client.send(req({ onUsage:u => reports.push(u) }))
    t.equal(reports.length, 2, 'once per call')
    t.equal(reports[0].uncachedInputTokens, 10, 'normalized')
    t.deepEqual(client.usage(), {
        uncachedInputTokens:20,
        cachedInputTokens:0,
        cacheWriteTokens:0,
        outputTokens:4,
        calls:2,
    }, 'total')
})

test('a capture callback failure latches the client', async t => {
    const s = await server(t, ok)
    let calls = 0
    const client = createModelClient(cfg(s.url, {
        maxAttempts:3,
        captureResponse:() => {
            calls++
            throw new Error('disk full')
        },
    }))
    const first = await failure(client.send(req()))
    t.ok(first instanceof CaptureError, 'capture error on that call')
    t.ok(!isRetryable(first), 'not retryable')
    const second = await failure(client.send(req()))
    t.ok(second instanceof CaptureError, 'capture error on a later call')
    t.equal(s.requests.length, 1, 'exactly one HTTP request')
    t.equal(calls, 1, 'callback ran once')
})

test('capture: Content-Length over the cap fails', async t => {
    const s = await server(t, () => res => {
        res.writeHead(200, {
            'Content-Type':'text/event-stream',
            'Content-Length':'16777217',
        })
        res.write('data: {}\n\n')
    })
    let calls = 0
    const client = createModelClient(cfg(s.url, {
        captureResponse:() => { calls++ },
    }))
    const err = await failure(client.send(req()))
    t.ok(err instanceof CaptureError, 'size error')
    t.equal(calls, 0, 'callback not called')
})

test('capture: an invalid JSON 2xx body fails once', async t => {
    const s = await server(t, () => ({
        status:200,
        headers:{ 'Content-Type':'application/json' },
        body:'{"truncated":',
    }))
    let calls = 0
    const client = createModelClient(cfg(s.url, {
        maxAttempts:3,
        captureResponse:() => { calls++ },
    }))
    t.ok(await failure(client.send(req())) instanceof CaptureError,
        'capture error')
    t.ok(await failure(client.send(req())) instanceof CaptureError,
        'sticky')
    t.equal(s.requests.length, 1, 'one request')
    t.equal(calls, 0, 'callback not called')
})

test('capture: a valid JSON 2xx body is captured, then incomplete',
    async t => {
        const s = await server(t, () => ({
            status:200,
            headers:{ 'Content-Type':'application/json; charset=utf-8' },
            body:'{"ok":true}',
        }))
        const raws:RawResponse[] = []
        const client = createModelClient(cfg(s.url, {
            captureResponse:raw => { raws.push(raw) },
        }))
        const err = await failure(client.send(req()))
        t.ok(err instanceof ProviderError && isRetryable(err),
            'incomplete stream')
        t.equal(raws.length, 1, 'captured')
        t.equal(raws[0].contentType, 'application/json', 'content type')
        t.equal(new TextDecoder().decode(raws[0].body), '{"ok":true}',
            'exact bytes')
    })

test('streaming capture overflows without Content-Length', async t => {
    const mib = 1 << 20
    const piece = new TextEncoder().encode(': ' + 'x'.repeat(mib - 3) + '\n')
    const pieces = Array.from({ length:20 }, () => piece)
    const { stream, stats } = countedStream(pieces)
    let calls = 0
    const client = createModelClient(cfg('http://fake.invalid', {
        captureResponse:() => { calls++ },
        fetch:fixedFetch(() => new Response(stream, {
            headers:{ 'Content-Type':'text/event-stream' },
        })),
    }))
    const err = await failure(client.send(req()))
    t.ok(err instanceof CaptureError, 'size error')
    t.equal(calls, 0, 'callback not called')
    t.equal(stats.pulls, 17, 'stopped at the chunk that overflowed')
    t.equal(stats.cancels, 1, 'body released')
})

test('streaming capture reads no further than the parser', async t => {
    const enc = new TextEncoder()
    const chunk = (o:unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`)
    const pieces = [
        chunk({ choices:[{ index:0, delta:{ content:'hi' } }] }),
        chunk({ choices:[{ index:0, delta:{}, finish_reason:'stop' }] }),
        enc.encode('data: [DONE]\n\n'),
        chunk({ never:'read' }),
        chunk({ never:'read' }),
    ]
    const { stream, stats } = countedStream(pieces)
    const raws:RawResponse[] = []
    const client = createModelClient(cfg('http://fake.invalid', {
        captureResponse:raw => { raws.push(raw) },
        fetch:fixedFetch(() => new Response(stream, {
            headers:{ 'Content-Type':'Text/Event-Stream; charset=utf-8' },
        })),
    }))
    const turn = await client.send(req())
    t.deepEqual(turn.parts, [{ type:'text', text:'hi' }], 'turn')
    t.equal(stats.pulls, 3, 'no read past [DONE]')
    t.equal(stats.cancels, 1, 'released once')
    t.equal(raws.length, 1, 'captured once')
    t.equal(raws[0].contentType, 'text/event-stream', 'content type')
    t.deepEqual([...raws[0].body],
        [...pieces[0], ...pieces[1], ...pieces[2]], 'exactly the bytes read')
})

test('a request timeout is an endpoint error caused by a timeout',
    async t => {
        const s = await server(t, () => () => {})
        const client = createModelClient(cfg(s.url, {
            requestTimeoutMs:20,
        }))
        const start = Date.now()
        const err = await failure(client.send(req()))
        const elapsed = Date.now() - start
        t.ok(err instanceof EndpointError, 'endpoint error')
        t.equal((err as Error).cause instanceof Error &&
            ((err as Error).cause as Error).name, 'TimeoutError',
        'caused by a timeout')
        t.ok(!isRetryable(err), 'not retried')
        t.ok(elapsed < 1000, `within a second (${elapsed}ms)`)
    })

test('caller abort rethrows the signal reason', async t => {
    const s = await server(t, () => () => {})
    const client = createModelClient(cfg(s.url))
    const ac = new AbortController()
    const reason = new Error('caller cancelled')
    const p = failure(client.send(req({ signal:ac.signal })))
    setTimeout(() => ac.abort(reason), 20)
    t.equal(await p, reason, 'reason unchanged')
})
