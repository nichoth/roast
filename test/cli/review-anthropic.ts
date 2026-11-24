// `roast review` on an `anthropic` profile against the fake inference
// server (spec 06, 5; ticket 28).
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import type {
    RecordedRequest,
    Script,
} from '../helpers/inference-server.js'
import {
    anthropicCalls,
    deepSeekScript,
    type DeepSeekAnswer,
} from '../helpers/anthropic-fakes.js'
import { writeInferenceStream } from '../helpers/inference-stream.js'
import {
    anthropicProfileConfig,
    approveProjectConfig,
    chatCalls,
    FINDER_KEY,
    finding,
    profileConfig,
    requestRecorder,
    reviewMeta,
    runDirs,
    settingsRepo,
    toolNames,
    writeConfig,
    type ReviewRepo,
    type Wire,
} from '../helpers/review.js'

const REVIEW = ['review', '--no-verify', '--format', 'json',
    '--error-format', 'json']
const INTERACTIVE = [...REVIEW, '--interactive', '--max-turns', '2']
const EXPLORE = { interactive:{ min_diff_lines:0, min_files:0 } }

type Block = Record<string, unknown>
type Body = {
    model:string,
    max_tokens:number,
    system:Block[],
    stream:boolean,
    tools:{ name:string, input_schema:Record<string, unknown> }[],
    tool_choice:{ type:string },
    thinking?:unknown,
    messages:{ role:string, content:Block[] }[],
}

function body (req:RecordedRequest):Body {
    return req.body as Body
}

function submit (findings:Wire[] = []) {
    return {
        name:'submit_findings',
        args:{
            assessment:findings.length ? 'FINDINGS_PRESENT' : 'NO_FINDINGS',
            findings,
        },
    }
}

function structured (findings:Wire[] = []) {
    return { ...submit(findings), name:'findings' }
}

// Explore main.go once, then submit `findings`.
function exploreThenSubmit (findings:Wire[] = []):Script {
    return (_req, n) => ({
        stream:n === 0 ?
            anthropicCalls([{
                name:'read_file', args:{ path:'main.go' },
            }], { thinking:'look first' }) :
            anthropicCalls([submit(findings)]),
    })
}

async function anthropicRepo (
    t:CleanupTest,
    script:Script,
    over:object = {},
    profile:object = {}
):Promise<ReviewRepo> {
    const r = await settingsRepo(t, script, { config:null })
    writeConfig(r.dir, anthropicProfileConfig(r.server.url, over, profile))
    await approveProjectConfig(r)
    return r
}

function lastError (stderr:string):Record<string, unknown> {
    return JSON.parse(stderr.trim().split('\n').pop() ?? '')
}

test('anthropic review: native messages through the wrap-up turn',
    async t => {
        const r = await anthropicRepo(t, exploreThenSubmit(), EXPLORE)
        const requests = requestRecorder(r)
        const res = await r.roast(INTERACTIVE)
        t.equal(res.code, 0, res.stderr)
        const [first, second] = requests()
        t.equal(requests().length, 2, 'two requests')
        for (const q of requests()) {
            t.equal(q.path, '/v1/messages', 'messages endpoint')
            t.equal(q.headers['x-api-key'], FINDER_KEY, 'x-api-key')
            t.ok(String(q.headers['anthropic-version'] ?? '') !== '',
                'anthropic-version')
            t.equal(q.headers.authorization, undefined, 'no authorization')
            t.equal(body(q).stream, true, 'stream')
            t.ok(body(q).system.length > 0, 'system blocks')
        }
        t.ok(toolNames(first).includes('read_file'), 'exploration tools')
        t.deepEqual(body(second).tools, body(first).tools,
            'same tools on the wrap-up turn')
        const replay = body(second).messages
        t.equal(replay.length, 3, 'user, assistant, user')
        t.equal(replay[1].content[0].type, 'thinking',
            'signed thinking replayed first')
        const last = replay[2].content
        t.ok(last.some(b => b.type === 'tool_result'), 'tool result')
        t.ok(last.some(b => b.type === 'text'), 'injected notice')
        t.equal(body(first).messages.length, 1, 'no notice at first')
        const usage = reviewMeta(r).usage.finder
        t.deepEqual(usage, {
            uncached_input_tokens:20,
            cached_input_tokens:6,
            cache_write_tokens:4,
            output_tokens:8,
            calls:2,
        }, 'usage accumulates')
    })

test('anthropic review gates on findings; base URL without /v1',
    async t => {
        const script:Script = () => ({
            stream:anthropicCalls([structured([finding()])]),
        })
        const r = await settingsRepo(t, script, { config:null })
        writeConfig(r.dir, anthropicProfileConfig(r.server.url, {}, {
            endpoint:r.server.url,
        }))
        await approveProjectConfig(r)
        const requests = requestRecorder(r)
        const res = await r.roast([...REVIEW, '--max-severity', 'HIGH'])
        t.equal(res.code, 1, res.stderr)
        t.equal(JSON.parse(res.stdout).findings.length, 1, 'finding')
        t.equal(requests()[0].path, '/v1/messages', 'v1 appended')
        const ok = await r.roast([...REVIEW, '--max-severity',
            'critical'])
        t.equal(ok.code, 0, 'below the threshold exits 0')
    })

test('anthropic max_tokens is the profile budget', async t => {
    for (const budget of [1024, 32768]) {
        const r = await anthropicRepo(t, () => ({
            stream:anthropicCalls([structured()]),
        }), {}, { max_output_tokens:budget })
        const requests = requestRecorder(r)
        t.equal((await r.roast(REVIEW)).code, 0, `${budget}: review`)
        t.equal(body(requests()[0]).max_tokens, budget, `${budget}`)
    }
})

test('anthropic tool_choice is auto in every phase (DeepSeek fake)',
    async t => {
        const respond = (req:RecordedRequest, n:number):DeepSeekAnswer => {
            const names = toolNames(req)
            if (names.includes('submit_verdict')) {
                return {
                    tool:'submit_verdict',
                    args:{
                        reasoning:'checked',
                        status:'confirmed',
                        confidence:0.9,
                        grounding:'line 4',
                    },
                }
            }
            const call = names.includes('findings') ?
                structured([finding()]) :
                submit([finding()])
            return n === 1 && names.includes('read_file') ?
                { tool:'read_file', args:{ path:'main.go' } } :
                { tool:call.name, args:call.args }
        }
        for (const args of [[], ['--interactive', '--max-turns', '2']]) {
            const fake = deepSeekScript('anthropic', respond)
            const r = await anthropicRepo(t, fake.script, EXPLORE)
            const requests = requestRecorder(r)
            const res = await r.roast(['review', '--format', 'json',
                ...args])
            const label = args.length ? 'interactive' : 'structured'
            t.equal(res.code, 0, `${label}: ${res.stderr}`)
            t.equal(fake.rejected.length, 0, `${label}: nothing rejected`)
            t.ok(requests().some(q =>
                toolNames(q).includes('submit_verdict')),
            `${label}: verifier ran`)
            t.ok(requests().every(q =>
                body(q).tool_choice.type === 'auto'),
            `${label}: auto everywhere`)
        }
    })

function withRequired (schema:Record<string, unknown>) {
    return { ...schema, required:schema.required ?? [] }
}

test('anthropic input_schema is the full caller schema', async t => {
    const anthropic = exploreThenSubmit()
    const script:Script = (req, n) => req.path.endsWith('/v1/messages') ?
        anthropic(req, n) :
        { stream:chatCalls([submit()]) }
    const r = await anthropicRepo(t, script, EXPLORE)
    const requests = requestRecorder(r)
    t.equal((await r.roast(INTERACTIVE)).code, 0, 'anthropic review')
    const tools = body(requests()[0]).tools
    // The chat adapter sends each caller schema unchanged.
    writeConfig(r.dir, profileConfig(r.server.url, EXPLORE))
    await approveProjectConfig(r)
    t.equal((await r.roast(INTERACTIVE)).code, 0, 'chat review')
    type ChatTool = {
        function:{ name:string, parameters:Record<string, unknown> },
    }
    const chat = (requests()[2].body as { tools:ChatTool[] }).tools
    t.equal(tools.length, chat.length, 'same tool count')
    for (const tool of chat) {
        const got = tools.find(a => a.name === tool.function.name)
        t.deepEqual(got?.input_schema, withRequired(tool.function.parameters),
            `${tool.function.name} schema`)
    }
    const text = JSON.stringify(tools)
    t.ok(text.includes('"additionalProperties"'), 'additionalProperties')
})

test('only claude-mythos-preview gets adaptive thinking', async t => {
    for (const model of ['claude-mythos-preview', 'claude-test']) {
        const r = await anthropicRepo(t, () => ({
            stream:anthropicCalls([structured()]),
        }), {}, { model })
        const requests = requestRecorder(r)
        t.equal((await r.roast(REVIEW)).code, 0, `${model}: review`)
        const thinking = body(requests()[0]).thinking
        if (model === 'claude-test') {
            t.equal(thinking, undefined, 'no thinking field')
        } else {
            t.deepEqual(thinking, { type:'adaptive', display:'summarized' },
                'adaptive thinking')
        }
    }
})

test('anthropic 401 exits 3 with category auth', async t => {
    const r = await anthropicRepo(t, () => ({
        status:401,
        headers:{ 'content-type':'application/json' },
        body:'{"type":"error","error":{"type":"authentication_error",' +
            '"message":"invalid x-api-key"}}',
    }))
    const res = await r.roast(REVIEW)
    t.equal(res.code, 3, 'exit 3')
    t.equal(lastError(res.stderr).error_category, 'auth', 'auth category')
})

test('an interrupted anthropic stream is retried; its tool never runs',
    async t => {
        const script:Script = (_req, n) => res => {
            const response = n === 2 ?
                anthropicCalls([submit()]) :
                anthropicCalls([{
                    name:'read_file', args:{ path:'main.go' },
                }])
            let out = ''
            const sink = {
                setHeader:(k:string, v:string) => res.setHeader(k, v),
                write:(s:string) => { out += s },
                end:() => {},
            }
            writeInferenceStream(sink, 'anthropic', response)
            if (n === 0) out = out.slice(0, out.indexOf('event: message_stop'))
            res.end(out)
        }
        const r = await anthropicRepo(t, script, EXPLORE)
        const requests = requestRecorder(r)
        const res = await r.roast([...INTERACTIVE, '--max-attempts', '2'])
        t.equal(res.code, 0, res.stderr)
        t.equal(requests().length, 3, 'three requests')
        t.deepEqual(requests()[1].body, requests()[0].body,
            'the retry resends the same request')
        t.equal(body(requests()[2]).messages.filter(m =>
            m.content.some(b => b.type === 'tool_result')).length, 1,
        'only the completed call ran')
        const lines = fs.readFileSync(path.join(runDirs(r)[0],
            'provider-responses.jsonl'), 'utf8').trimEnd().split('\n')
        t.equal(lines.length, 3, 'every stream captured')
        t.equal(reviewMeta(r).usage.finder.calls, 2,
            'usage counts completed calls only')
    })
