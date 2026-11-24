// Step retries (spec 07, 2.11): a turn's request is retried on retryable
// errors, never on aborts, capture failures, or cutoff errors.

import { isRetryable, retryDelayMs } from './errors.js'

export const INITIAL_BACKOFF_MS = 5000

export type Sleep = (ms:number, signal:AbortSignal) => Promise<void>

export function defaultSleep (ms:number, signal:AbortSignal):Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason)
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal.reason)
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal.addEventListener('abort', onAbort, { once:true })
    })
}

// The delay before the next attempt: the provider's hint, else backoff.
export function retryDelay (err:unknown, backoffMs:number):number {
    return retryDelayMs(err, backoffMs)
}

// Runs `attempt`, retrying a retryable failure up to `maxRetries` times
// with doubling backoff. The last attempt's error is thrown.
export async function withStepRetry<R> (
    attempt:() => Promise<R>,
    opts:{ maxRetries:number, signal:AbortSignal, sleep?:Sleep }
):Promise<R> {
    const sleep = opts.sleep ?? defaultSleep
    let backoff = INITIAL_BACKOFF_MS
    for (let retries = 0; ; retries++) {
        try {
            return await attempt()
        } catch (err) {
            if (opts.signal.aborted || retries >= opts.maxRetries ||
                !isRetryable(err)) {
                throw err
            }
            await sleep(retryDelay(err, backoff), opts.signal)
            backoff *= 2
        }
    }
}
