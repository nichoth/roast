import { test } from '@substrate-system/tapzero'
import {
    AuthError,
    EndpointError,
    BudgetExhaustedError,
    WorkDeadlineError,
    NoFinalCallError,
    LlmError,
    ProviderError,
    IncompleteStreamError,
    CaptureError,
    hasSentinel,
    isRetryable,
    retryDelayMs,
    errorStatus,
    normalizeProviderError,
    streamError,
} from '../../src/llm/errors.js'

function httpError (status:number, headers:Record<string, string> = {}) {
    return new ProviderError(`status ${status}`, { status, headers })
}

function netError (code:string):Error {
    const cause = Object.assign(new Error(code), { code })
    return new TypeError('fetch failed', { cause })
}

test('hasSentinel recognizes auth and endpoint through cause', t => {
    const auth = new AuthError('a')
    const endpoint = new EndpointError('e')
    t.ok(hasSentinel(auth, 'auth'), 'auth')
    t.ok(!hasSentinel(auth, 'endpoint'), 'auth is not endpoint')
    t.ok(hasSentinel(endpoint, 'endpoint'), 'endpoint')
    const wrapped = new Error('outer', {
        cause:new Error('mid', { cause:auth }),
    })
    t.ok(hasSentinel(wrapped, 'auth'), 'auth through two causes')
    t.ok(hasSentinel(new Error('x', { cause:endpoint }), 'endpoint'),
        'endpoint through a cause')
    t.ok(hasSentinel(new BudgetExhaustedError('b'), 'budget-exhausted'),
        'budget')
    t.ok(hasSentinel(new WorkDeadlineError('w'), 'work-deadline'),
        'deadline')
    t.ok(hasSentinel(new NoFinalCallError('n'), 'no-final-call'),
        'no final call')
    t.ok(!hasSentinel(new Error('plain'), 'auth'), 'plain error')
    t.ok(!hasSentinel('str', 'auth'), 'non-error')
    const a = new Error('a')
    const b = new Error('b', { cause:a })
    ;(a as { cause?:unknown }).cause = b
    t.ok(!hasSentinel(b, 'auth'), 'cycle safe')
})

test('LlmError keeps kind and carries sentinels and details', t => {
    const e = new EndpointError('e')
    t.ok(e instanceof LlmError, 'is an LlmError')
    t.equal(e.kind, 'endpoint', 'kind kept')
    t.deepEqual([...e.sentinels], ['endpoint'], 'sentinels')
    t.deepEqual(e.details, {}, 'empty details')
    const d = new EndpointError('e', { details:{ model:'m' } })
    t.equal(d.details.model, 'm', 'details given')
})

test('classification of HTTP errors', t => {
    for (const s of [408, 409, 429, 500, 502, 503, 529]) {
        t.ok(isRetryable(httpError(s)), `${s} retryable`)
    }
    for (const s of [400, 401, 403, 404, 301, 302, 307]) {
        t.ok(!isRetryable(httpError(s)), `${s} not retryable`)
    }
    for (const v of ['1', 't', 'T', 'true', 'TRUE', 'True']) {
        t.ok(isRetryable(httpError(400, { 'x-should-retry':v })),
            `x-should-retry ${v}`)
    }
    t.ok(!isRetryable(httpError(400, { 'x-should-retry':'yes' })),
        'not a ParseBool spelling')
    t.ok(isRetryable(httpError(503, { 'x-should-retry':'false' })),
        'false header does not block a status retry')
})

test('classification of stream, transport, abort, capture errors', t => {
    for (const ty of ['server_error', 'internal_error', 'overloaded_error',
        'api_error', 'rate_limit_error']) {
        t.ok(isRetryable(streamError(ty, '', 'm')), `stream ${ty}`)
        t.ok(isRetryable(streamError('', ty, 'm')), `stream code ${ty}`)
    }
    t.ok(!isRetryable(streamError('invalid_request_error', '', 'm')),
        'stream invalid request')
    t.ok(isRetryable(new IncompleteStreamError()), 'incomplete stream')
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
        'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET',
        'ERR_STREAM_PREMATURE_CLOSE']) {
        t.ok(isRetryable(netError(code)), `transport ${code}`)
    }
    t.ok(!isRetryable(new DOMException('a', 'AbortError')), 'abort')
    t.ok(!isRetryable(new DOMException('t', 'TimeoutError')), 'timeout')
    t.ok(!isRetryable(new CaptureError('c')), 'capture')
    t.ok(!isRetryable(new Error('c', { cause:new CaptureError('c') })),
        'wrapped capture')
    t.ok(!isRetryable(new Error('plain')), 'plain error')
    t.ok(!isRetryable(new EndpointError('redirect', {
        cause:httpError(302),
    })), 'endpoint error over a 3xx')
})

test('retryDelayMs honors hints and ignores out-of-range ones', t => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    const h = (headers:Record<string, string>) => httpError(429, headers)
    t.equal(retryDelayMs(h({ 'retry-after-ms':'1500' }), 5000, now), 1500,
        'retry-after-ms')
    t.equal(retryDelayMs(h({ 'retry-after-ms':'2.5' }), 5000, now), 2.5,
        'fractional ms')
    t.equal(retryDelayMs(h({ 'retry-after':'3' }), 5000, now), 3000,
        'retry-after seconds')
    t.equal(retryDelayMs(h({ 'retry-after':'0.5' }), 5000, now), 500,
        'fractional seconds')
    t.equal(retryDelayMs(h({
        'retry-after':'Thu, 01 Jan 2026 00:00:07 GMT',
    }), 5000, now), 7000, 'retry-after date')
    t.equal(retryDelayMs(h({
        'retry-after-ms':'100', 'retry-after':'9',
    }), 5000, now), 100, 'ms wins over seconds')
    t.equal(retryDelayMs(h({ 'retry-after':'120' }), 5000, now), 5000,
        'over 60s and over backoff')
    t.equal(retryDelayMs(h({ 'retry-after':'120' }), 200000, now), 120000,
        'over 60s but under backoff')
    t.equal(retryDelayMs(h({ 'retry-after':'-1' }), 5000, now), 5000,
        'negative')
    t.equal(retryDelayMs(h({ 'retry-after':'soon' }), 5000, now), 5000,
        'garbage')
    t.equal(retryDelayMs(h({
        'retry-after':'Wed, 31 Dec 2025 23:59:00 GMT',
    }), 5000, now), 5000, 'date in the past')
    t.equal(retryDelayMs(h({}), 5000, now), 5000, 'no hint')
    t.equal(retryDelayMs(new Error('x'), 10000, now), 10000, 'not HTTP')
})

test('errorStatus walks the cause chain', t => {
    t.equal(errorStatus(httpError(429)), 429, 'direct')
    t.equal(errorStatus(new Error('x', { cause:httpError(401) })), 401,
        'wrapped')
    t.equal(errorStatus(new Error('x')), undefined, 'none')
})

test('normalizeProviderError order', t => {
    const outer = new AbortController()
    const reason = new Error('cancelled by caller')
    outer.abort(reason)
    t.equal(normalizeProviderError(outer.signal, 'm', httpError(401)),
        reason, 'aborted caller passes its reason through')

    const live = new AbortController().signal
    const timeout = new DOMException('t', 'TimeoutError')
    const te = normalizeProviderError(live, 'm', timeout)
    t.ok(te instanceof EndpointError, 'timeout is an endpoint error')
    t.equal((te as Error).cause, timeout, 'timeout kept as cause')

    const auth = new AuthError('a')
    t.equal(normalizeProviderError(live, 'm', auth), auth, 'auth as is')
    const budget = new BudgetExhaustedError('b')
    t.equal(normalizeProviderError(live, 'm', budget), budget,
        'budget as is')

    const a401 = normalizeProviderError(live, 'm',
        new Error('w', { cause:httpError(401) }))
    t.ok(hasSentinel(a401, 'auth'), '401 in the chain is auth')
    t.ok(hasSentinel(normalizeProviderError(live, 'm', httpError(403)),
        'auth'), '403 is auth')
    const other = normalizeProviderError(live, 'm', httpError(500))
    t.ok(hasSentinel(other, 'endpoint'), '500 is endpoint')
    t.equal(errorStatus(other), 500, 'status still reachable')
})
