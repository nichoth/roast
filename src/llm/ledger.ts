// The run's token ledger (spec 07, 2.13): one admission controller shared
// by the finder and verifier clients. It reserves each call's worst-case
// footprint before the call is sent and always keeps headroom for the
// wrap-up submission. All arithmetic is floating point; every method is
// synchronous, so concurrent conversations cannot interleave inside a
// reservation.

import type { Usage } from './types.js'

// Conservative tokenization: code-heavy prompts run about 3 bytes/token,
// so this over-estimates, the safe direction for admission.
export const EST_BYTES_PER_TOKEN = 3
export const DEFAULT_FINAL_ALLOWANCE = 100_000
// Cache reads bill about 0.1x.
export const CACHED_TOKEN_WEIGHT = 0.1

// Reconciles one reservation with the response's usage. Idempotent.
export type Release = (usage:Usage) => void

export function weightedTokens (usage:Usage):number {
    return Math.max(usage.uncachedInputTokens, 0) +
        CACHED_TOKEN_WEIGHT * Math.max(usage.cachedInputTokens, 0) +
        Math.max(usage.cacheWriteTokens, 0) +
        Math.max(usage.outputTokens, 0)
}

export class Ledger {
    private readonly limit:number
    private readonly finalAllowance:number
    private spent = 0
    private held = 0
    private refused = false

    constructor (limit:number) {
        this.limit = limit
        this.finalAllowance = Math.min(DEFAULT_FINAL_ALLOWANCE, limit / 2)
    }

    // Null when refused. A non-final reservation holds back the larger of
    // the final allowance and this request's own footprint plus a
    // worst-case response; a final reservation may use the whole limit.
    reserve (reqBytes:number, maxOutput:number, final:boolean):Release|null {
        const est = reqBytes / EST_BYTES_PER_TOKEN + maxOutput
        let headroom = this.limit
        if (!final) headroom -= Math.max(this.finalAllowance, est + maxOutput)
        if (this.spent + this.held + est > headroom) {
            this.refused = true
            return null
        }
        this.held += est
        let done = false
        return (usage:Usage) => {
            if (done) return
            done = true
            this.held -= est
            this.spent += weightedTokens(usage)
        }
    }

    // True once any reservation was refused.
    exhausted ():boolean {
        return this.refused
    }

    // Tokens reserved by calls still in flight.
    outstanding ():number {
        return this.held
    }

    committed ():{ spent:number, limit:number } {
        return { spent:Math.trunc(this.spent), limit:Math.trunc(this.limit) }
    }
}

// No ledger (unlimited) when `limit <= 0`.
export function newLedger (limit:number):Ledger|null {
    return limit > 0 ? new Ledger(limit) : null
}

const NO_OP:Release = () => {}

// Admission through an optional ledger: without one every reservation is
// admitted and release is a no-op.
export function reserve (
    ledger:Ledger|null,
    reqBytes:number,
    maxOutput:number,
    final:boolean
):Release|null {
    return ledger ? ledger.reserve(reqBytes, maxOutput, final) : NO_OP
}

// `committed()` of an optional ledger.
export function committed (
    ledger:Ledger|null
):{ spent:number, limit:number } {
    return ledger ? ledger.committed() : { spent:0, limit:0 }
}
