// The `anthropic` adapter through `createModelClient` / `createClient`
// against fake servers (spec 06, 5: ambient environment, redirects,
// signed thinking replay, DeepSeek thinking mode).
import { test, type CleanupTest } from '../helpers/test.js'
import {
    startInferenceServer,
    type InferenceServer,
    type Script,
} from '../helpers/inference-server.js'
import {
    anthropicCalls,
    startBindingServer,
    startDeepSeekServer,
    thinkingBlock,
    toolUseBlock,
    type DeepSeekAnswer,
} from '../helpers/anthropic-fakes.js'
import { createClient, createModelClient } from '../../src/llm/client.js'
import { newSessionId } from '../../src/llm/session.js'
import {
    EndpointError,
    errorStatus,
    hasSentinel,
    isRetryable,
} from '../../src/llm/errors.js'
import { newLedger } from '../../src/llm/ledger.js'
import type {
    ClientConfig,
    ModelRequest,
    Tool,
} from '../../src/llm/types.js'
import {
    failure,
    finalTool,
    options,
    readTool,
    recordTool,
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
        apiKey:'sk-ant-test',
        model:'claude-test',
        protocol:'anthropic',
        maxOutputTokens:1024,
        maxAttempts:2,
        requestTimeoutMs:0,
        ...over,
    }
}

function req ():ModelRequest {
    return {
        system:'sys',
        items:[{ role:'user', text:'review this' }],
        tools:[{ name:'read', description:'d', schema:{ type:'object' } }],
        sessionId:newSessionId(),
        signal:new AbortController().signal,
    }
}

const ok:Script = () => ({ stream:anthropicCalls([]) })

const AMBIENT:Record<string, string> = {
    ANTHROPIC_API_KEY:'sk-ant-ambient',
    ANTHROPIC_AUTH_TOKEN:'ambient-token',
    ANTHROPIC_CUSTOM_HEADERS:'X-Agent-Session-Id: ambient-session\n' +
        'User-Agent: ambient-ua\nX-Ambient: yes',
    ANTHROPIC_WORKSPACE_ID:'ambient-workspace',
    ANTHROPIC_PROFILE:'ambient-profile',
    OPENAI_API_KEY:'sk-ambient-openai',
}

const TRANSPORT = new Set(['host', 'connection', 'content-length',
    'accept-encoding', 'accept-language', 'sec-fetch-mode'])

test('anthropic ignores ambient ANTHROPIC_* variables', async t => {
    const s = await server(t, ok)
    const decoy = await server(t, ok)
    const vars = { ...AMBIENT, ANTHROPIC_BASE_URL:decoy.url }
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
    await createModelClient(cfg(s.url)).send(r)
    t.equal(s.requests.length, 1, 'one request')
    t.equal(decoy.requests.length, 0, 'decoy saw nothing')
    const got = s.requests[0]
    t.equal(got.path, '/v1/messages', 'configured endpoint')
    const names = Object.keys(got.headers).filter(n => !TRANSPORT.has(n))
    t.deepEqual(names.sort(), ['accept', 'anthropic-version',
        'content-type', 'user-agent', 'x-agent-session-id', 'x-api-key'],
    'only Roast headers')
    t.equal(got.headers['x-api-key'], 'sk-ant-test', 'configured key')
    t.ok(String(got.headers['anthropic-version']).length > 0, 'version')
    t.ok(String(got.headers['user-agent']).startsWith('roast/'), 'agent')
    t.equal(got.headers['x-agent-session-id'], r.sessionId, 'session id')
    const values = Object.values(got.headers).join('\n')
    for (const v of Object.values(AMBIENT)) {
        t.ok(!values.includes(v), `no ambient value ${v}`)
    }
})

test('anthropic: a 3xx is refused and sends no key onward', async t => {
    const target = await server(t, ok)
    for (const status of [301, 302, 307, 308]) {
        const s = await server(t, () => ({
            status,
            headers:{ Location:`${target.url}/v1/messages` },
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

function submitArgs (summary:string) {
    return { summary }
}

test('binding fake rejects a changed prefix', async t => {
    const s = await startBindingServer(() => [
        thinkingBlock(''),
        toolUseBlock('toolu-1', 'read', {}),
    ])
    t.cleanup(() => s.close())
    async function post (body:unknown):Promise<number> {
        const res = await fetch(`${s.url}/v1/messages`, {
            method:'POST',
            body:JSON.stringify(body),
        })
        await res.text()
        return res.status
    }
    const user = {
        role:'user',
        content:[{ type:'text', text:'a' }, { type:'text', text:'b' }],
    }
    t.equal(await post({ system:[], tools:[], messages:[user] }), 200,
        'first request')
    const assistant = {
        role:'assistant',
        content:[
            { signature:'sig-1', thinking:'', type:'thinking' },
            { type:'tool_use', id:'toolu-1', name:'read', input:{} },
        ],
    }
    const result = {
        role:'user',
        content:[{
            type:'tool_result',
            tool_use_id:'toolu-1',
            content:'x'
        }],
    }
    t.equal(await post({
        system:[],
        tools:[],
        messages:[user, assistant, result]
    }), 200, 'unchanged replay')
    const dropped = { role:'user', content:[{ type:'text', text:'a' }] }
    t.equal(await post({
        system:[],
        tools:[],
        messages:[dropped, assistant, result]
    }), 400, 'changed prefix')
})

function bindingClient (url:string) {
    return createClient(createModelClient(cfg(url)), {
        sleep:async () => {},
    })
}

const signal = () => new AbortController().signal

test('signed thinking replays unchanged to a binding fake', async t => {
    type Case = {
        name:string,
        respond:(n:number) => Record<string, unknown>[],
        tools:() => Tool[],
        maxTurns:number,
        inputByteCeiling?:number,
    }
    const cases:Case[] = [
        {
            name:'wrap-up turn',
            respond:n => n === 1 ?
                [thinkingBlock('look first'),
                    toolUseBlock('toolu-1', 'read', { path:'a' })] :
                [thinkingBlock(''),
                    toolUseBlock('toolu-2', 'submit', submitArgs('done'))],
            tools:() => [readTool(), finalTool()],
            maxTurns:2,
        },
        {
            name:'interleaved thinking',
            respond:n => n === 1 ?
                [thinkingBlock('first'),
                    toolUseBlock('toolu-a', 'read', { path:'a' }),
                    thinkingBlock('between tools'),
                    toolUseBlock('toolu-b', 'read', { path:'b' })] :
                [toolUseBlock('toolu-c', 'submit', submitArgs('done'))],
            tools:() => [readTool(), finalTool()],
            maxTurns:4,
        },
        {
            name:'thinking after the call on the final turn',
            respond:n => n === 1 ?
                [thinkingBlock(''),
                    toolUseBlock('toolu-1', 'read', { path:'a' }),
                    thinkingBlock('after the call')] :
                [toolUseBlock('toolu-2', 'submit', submitArgs('done'))],
            tools:() => [readTool(), finalTool()],
            maxTurns:1,
        },
        {
            name:'input budget warning',
            respond:n => n < 3 ?
                [thinkingBlock(''),
                    toolUseBlock(`toolu-${n}`, 'read', { path:'a' })] :
                [toolUseBlock('toolu-3', 'submit', submitArgs('done'))],
            tools:() => [readTool(), finalTool()],
            maxTurns:6,
            inputByteCeiling:1,
        },
        {
            name:'wrap-up records a result',
            respond:n => n === 1 ?
                [thinkingBlock('save it first'),
                    toolUseBlock('toolu-1', 'report', { title:'a' })] :
                [thinkingBlock(''),
                    toolUseBlock('toolu-2', 'submit', submitArgs('done'))],
            tools:() => [readTool(), recordTool(), finalTool()],
            maxTurns:1,
        },
    ]
    for (const c of cases) {
        const s = await startBindingServer(c.respond)
        t.cleanup(() => s.close())
        const out = await bindingClient(s.url).converse('system', 'user',
            options(c.tools(), {
                maxTurns:c.maxTurns,
                inputByteCeiling:c.inputByteCeiling,
            }), signal())
        t.equal(out.summary, 'done', `${c.name}: answer`)
        t.equal(s.rejected, 0, `${c.name}: no rejected replay`)
        t.ok(s.requests.length >= 2, `${c.name}: follow-up sent`)
    }
    const s = await startBindingServer(n => [
        thinkingBlock(''),
        toolUseBlock(`toolu-${n}`, 'submit', n === 1 ?
            { summary:42 } :
            submitArgs('done')),
    ])
    t.cleanup(() => s.close())
    const out = await bindingClient(s.url).completeStructured('system',
        'user', 'submit', {
            schema:finalTool().schema,
            decode:options([]).final.decode,
        }, signal())
    t.equal(out.summary, 'done', 'structured retry: answer')
    t.equal(s.rejected, 0, 'structured retry: no rejected replay')
})

test('DeepSeek thinking mode: never a forced choice, replay kept',
    async t => {
        const explore = (_r:unknown, n:number):DeepSeekAnswer => n === 1 ?
            { tool:'read', args:{ path:'a.go' } } :
            { tool:'submit', args:submitArgs('done') }
        const submit = ():DeepSeekAnswer =>
            ({ tool:'submit', args:submitArgs('done') })
        const proseFirst = (_r:unknown, n:number):DeepSeekAnswer =>
            n === 1 ? { tool:'' } : submit()
        type Mode = {
            name:string,
            respond:(r:unknown, n:number) => DeepSeekAnswer,
            structured?:boolean,
            maxTurns?:number,
            deadline?:boolean,
            ledger?:boolean,
        }
        const modes:Mode[] = [
            { name:'two-turn', respond:explore, maxTurns:4 },
            { name:'wrap-up', respond:explore, maxTurns:2 },
            { name:'structured', respond:submit, structured:true },
            { name:'structured-retry', respond:proseFirst, structured:true },
            { name:'deadline', respond:submit, deadline:true },
            { name:'budget', respond:submit, ledger:true },
        ]
        for (const protocol of ['chat', 'anthropic'] as const) {
            for (const m of modes) {
                const s = await startDeepSeekServer(protocol, m.respond)
                t.cleanup(() => s.close())
                const client = createClient(createModelClient(cfg(s.url, {
                    protocol,
                    model:'deepseek-test',
                })), {
                    sleep:async () => {},
                    ledger:m.ledger ? newLedger(4000) : null,
                })
                const name = `${protocol}/${m.name}`
                const out = m.structured ?
                    await client.completeStructured('system', 'user',
                        'submit', {
                            schema:finalTool().schema,
                            decode:options([]).final.decode,
                        }, signal()) :
                    await client.converse('system', 'user', options(
                        [readTool(), finalTool()], {
                            maxTurns:m.maxTurns ?? 4,
                            workDeadline:m.deadline ?
                                Date.now() - 1000 :
                                undefined,
                        }), signal())
                t.equal(out.summary, 'done', `${name}: answer`)
                t.equal(s.rejected.length, 0, `${name}: nothing rejected`)
            }
        }
    })
