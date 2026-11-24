// Response body ownership and raw-response capture (spec 06, 2.11): a
// size cap, the Content-Length check, streaming capture that never reads
// ahead of the parser, and the client's sticky failure gate.

import { CaptureError } from './errors.js'
import type { Protocol, RawResponse } from './types.js'

export const MAX_CAPTURED_RESPONSE_SIZE = 16 << 20

// A client's capture state: after the first failure every later request
// fails with the same error without contacting the server.
export class CaptureGate {
    failure?:CaptureError
}

export interface CaptureOptions {
    role:string;
    protocol:Protocol;
    model:string;
    captureResponse?:(raw:RawResponse) => Promise<void>|void;
    // Overrides MAX_CAPTURED_RESPONSE_SIZE (tests).
    limit?:number;
}

export interface CapturedBody {
    // Body chunks, read only as the consumer pulls them.
    chunks:AsyncIterable<Uint8Array>;
    // Idempotent: cancels the body if it is not at EOF, then hands the
    // bytes read to the capture callback. Throws a CaptureError.
    release ():Promise<void>;
}

function latch (
    gate:CaptureGate,
    role:string,
    detail:string,
    cause?:unknown
):CaptureError {
    const err = new CaptureError(
        `capture ${role} provider response: ${detail}`, { cause })
    gate.failure ??= err
    return err
}

function mediaType (contentType:string|null):string {
    return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

function concat (parts:Uint8Array[], size:number):Uint8Array {
    const out = new Uint8Array(size)
    let off = 0
    for (const p of parts) {
        out.set(p, off)
        off += p.length
    }
    return out
}

// `p`, or the signal's reason as soon as it aborts.
export function abortable<T> (p:Promise<T>, signal?:AbortSignal):Promise<T> {
    if (!signal) return p
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once:true })
        p.then(v => {
            signal.removeEventListener('abort', onAbort)
            resolve(v)
        }, (e:unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(e)
        })
    })
}

async function runCallback (
    opts:CaptureOptions,
    gate:CaptureGate,
    contentType:RawResponse['contentType'],
    body:Uint8Array
):Promise<void> {
    if (!opts.captureResponse) return
    try {
        await opts.captureResponse({
            role:opts.role,
            protocol:opts.protocol,
            model:opts.model,
            contentType,
            body,
        })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw latch(gate, opts.role, msg, err)
    }
}

// Opens a 2xx response body for the SSE parser.
export async function openCapturedBody (
    response:Response,
    opts:CaptureOptions,
    gate:CaptureGate,
    signal?:AbortSignal
):Promise<CapturedBody> {
    const limit = opts.limit ?? MAX_CAPTURED_RESPONSE_SIZE
    const reader = response.body?.getReader()
    let done = !reader
    let released = false

    async function cancel ():Promise<void> {
        if (done || !reader) return
        done = true
        await reader.cancel().catch(() => {})
    }

    // The next chunk, or null at EOF.
    async function read ():Promise<Uint8Array|null> {
        if (!reader) return null
        const r = await abortable(reader.read(), signal)
        return r.done ? null : r.value
    }

    const capturing = opts.captureResponse !== undefined
    const length = Number(response.headers.get('content-length') ?? '')
    if (capturing && Number.isFinite(length) && length > limit) {
        await cancel()
        throw latch(gate, opts.role,
            `body exceeds ${limit}-byte limit`)
    }

    const sse = mediaType(response.headers.get('content-type')) ===
        'text/event-stream'
    if (capturing && !sse) {
        const parts:Uint8Array[] = []
        let size = 0
        while (!done) {
            const value = await read()
            if (value === null) {
                done = true
                break
            }
            size += value.length
            if (size > limit) {
                await cancel()
                throw latch(gate, opts.role,
                    `body exceeds ${limit}-byte limit`)
            }
            parts.push(value)
        }
        const body = concat(parts, size)
        try {
            JSON.parse(new TextDecoder().decode(body))
        } catch {
            throw latch(gate, opts.role,
                `${opts.model} returned invalid raw JSON`)
        }
        await runCallback(opts, gate, 'application/json', body)
        async function * once () { yield body }
        return { chunks:once(), release:async () => {} }
    }

    const parts:Uint8Array[] = []
    let size = 0
    let overflowed = false

    async function * chunks ():AsyncGenerator<Uint8Array> {
        while (!done) {
            const value = await read()
            if (value === null) {
                done = true
                return
            }
            if (capturing) {
                if (size + value.length > limit) {
                    overflowed = true
                    await cancel()
                    throw latch(gate, opts.role,
                        `body exceeds ${limit}-byte limit`)
                }
                parts.push(value)
                size += value.length
            }
            yield value
        }
    }

    return {
        chunks:chunks(),
        async release ():Promise<void> {
            if (released) return
            released = true
            await cancel()
            if (!capturing || overflowed) return
            await runCallback(opts, gate, 'text/event-stream',
                concat(parts, size))
        },
    }
}
