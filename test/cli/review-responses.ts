// `roast review` end to end on a fake `responses` server (spec 06, 2.2 to
// 2.5, 2.6.2, 2.8.2, 2.9, 2.11; ticket 27).
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import {
    startInferenceServer,
    type RecordedRequest,
    type Script,
} from '../helpers/inference-server.js'
import {
    writeInferenceStream,
    type StreamSink,
} from '../helpers/inference-stream.js'
import {
    FINDER_KEY,
    finderScript,
    finding,
    requestRecorder,
    responsesFindingsReply,
    responsesProfileConfig,
    reviewMeta,
    runDirs,
    settingsRepo,
    writeConfig,
    approveProjectConfig,
    type ReviewRepo,
    type Wire,
} from '../helpers/review.js'

const REVIEW = ['review', '--no-verify', '--format', 'json',
    '--error-format', 'json']

// A repository whose finder and verifier profile speaks `responses`.
async function responsesRepo (
    t:CleanupTest,
    script:Script
):Promise<ReviewRepo> {
    const r = await settingsRepo(t, script, { approve:false })
    writeConfig(r.dir, responsesProfileConfig(r.server.url))
    await approveProjectConfig(r)
    return r
}

function responsesFinder (findings:Wire[] = []):Script {
    return () => responsesFindingsReply(findings)
}

function lastError (stderr:string):Record<string, unknown> {
    const line = stderr.trim().split('\n').pop() ?? ''
    return JSON.parse(line)
}

type Body = Record<string, unknown>&{ input?:Record<string, unknown>[] }

// The structure of a JSON value: object keys and value types, recursively;
// arrays by their first element.
function shape (v:unknown):unknown {
    if (Array.isArray(v)) return v.length ? [shape(v[0])] : []
    if (v !== null && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v)
            .sort(([a], [b]) => a < b ? -1 : 1)
            .map(([k, x]) => [k, shape(x)]))
    }
    return v === null ? 'null' : typeof v
}

test('responses review: exit 0 clean, 1 at --max-severity, chat shape',
    async t => {
        const clean = await responsesRepo(t, responsesFinder())
        const ok = await clean.roast(REVIEW)
        t.equal(ok.code, 0, ok.stderr)
        t.deepEqual(JSON.parse(ok.stdout).findings, [], 'no findings')

        const r = await responsesRepo(t, responsesFinder([finding()]))
        const res = await r.roast([...REVIEW, '--max-severity', 'HIGH'])
        t.equal(res.code, 1, res.stderr)
        const report = JSON.parse(res.stdout)
        t.equal(report.findings.length, 1, 'finding reported')
        t.equal(report.findings[0].severity, 'HIGH', 'severity')
        const below = await r.roast([...REVIEW, '--max-severity',
            'critical'])
        t.equal(below.code, 0, 'below the threshold exits 0')

        const chat = await settingsRepo(t, finderScript([finding()]))
        const chatRes = await chat.roast([...REVIEW, '--max-severity',
            'HIGH'])
        t.equal(chatRes.code, 1, chatRes.stderr)
        t.deepEqual(shape(report), shape(JSON.parse(chatRes.stdout)),
            'same report shape as a chat review')
    })

test('responses review: request wire shape', async t => {
    const r = await responsesRepo(t, responsesFinder([finding()]))
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    const sent = requests()
    t.ok(sent.length >= 1, 'requests sent')
    for (const [i, req] of sent.entries()) {
        const b = req.body as Body
        t.equal(req.path, '/v1/responses', `${i}: <base>/v1/responses`)
        t.equal(b.store, false, `${i}: store false`)
        t.equal(b.stream, true, `${i}: stream`)
        t.equal(b.tool_choice, 'auto', `${i}: tool choice auto`)
        t.ok(!('previous_response_id' in b), `${i}: no previous id`)
        const tools = b.tools as Record<string, unknown>[]
        const findings = tools.find(x => x.name === 'findings')
        t.ok(findings, `${i}: findings tool offered`)
        const params = findings?.parameters as Record<string, unknown>
        t.equal(params.additionalProperties, false,
            `${i}: additionalProperties kept`)
        t.ok(Array.isArray(params.required), `${i}: required kept`)
        const items = (params.properties as Record<string, any>)
            .findings.items
        t.ok(Array.isArray(items.required) && items.required.length > 0,
            `${i}: nested required kept`)
        t.ok(tools.every(x => x.strict === false), `${i}: strict false`)
        t.equal(req.headers.authorization, `Bearer ${FINDER_KEY}`,
            `${i}: configured key`)
    }
})

test('responses review: with --max-attempts 1 a 500 is sent once',
    async t => {
        const r = await responsesRepo(t, () => ({
            status:500,
            body:'{"error":{"message":"boom"}}',
            headers:{ 'content-type':'application/json' },
        }))
        const requests = requestRecorder(r)
        const res = await r.roast([...REVIEW, '--max-attempts', '1'])
        t.equal(res.code, 4, 'exit 4')
        t.equal(lastError(res.stderr).error_category, 'endpoint',
            'endpoint category')
        t.equal(requests().length, 1, 'reached the server exactly once')
    })

test('responses review: tool calls on a length finish are not dispatched',
    async t => {
        const r = await responsesRepo(t, () => responsesFindingsReply([], {
            status:'incomplete',
            incomplete_details:{ reason:'max_output_tokens' },
        }))
        const requests = requestRecorder(r)
        const res = await r.roast(REVIEW)
        t.equal(res.code, 4, res.stderr)
        t.equal(requests().length, 1, 'a length finish is not retried')
        const outputs = requests().filter(req =>
            ((req.body as Body).input ?? []).some(item =>
                item.type === 'function_call_output'))
        t.equal(outputs.length, 0, 'no follow-up turn carries tool output')
    })

test('responses review: cached tokens are subtracted once in meta.json',
    async t => {
        for (const [cached, uncached] of [[30, 70], [80, 20]]) {
            const r = await responsesRepo(t, () => responsesFindingsReply([],
                {
                    usage:{
                        input_tokens:100,
                        input_tokens_details:{ cached_tokens:cached },
                        output_tokens:5,
                        total_tokens:105,
                    },
                }))
            const res = await r.roast(REVIEW)
            t.equal(res.code, 0, res.stderr)
            const usage = reviewMeta(r).usage.finder
            t.equal(usage.uncached_input_tokens, uncached,
                `cached ${cached}: uncached`)
            t.equal(usage.cached_input_tokens, cached,
                `cached ${cached}: cached`)
        }
    })

const AMBIENT:Record<string, string> = {
    OPENAI_API_KEY:'sk-ambient-openai',
    OPENAI_ORG_ID:'org-ambient',
    OPENAI_PROJECT_ID:'proj-ambient',
    OPENAI_CUSTOM_HEADERS:'X-Ambient: yes\nUser-Agent: ambient-ua',
    OPENROUTER_API_KEY:'sk-or-ambient',
    OPENROUTER_HTTP_REFERER:'https://ambient.example',
    ANTHROPIC_CUSTOM_HEADERS:'X-Agent-Session-Id: ambient-session',
}

const TRANSPORT = new Set(['host', 'connection', 'content-length',
    'accept-encoding', 'accept-language', 'sec-fetch-mode',
    'transfer-encoding'])

test('responses review: ambient variables add no headers or keys',
    async t => {
        const r = await responsesRepo(t, responsesFinder())
        const decoy = await startInferenceServer(responsesFinder())
        t.cleanup(() => decoy.close())
        Object.assign(r.env, AMBIENT, {
            OPENAI_BASE_URL:`${decoy.url}/v1`,
        })
        const requests = requestRecorder(r)
        const res = await r.roast(REVIEW)
        t.equal(res.code, 0, res.stderr)
        t.equal(decoy.requests.length, 0, 'decoy saw nothing')
        const sent:RecordedRequest[] = requests()
        t.equal(sent.length, 1, 'one request')
        const names = Object.keys(sent[0].headers)
            .filter(n => !TRANSPORT.has(n))
        t.deepEqual(names.sort(), ['accept', 'authorization',
            'content-type', 'user-agent', 'x-agent-session-id'],
        'only Roast headers')
        t.equal(sent[0].headers.authorization, `Bearer ${FINDER_KEY}`,
            'configured key only')
        const values = Object.values(sent[0].headers).join('\n')
        for (const v of Object.values(AMBIENT)) {
            t.ok(!values.includes(v), `no ambient value ${v}`)
        }
    })

test('responses review: a 3xx is an endpoint error, never followed',
    async t => {
        const target = await startInferenceServer(responsesFinder())
        t.cleanup(() => target.close())
        const r = await responsesRepo(t, () => ({
            status:307,
            headers:{ Location:`${target.url}/v1/responses` },
        }))
        const res = await r.roast(REVIEW)
        t.equal(res.code, 4, 'exit 4')
        t.equal(lastError(res.stderr).error_category, 'endpoint',
            'endpoint category')
        t.equal(target.requests.length, 0, 'redirect target sees nothing')
    })

class Sink implements StreamSink {
    out = ''
    setHeader () {}
    write (s:string) { this.out += s; return true }
    end () {}
}

test('responses review: raw streams are recorded byte for byte',
    async t => {
        const reply = responsesFindingsReply([finding()])
        const r = await responsesRepo(t, () => reply)
        const res = await r.roast(REVIEW)
        t.equal(res.code, 0, res.stderr)
        const expected = new Sink()
        writeInferenceStream(expected, 'responses', reply.stream)
        const dirs = runDirs(r)
        const lines = fs.readFileSync(
            path.join(dirs[0], 'provider-responses.jsonl'), 'utf8')
            .trimEnd().split('\n').map(l => JSON.parse(l))
        t.equal(lines.length, 1, 'one response recorded')
        t.equal(lines[0].protocol, 'responses', 'protocol responses')
        t.equal(lines[0].content_type, 'text/event-stream', 'sse')
        t.equal(lines[0].body, expected.out, 'body byte for byte')
    })
