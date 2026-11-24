// Opt-in live DeepSeek tests (successors of Go's
// TestLiveDeepSeekTwoTurnReview and TestLiveDeepSeekReasoningCeiling).
// Each skips unless ROAST_LIVE_DEEPSEEK_API_KEY is set. Keys are never
// logged; failures report only tool choices and provider findings.
import { test } from '@substrate-system/tapzero'
import { createClient, createModelClient } from '../../src/llm/client.js'
import type { LlmError } from '../../src/llm/errors.js'
import { hasSentinel } from '../../src/llm/errors.js'
import { newSessionId } from '../../src/llm/session.js'
import type { ClientConfig, Protocol, Tool } from '../../src/llm/types.js'

function setting (name:string, fallback:string):string {
    const value = (process.env[name] ?? '').trim()
    return value === '' ? fallback : value
}

const KEY = setting('ROAST_LIVE_DEEPSEEK_API_KEY', '')
const SKIP = 'set ROAST_LIVE_DEEPSEEK_API_KEY to run against a DeepSeek ' +
    'endpoint'

// A test that skips, with a passing note, when no key is set.
function live (name:string, fn:Parameters<typeof test>[1]):void {
    test(name, t => {
        if (KEY === '') {
            t.ok(true, `skipped: ${SKIP}`)
            return
        }
        return fn?.(t)
    })
}

function config (over:Partial<ClientConfig>):ClientConfig {
    return {
        role:'finder',
        baseUrl:setting('ROAST_LIVE_DEEPSEEK_BASE_URL',
            'https://api.deepseek.com/v1'),
        apiKey:KEY,
        model:setting('ROAST_LIVE_DEEPSEEK_MODEL', 'deepseek-v4-pro'),
        protocol:setting('ROAST_LIVE_DEEPSEEK_PROTOCOL', 'chat') as Protocol,
        maxOutputTokens:1024,
        maxAttempts:2,
        requestTimeoutMs:120_000,
        ...over,
    }
}

// A fetch that records each request body's tool choice.
function recordingFetch (choices:string[]):typeof globalThis.fetch {
    return (input, init) => {
        try {
            const body = JSON.parse(String(init?.body ?? '{}'))
            choices.push(JSON.stringify(body.tool_choice ?? ''))
        } catch {
            choices.push('?')
        }
        return globalThis.fetch(input, init)
    }
}

interface Primes {
    primes?:number;
    token?:string;
}

function decodePrimes (value:unknown):Primes {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('result is not an object')
    }
    const v = value as Record<string, unknown>
    const out:Primes = {}
    if (v.primes !== undefined && v.primes !== null) {
        if (typeof v.primes !== 'number' || !Number.isInteger(v.primes)) {
            throw new Error('primes is not an integer')
        }
        out.primes = v.primes
    }
    if (v.token !== undefined && v.token !== null) {
        if (typeof v.token !== 'string') throw new Error('token not a string')
        out.token = v.token
    }
    return out
}

live('live deepseek: a two-turn review conversation completes', async t => {
    const choices:string[] = []
    const client = createClient(createModelClient(config({
        fetch:recordingFetch(choices),
    })))
    const token = newSessionId()
    let read = false
    const tools:Tool[] = [
        {
            name:'read_note',
            description:'Read the note that holds the token.',
            schema:{
                type:'object',
                properties:{},
                additionalProperties:false,
            },
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
                properties:{
                    primes:{ type:'integer' },
                    token:{ type:'string' },
                },
                required:['primes', 'token'],
                additionalProperties:false,
            },
        },
    ]
    const out = await client.converse(
        'You are checking a tool loop. Before calling any tool, think ' +
            'carefully: how many of 2^31-1, 2^61-1, and 2^67-1 are prime? ' +
            'Then call read_note exactly once. Then call submit with ' +
            'primes set to that count and token set to the token ' +
            'read_note returned.',
        'Begin.',
        {
            tools,
            finalTool:'submit',
            final:{ decode:decodePrimes },
            maxTurns:2
        },
        new AbortController().signal)
    t.comment(`requests=${choices.length} tool choices=${choices.join(',')}`)
    t.ok(read, 'read_note ran')
    t.equal(out.token, token, 'the tool result round-tripped')
    t.ok(choices.length >= 2, 'at least two requests')
    t.ok(choices.every(c => c === '""' || c === '"auto"'),
        'no request forced a tool choice')
})

live('live deepseek: a reasoning ceiling names the length finish',
    async t => {
        const client = createClient(createModelClient(config({
            maxOutputTokens:256,
            maxAttempts:1,
        })))
        let err:unknown
        let out:Primes|undefined
        try {
            out = await client.completeStructured(
                'Before calling any tool, think carefully and at length: ' +
                    'for each of 2^31-1, 2^61-1, and 2^67-1, decide ' +
                    'whether it is prime and check your reasoning. Then ' +
                    'call submit with primes set to that count.',
                'Begin.',
                'submit',
                {
                    schema:{
                        type:'object',
                        properties:{ primes:{ type:'integer' } },
                        required:['primes'],
                        additionalProperties:false,
                    },
                    decode:decodePrimes,
                },
                new AbortController().signal)
        } catch (e) {
            err = e
        }
        if (err === undefined) {
            t.comment('the model submitted within a 256-token ceiling ' +
                `(primes=${out?.primes}); the length path was not exercised`)
            return
        }
        t.ok(hasSentinel(err, 'no-final-call'), 'no-final-call')
        t.ok(!hasSentinel(err, 'endpoint'), 'not an endpoint failure')
        t.equal((err as LlmError).details?.finishReason, 'length',
            'names the length finish')
    })
