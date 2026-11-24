// Exit codes, error categories, and error output (spec 01, 2.2 to 2.4).
import { LlmError } from '../llm/errors.js'
import { text } from '../textsafe/textsafe.js'

export const ExitCode = {
    Clean:0,
    Findings:1,
    Usage:2,
    Auth:3,
    Partial:4,
    Cancelled:5,
} as const

export type ErrorCategory = 'none'|'findings'|'usage'|'auth'|'endpoint'|
    'resource_limit'|'partial'|'cancelled'

export type ErrorFormat = 'text'|'json'

// A bad flag, command, config, or anything else the user must fix.
export class UsageError extends Error {
    constructor (message:string, options?:ErrorOptions) {
        super(message, options)
        this.name = 'UsageError'
    }
}

// The run was cancelled (first SIGINT/SIGTERM, Ctrl-C at a prompt).
export class CancelledError extends Error {
    constructor (message = 'cancelled', options?:ErrorOptions) {
        super(message, options)
        this.name = 'CancelledError'
    }
}

// A successful command asking for a non-zero exit with nothing printed
// (Go gateExit): 1 for gating findings, 4 for a partial review.
export class ExitSignal extends Error {
    readonly code:1|4

    constructor (code:1|4) {
        super(`exit ${code}`)
        this.code = code
        this.name = 'ExitSignal'
    }
}

// Walks err, err.cause, ... and reports whether any link passes `test`.
// Stops on a cycle or at the first non-Error.
export function errorChainHas (
    err:unknown,
    test:(e:Error) => boolean
):boolean {
    const seen = new Set<unknown>()
    let cur = err
    while (cur instanceof Error && !seen.has(cur)) {
        if (test(cur)) return true
        seen.add(cur)
        cur = cur.cause
    }
    return false
}

function isAbortError (e:Error):boolean {
    return e.name === 'AbortError'
}

// Cancellation: a CancelledError in the chain, or an AbortError raised
// while `signal` is aborted with a CancelledError reason. A TimeoutError
// is never cancellation.
export function isCancellation (err:unknown, signal?:AbortSignal):boolean {
    if (errorChainHas(err, e => e instanceof CancelledError)) return true
    if (!signal?.aborted) return false
    if (!(signal.reason instanceof CancelledError)) return false
    return errorChainHas(err, isAbortError)
}

function llmKind (err:unknown, kinds:string[]):boolean {
    return errorChainHas(err, e => {
        return e instanceof LlmError && kinds.includes(e.kind)
    })
}

function isUsage (err:unknown):boolean {
    return errorChainHas(err, e => e instanceof UsageError)
}

export function exitCode (err:unknown, signal?:AbortSignal):number {
    if (err === undefined || err === null) return ExitCode.Clean
    if (err instanceof ExitSignal) return err.code
    if (isCancellation(err, signal)) return ExitCode.Cancelled
    if (llmKind(err, ['auth'])) return ExitCode.Auth
    if (isUsage(err)) return ExitCode.Usage
    return ExitCode.Partial
}

export function errorCategoryFor (
    code:number,
    err:unknown,
    signal?:AbortSignal
):ErrorCategory {
    if (code === ExitCode.Clean) return 'none'
    if (code === ExitCode.Findings) return 'findings'
    if (isCancellation(err, signal)) return 'cancelled'
    if (llmKind(err, ['auth'])) return 'auth'
    if (llmKind(err, ['endpoint'])) return 'endpoint'
    if (llmKind(err, ['budget_exhausted', 'work_deadline',
        'no_final_call'])) {
        return 'resource_limit'
    }
    if (isUsage(err) || code === ExitCode.Usage) return 'usage'
    if (code === ExitCode.Cancelled) return 'cancelled'
    return 'partial'
}

// Writes an error to `out`: `roast: <message>` sanitized, or one JSON
// object. An ExitSignal writes nothing.
export function writeError (
    out:NodeJS.WritableStream,
    code:number,
    err:Error,
    format:ErrorFormat,
    signal?:AbortSignal
):void {
    if (err instanceof ExitSignal) return
    if (format === 'json') {
        const body = {
            error_category:errorCategoryFor(code, err, signal),
            message:err.message,
            exit_code:code,
        }
        out.write(`${JSON.stringify(body)}\n`)
        return
    }
    out.write(`roast: ${text(err.message)}\n`)
}
