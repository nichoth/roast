// The work deadline (spec 07, 2.8): a latched clock check, never a
// timeout around the whole conversation, plus the signals that bound one
// model call or one tool wait.

import { abortable } from './capture.js'
import { SENTINEL_MESSAGE, WorkDeadlineError } from './errors.js'
import type { Tool } from './types.js'

export const DEFAULT_WRAP_UP_WINDOW = 90_000

export interface WorkDeadlineOptions {
    // Absolute time, ms since the epoch; none when undefined.
    deadline?:number;
    // ms; <= 0 means DEFAULT_WRAP_UP_WINDOW.
    window?:number;
    onFire?:() => void;
    now?:() => number;
}

export type ToolOutcome = { value:unknown }|{ error:Error }

function asError (err:unknown):Error {
    return err instanceof Error ? err : new Error(String(err))
}

export class WorkDeadline {
    private readonly deadline?:number
    private readonly window:number
    private readonly onFire?:() => void
    private readonly now:() => number
    private latched = false

    constructor (opts:WorkDeadlineOptions = {}) {
        this.deadline = opts.deadline
        this.window = opts.window !== undefined && opts.window > 0 ?
            opts.window :
            DEFAULT_WRAP_UP_WINDOW
        this.onFire = opts.onFire
        this.now = opts.now ?? Date.now
    }

    get fired ():boolean {
        return this.latched
    }

    // True once the deadline passed; the first true latches and calls
    // `onFire` exactly once.
    check ():boolean {
        if (this.latched) return true
        if (this.deadline === undefined || this.now() < this.deadline) {
            return false
        }
        this.latched = true
        this.onFire?.()
        return true
    }

    // The signal for a model call: the caller's, bounded by the deadline
    // before the latch and by a fresh wrap-up window after it.
    callSignal (caller:AbortSignal):AbortSignal {
        if (this.latched) {
            return AbortSignal.any([caller, AbortSignal.timeout(this.window)])
        }
        if (this.deadline === undefined) return caller
        // One extra ms so the timer never fires before the clock check
        // would report the deadline.
        const ms = Math.max(0, this.deadline - this.now()) + 1
        return AbortSignal.any([caller, AbortSignal.timeout(ms)])
    }

    // Runs one exploration or record call, bounding the wait rather than
    // the tool: on abort the promise is abandoned and the abort reason is
    // the error. A record tool always gets a fresh wrap-up window; an
    // exploration tool is not started once the deadline has passed.
    async runTool (
        tool:Tool,
        args:Record<string, unknown>,
        caller:AbortSignal
    ):Promise<ToolOutcome> {
        let signal:AbortSignal
        if (tool.recordsResult) {
            signal = AbortSignal.any([
                caller,
                AbortSignal.timeout(this.window),
            ])
        } else {
            if (this.check()) {
                return {
                    error:new WorkDeadlineError(
                        SENTINEL_MESSAGE['work-deadline']),
                }
            }
            signal = this.callSignal(caller)
        }
        const run = tool.run
        if (!run) return { error:new Error('tool has no implementation') }
        const pending = Promise.resolve().then(() => run(args, signal))
        pending.catch(() => {})
        try {
            const value = await abortable(pending, signal)
            this.check()
            return { value }
        } catch (err) {
            this.check()
            return { error:asError(err) }
        }
    }
}
