// Opt-in live Anthropic test (successor of Go's
// TestLiveAnthropicTwoTurnReview). Skips unless
// ROAST_LIVE_ANTHROPIC_API_KEY is set; `_BASE_URL` and `_MODELS` (comma
// separated) are optional. Keys are never logged.
import { test } from '@substrate-system/tapzero'
import { createClient, createModelClient } from '../../src/llm/client.js'
import { newSessionId } from '../../src/llm/session.js'
import type { Tool } from '../../src/llm/types.js'

function setting (name:string, fallback:string):string {
    const value = (process.env[name] ?? '').trim()
    return value === '' ? fallback : value
}

const KEY = setting('ROAST_LIVE_ANTHROPIC_API_KEY', '')
const BASE = setting('ROAST_LIVE_ANTHROPIC_BASE_URL',
    'https://api.anthropic.com/v1')
const MODELS = setting('ROAST_LIVE_ANTHROPIC_MODELS', 'claude-sonnet-5-5')
    .split(',').map(m => m.trim()).filter(m => m !== '')

// A fetch that records each request body's tool choice type.
function recordingFetch (choices:string[]):typeof globalThis.fetch {
    return (input, init) => {
        try {
            const body = JSON.parse(new TextDecoder().decode(
                init?.body as Uint8Array))
            choices.push(String(body.tool_choice?.type ?? ''))
        } catch {
            choices.push('?')
        }
        return globalThis.fetch(input, init)
    }
}

function decodeToken (value:unknown):{ token?:string } {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('result is not an object')
    }
    const token = (value as Record<string, unknown>).token
    if (token === undefined || token === null) return {}
    if (typeof token !== 'string') throw new Error('token is not a string')
    return { token }
}

async function twoTurn (
    t:Parameters<NonNullable<Parameters<typeof test>[1]>>[0],
    model:string
):Promise<void> {
    const choices:string[] = []
    const client = createClient(createModelClient({
        role:'finder',
        baseUrl:BASE,
        apiKey:KEY,
        model,
        protocol:'anthropic',
        maxOutputTokens:4096,
        maxAttempts:2,
        requestTimeoutMs:120_000,
        fetch:recordingFetch(choices),
    }))
    const token = newSessionId()
    let read = false
    const tools:Tool[] = [
        {
            name:'read_note',
            description:'Read the note that holds the token.',
            schema:{ type:'object', properties:{}, additionalProperties:false },
            run () {
                read = true
                return { token }
            },
        },
        {
            name:'submit',
            description:'Submit the result.',
            schema:{
                type:'object',
                properties:{ token:{ type:'string' } },
                required:['token'],
                additionalProperties:false,
            },
        },
    ]
    const out = await client.converse(
        'You are checking a tool loop. Call read_note exactly once, then ' +
            'call submit with token set to the token read_note returned.',
        'Begin.',
        {
            tools,
            finalTool:'submit',
            final:{ decode:decodeToken },
            maxTurns:2
        },
        new AbortController().signal)
    t.comment(`${model}: requests=${choices.length} ` +
        `tool choices=${choices.join(',')}`)
    t.ok(read, `${model}: read_note ran`)
    t.equal(out.token, token, `${model}: the tool result round-tripped`)
    t.ok(choices.length >= 2, `${model}: at least two requests`)
    t.ok(choices.every(c => c === 'auto'), `${model}: auto tool choice`)
}

test('live anthropic: a two-turn review completes per model', async t => {
    if (KEY === '') {
        t.ok(true, 'skipped: set ROAST_LIVE_ANTHROPIC_API_KEY to run ' +
            'against a native Anthropic endpoint')
        return
    }
    for (const model of MODELS) await twoTurn(t, model)
})
