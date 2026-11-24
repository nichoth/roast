// The llm area's error vocabulary (spec 06, 2.10 and 3.4; spec 07, 3.4).
// The CLI maps errors to exit codes and categories by walking an error's
// `cause` chain (src/cli/errors.ts); callers test sentinels with
// `hasSentinel`.

import type { FinishReason } from './types.js'

export type LlmErrorKind =
    'auth'|'endpoint'|'budget_exhausted'|'work_deadline'|'no_final_call'

export type Sentinel = 'no-final-call'|'work-deadline'|
    'budget-exhausted'|'auth'|'endpoint'

// Why a conversation ended without an accepted submission (spec 07,
// 2.6, 2.10, 2.14), for callers and tests that must not match text.
export type StopCauseKind =
    // An abnormal finish reason; see `finishReason`.
    | 'finish-reason'
    | 'recorded-before-cutoff'
    | 'kept-recording'
    // The last final call failed type validation provisionally.
    | 'schema-mismatch'
    // The accepted final call failed required-field validation.
    | 'tool-call-validation'
    | 'answered-without-final'
    | 'other-tools-instead'
    | 'deadline-during-finalization'
    // The final arguments did not satisfy the schema (terminal).
    | 'invalid-arguments'

export interface ErrorDetails {
    model?:string;
    finishReason?:FinishReason;
    rawFinishReason?:string;
    submissionAttempts?:number;
    recordRounds?:number;
    stopCause?:StopCauseKind;
    // A cutoff error's cause, as text only: it is not matchable.
    cause?:string;
}

export interface LlmErrorOptions extends ErrorOptions {
    details?:ErrorDetails;
    // Extra sentinels besides the kind's own (cutoff errors).
    sentinels?:Sentinel[];
}

const KIND_SENTINEL:Record<LlmErrorKind, Sentinel> = {
    auth:'auth',
    endpoint:'endpoint',
    budget_exhausted:'budget-exhausted',
    work_deadline:'work-deadline',
    no_final_call:'no-final-call',
}

// Go sentinel messages (spec 07, 2.14).
export const SENTINEL_MESSAGE:Record<Sentinel, string> = {
    'no-final-call':'llm: tool loop ended without a final tool call',
    'work-deadline':'llm: work deadline reached',
    'budget-exhausted':'llm: run token budget exhausted',
    auth:'llm: authentication failed',
    endpoint:'llm: inference endpoint failure',
}

export class LlmError extends Error {
    readonly kind:LlmErrorKind
    readonly sentinels:ReadonlySet<Sentinel>
    readonly details:ErrorDetails

    constructor (
        kind:LlmErrorKind,
        message:string,
        options?:LlmErrorOptions
    ) {
        super(message, options)
        this.kind = kind
        this.name = 'LlmError'
        this.sentinels = new Set([
            KIND_SENTINEL[kind],
            ...(options?.sentinels ?? []),
        ])
        this.details = { ...options?.details }
    }
}

// The provider rejected the credential (401 or 403).
export class AuthError extends LlmError {
    constructor (message:string, options?:LlmErrorOptions) {
        super('auth', message, options)
        this.name = 'AuthError'
    }
}

// The endpoint failed: transport errors, redirects, 5xx, bad responses.
export class EndpointError extends LlmError {
    constructor (message:string, options?:LlmErrorOptions) {
        super('endpoint', message, options)
        this.name = 'EndpointError'
    }
}

// The token budget ran out.
export class BudgetExhaustedError extends LlmError {
    constructor (message:string, options?:LlmErrorOptions) {
        super('budget_exhausted', message, options)
        this.name = 'BudgetExhaustedError'
    }
}

// The work deadline passed.
export class WorkDeadlineError extends LlmError {
    constructor (message:string, options?:LlmErrorOptions) {
        super('work_deadline', message, options)
        this.name = 'WorkDeadlineError'
    }
}

// The agent loop ended without the required final tool call.
export class NoFinalCallError extends LlmError {
    constructor (message:string, options?:LlmErrorOptions) {
        super('no_final_call', message, options)
        this.name = 'NoFinalCallError'
    }
}

export interface ProviderErrorOptions extends ErrorOptions {
    status?:number;
    // Lowercased names.
    headers?:Record<string, string>;
    providerType?:string;
    providerCode?:string;
    providerMessage?:string;
    retryable?:boolean;
}

// One failed model call: an HTTP error, an error inside a 200 stream, an
// incomplete stream, a transport failure, or a protocol error.
export class ProviderError extends Error {
    readonly status?:number
    readonly headers?:Record<string, string>
    readonly providerType?:string
    readonly providerCode?:string
    readonly providerMessage?:string
    readonly retryable:boolean

    constructor (message:string, options:ProviderErrorOptions = {}) {
        super(message, options)
        this.name = 'ProviderError'
        this.status = options.status
        this.headers = options.headers
        this.providerType = options.providerType
        this.providerCode = options.providerCode
        this.providerMessage = options.providerMessage
        this.retryable = options.retryable ??
            (options.status !== undefined &&
                httpRetryable(options.status, options.headers ?? {}))
    }
}

// The body ended cleanly without the protocol's terminal signal.
export class IncompleteStreamError extends ProviderError {
    constructor () {
        super('stream transport error: unexpected EOF', { retryable:true })
        this.name = 'IncompleteStreamError'
    }
}

// Capturing a raw response failed. Permanent: never retried, and it
// disables the client.
export class CaptureError extends Error {
    constructor (message:string, options?:ErrorOptions) {
        super(message, options)
        this.name = 'CaptureError'
    }
}

const PARSE_BOOL_TRUE = new Set(['1', 't', 'T', 'true', 'TRUE', 'True'])

function httpRetryable (
    status:number,
    headers:Record<string, string>
):boolean {
    const should = headers['x-should-retry']
    if (should !== undefined && PARSE_BOOL_TRUE.has(should)) return true
    return status === 408 || status === 409 || status === 429 ||
        status >= 500
}

const TRANSIENT_STREAM_TYPES = new Set([
    'server_error',
    'internal_error',
    'overloaded_error',
    'api_error',
    'rate_limit_error',
])

// An error delivered inside a 200 stream; retryable for transient
// provider types (the code stands in when the type is empty).
export function streamError (
    type:string,
    code:string,
    message:string
):ProviderError {
    const kind = type || code
    const label = kind ? `${kind}: ${message}` : message
    return new ProviderError(`stream error: ${label}`, {
        providerType:type || undefined,
        providerCode:code || undefined,
        providerMessage:message,
        retryable:TRANSIENT_STREAM_TYPES.has(kind),
    })
}

// Each error in `err`'s cause chain, outermost first; cycle safe.
function * chain (err:unknown):Generator<Error> {
    const seen = new Set<unknown>()
    let cur = err
    while (cur instanceof Error && !seen.has(cur)) {
        seen.add(cur)
        yield cur
        cur = cur.cause
    }
}

export function hasSentinel (err:unknown, s:Sentinel):boolean {
    for (const e of chain(err)) {
        if (e instanceof LlmError && e.sentinels.has(s)) return true
    }
    return false
}

function isAbortLike (e:Error):boolean {
    return e.name === 'AbortError' || e.name === 'TimeoutError'
}

const TRANSPORT_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ERR_STREAM_PREMATURE_CLOSE',
])

function isTransport (e:Error):boolean {
    const code = (e as { code?:unknown }).code
    if (typeof code !== 'string') return false
    return TRANSPORT_CODES.has(code) || code.startsWith('UND_ERR_')
}

export function isRetryable (err:unknown):boolean {
    const errs = [...chain(err)]
    if (errs.some(e => isAbortLike(e) || e instanceof CaptureError)) {
        return false
    }
    const provider = errs.find(e => e instanceof ProviderError)
    if (provider) return provider.retryable
    return errs.some(isTransport)
}

const MAX_HINT_MS = 60_000

function headerHintMs (
    headers:Record<string, string>,
    now:number
):number|undefined {
    const ms = parseNumber(headers['retry-after-ms'])
    if (ms !== undefined) return ms
    const after = headers['retry-after']
    if (after === undefined) return undefined
    const secs = parseNumber(after)
    if (secs !== undefined) return secs * 1000
    const date = Date.parse(after)
    return Number.isNaN(date) ? undefined : date - now
}

function parseNumber (s:string|undefined):number|undefined {
    if (s === undefined || s.trim() === '') return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
}

// The delay before the next attempt: the provider's hint when it is
// positive and under 60 s or under the backoff, else the backoff.
export function retryDelayMs (
    err:unknown,
    backoffMs:number,
    now:number = Date.now()
):number {
    for (const e of chain(err)) {
        if (!(e instanceof ProviderError) || !e.headers) continue
        const hint = headerHintMs(e.headers, now)
        if (hint !== undefined && hint > 0 &&
            (hint < MAX_HINT_MS || hint < backoffMs)) {
            return hint
        }
        break
    }
    return backoffMs
}

export function errorStatus (err:unknown):number|undefined {
    for (const e of chain(err)) {
        const status = (e as { status?:unknown }).status
        if (typeof status === 'number') return status
    }
    return undefined
}

function endpointFailure (model:string, err:unknown):EndpointError {
    const msg = err instanceof Error ? err.message : String(err)
    return new EndpointError(
        `${SENTINEL_MESSAGE.endpoint}: ${model}: ${msg}`,
        { cause:err, details:{ model } })
}

// Maps an error that escapes the agent loop (spec 06, 2.10).
export function normalizeProviderError (
    outer:AbortSignal,
    model:string,
    err:unknown
):unknown {
    if (outer.aborted) return outer.reason
    if ([...chain(err)].some(isAbortLike)) return endpointFailure(model, err)
    if (hasSentinel(err, 'auth') || hasSentinel(err, 'endpoint') ||
        hasSentinel(err, 'budget-exhausted')) {
        return err
    }
    const status = errorStatus(err)
    if (status === 401 || status === 403) {
        const msg = err instanceof Error ? err.message : String(err)
        return new AuthError(
            `${SENTINEL_MESSAGE.auth}: ${msg}; check the configured API key`,
            { cause:err, details:{ model } })
    }
    return endpointFailure(model, err)
}

// Final arguments that failed type validation (spec 07, 2.14 result
// precedence 2). Carries no sentinel, as in Go.
export class FinalArgumentsError extends Error {
    readonly details:ErrorDetails

    constructor (message:string, details:ErrorDetails = {}) {
        super(message)
        this.name = 'FinalArgumentsError'
        this.details = { ...details }
    }
}

function detailsOf (err:unknown):ErrorDetails {
    if (err instanceof LlmError || err instanceof FinalArgumentsError) {
        return err.details
    }
    return {}
}

const CUTOFF_KIND:Partial<Record<Sentinel, LlmErrorKind>> = {
    'work-deadline':'work_deadline',
    'budget-exhausted':'budget_exhausted',
}

// A graceful cutoff (spec 07, 2.14): matches the cutoff sentinel (or
// `no-final-call` without one) and `no-final-call`. The cause adds text
// and details only; it is kept out of the matchable chain.
export function cutoffError (
    cutoff:'work-deadline'|'budget-exhausted'|null,
    what:string,
    cause?:unknown,
    details:ErrorDetails = {}
):LlmError {
    const head = SENTINEL_MESSAGE[cutoff ?? 'no-final-call']
    let message = `${head}; ${what}: ${SENTINEL_MESSAGE['no-final-call']}`
    const merged:ErrorDetails = { ...detailsOf(cause), ...details }
    if (cause !== undefined) {
        const text = cause instanceof Error ? cause.message : String(cause)
        message += `: ${text}`
        merged.cause = text
    }
    const kind = (cutoff && CUTOFF_KIND[cutoff]) ?? 'no_final_call'
    return new LlmError(kind, message, {
        sentinels:['no-final-call'],
        details:merged,
    })
}
