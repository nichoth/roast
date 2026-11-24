// Roast's agent loop (spec 07): a multi-turn tool conversation that ends
// when the model calls the final tool with arguments that validate. An
// imperative shell around the pure review (review.ts), the ledger, and
// the work deadline. Governing invariant: no stop path discards
// accumulated work; the budget and the deadline never cancel the wrap-up
// call, and record tools always run.

import type { ModelClient } from './client.js'
import { WorkDeadline } from './deadline.js'
import {
    CaptureError,
    cutoffError,
    FinalArgumentsError,
    hasSentinel,
    NoFinalCallError,
    normalizeProviderError,
    SENTINEL_MESSAGE,
    type ErrorDetails,
} from './errors.js'
import { checkRequired, decodeArgs, typeValidate } from './final-args.js'
import { encodeToolResult } from './json.js'
import { reserve, type Ledger } from './ledger.js'
import { transcriptBytes } from './messages.js'
import { withStepRetry, type Sleep } from './retry.js'
import {
    reviewResponse,
    type ReviewCall,
    type ReviewDecision,
    type StopCause,
} from './review.js'
import { newSessionId } from './session.js'
import type {
    AssistantPart,
    ConversationItem,
    ConverseOptions,
    FinishReason,
    ModelRequest,
    ModelTurn,
    Tool,
    ToolDefinition,
    ToolResult,
    Usage,
} from './types.js'
import { zeroUsage } from './usage.js'

export { DEFAULT_WRAP_UP_WINDOW } from './deadline.js'

export const NUDGE_TOOL_NAME = '__roast_continue'
export const DEFAULT_MAX_TURNS = 8
export const DEFAULT_INPUT_BYTE_CEILING = 3_000_000
export const DEFAULT_MAX_ATTEMPTS = 4
// Added to the request body size for ledger admission.
export const REQUEST_OVERHEAD_BYTES = 2048

const NUDGE_TOOL:ToolDefinition = {
    name:NUDGE_TOOL_NAME,
    description:'Continue the Roast tool loop after a free-form response.',
    schema:{
        type:'object',
        properties:{ message:{ type:'string' } },
        required:['message'],
    },
}

export interface LoopDeps {
    client:ModelClient;
    // Request model name, used in error messages.
    model:string;
    maxOutputTokens:number;
    // Already normalized (<= 0 -> DEFAULT_MAX_ATTEMPTS).
    maxAttempts:number;
    ledger:Ledger|null;
    // The client's usage accumulator.
    addUsage:(usage:Usage) => void;
    now?:() => number;
    sleep?:Sleep;
    sessionId?:() => string;
}

type Cutoff = 'work-deadline'|'budget-exhausted'

interface StepOutcome {
    dispatched:boolean;
    stopRequested:boolean;
}

class Conversation<T> {
    private readonly items:ConversationItem[]
    private readonly tools:ReadonlyMap<string, Tool>
    private readonly toolNames:ReadonlySet<string>
    private readonly recordTools:ReadonlySet<string>
    private readonly definitions:readonly ToolDefinition[]
    private readonly deadline:WorkDeadline
    private readonly sessionId:string
    private readonly maxTurns:number
    private readonly ceiling:number

    private turn = 0
    private finalPhase:boolean
    private cutoff:Cutoff|null = null
    private noticeSent = false
    private inputWarned = false
    private budgetNotified = false
    private done = false
    private result?:T
    private finalErr:string|null = null
    private validationExhausted = false
    private halt = false
    private stopCause:StopCause|null = null
    private finish?:{ reason:FinishReason, raw?:string }
    private submissionAttempts = 0
    private recordRounds = 0

    constructor (
        private readonly deps:LoopDeps,
        private readonly system:string,
        user:string,
        private readonly opts:ConverseOptions<T>,
        private readonly structured:boolean,
        private readonly signal:AbortSignal
    ) {
        this.items = [{ role:'user', text:user }]
        const tools = new Map<string, Tool>()
        const records = new Set<string>()
        for (const tool of opts.tools) {
            tools.set(tool.name, tool)
            if (tool.recordsResult && tool.name !== opts.finalTool) {
                records.add(tool.name)
            }
        }
        this.tools = tools
        this.recordTools = records
        this.toolNames = new Set([...tools.keys(), NUDGE_TOOL_NAME])
        this.definitions = [
            ...opts.tools.map(t => ({
                name:t.name,
                description:t.description,
                schema:t.schema,
            })),
            NUDGE_TOOL,
        ]
        this.deadline = new WorkDeadline({
            deadline:opts.workDeadline,
            window:opts.wrapUpWindow,
            onFire:opts.onWorkDeadline,
            now:deps.now,
        })
        this.sessionId = (deps.sessionId ?? newSessionId)()
        this.maxTurns = opts.maxTurns !== undefined && opts.maxTurns > 0 ?
            opts.maxTurns :
            DEFAULT_MAX_TURNS
        this.ceiling = opts.inputByteCeiling !== undefined &&
            opts.inputByteCeiling > 0 ?
            opts.inputByteCeiling :
            DEFAULT_INPUT_BYTE_CEILING
        this.finalPhase = structured
    }

    async run ():Promise<T> {
        let failure:unknown
        let failed = false
        for (;;) {
            this.prepare()
            let outcome:StepOutcome
            try {
                const turn = await withStepRetry(() => this.call(), {
                    maxRetries:this.deps.maxAttempts - 1,
                    signal:this.signal,
                    sleep:this.deps.sleep,
                })
                outcome = await this.process(turn)
            } catch (err) {
                failure = err
                failed = true
                break
            }
            if (this.shouldStop()) break
            if (!outcome.dispatched || outcome.stopRequested) break
            if (this.signal.aborted) {
                failure = this.signal.reason
                failed = true
                break
            }
        }
        return this.conclude(failed, failure)
    }

    // Turn preparation (2.5).
    private prepare ():void {
        this.turn++
        if (this.turn > 1 && !this.inputWarned &&
            transcriptBytes(this.system, this.items) > this.ceiling) {
            this.inputWarned = true
            this.items.push({
                role:'user',
                text:'INPUT BUDGET EXHAUSTED. Do not request more files. ' +
                    `Call \`${this.opts.finalTool}\` now with what you ` +
                    'have \u2014 partial results beat none.',
            })
        }
        if (this.deadline.check()) this.forceFinal('work-deadline')
        if (this.turn >= this.maxTurns) this.forceFinal(null)
        this.sendNotice()
    }

    private forceFinal (cutoff:Cutoff|null):void {
        this.finalPhase = true
        if (cutoff && !this.cutoff) this.cutoff = cutoff
    }

    private notifyBudget ():void {
        if (this.budgetNotified) return
        this.budgetNotified = true
        this.opts.onBudgetExhausted?.()
    }

    private notice ():string {
        const f = '`' + this.opts.finalTool + '`'
        if (this.structured) {
            return `Return the requested structured result via the ${f} ` +
                'tool call. Do not answer in prose.'
        }
        const tail = ` \u2014 call ${f} NOW with everything you have; ` +
            'partial results beat none.'
        if (this.cutoff === 'budget-exhausted') {
            return 'TOKEN BUDGET EXHAUSTED' + tail
        }
        if (this.cutoff === 'work-deadline' && this.deadline.fired) {
            return 'WORK DEADLINE REACHED' + tail
        }
        return 'Exploration budget exhausted' + tail
    }

    private sendNotice ():void {
        if (!this.finalPhase || this.noticeSent) return
        this.noticeSent = true
        this.items.push({ role:'user', text:this.notice() })
    }

    private request (signal:AbortSignal):ModelRequest {
        return {
            system:this.system,
            items:[...this.items],
            tools:this.definitions.map(d => ({
                name:d.name,
                description:d.description,
                schema:structuredClone(d.schema),
            })),
            sessionId:this.sessionId,
            signal,
        }
    }

    // One model call, with the in-step switch to wrap-up on a budget
    // refusal or an in-flight deadline (2.9).
    private async call ():Promise<ModelTurn> {
        const final = this.finalPhase
        const signal = this.deadline.callSignal(this.signal)
        const request = this.request(signal)
        const bytes = this.deps.client.requestBytes(request) +
            REQUEST_OVERHEAD_BYTES
        const release = reserve(this.deps.ledger, bytes,
            this.deps.maxOutputTokens, final)
        if (!release) {
            if (final) {
                if (!this.cutoff) {
                    this.cutoff = 'budget-exhausted'
                    this.notifyBudget()
                }
                throw cutoffError(this.cutoff, 'no headroom for the wrap-up ' +
                    'call', new Error(SENTINEL_MESSAGE['budget-exhausted']),
                this.details())
            }
            this.forceFinal('budget-exhausted')
            this.notifyBudget()
            this.sendNotice()
            return this.call()
        }
        let turn:ModelTurn
        try {
            turn = await this.deps.client.send(request)
            // A response buffered before an abort is never dispatched.
            signal.throwIfAborted()
        } catch (err) {
            release(zeroUsage())
            const deadlineReached = this.deadline.check()
            if (err instanceof CaptureError) throw err
            if (!final && deadlineReached && !this.signal.aborted) {
                this.forceFinal('work-deadline')
                this.sendNotice()
                return this.call()
            }
            if (final && this.cutoff) {
                throw cutoffError(this.cutoff, 'wrap-up call failed',
                    normalizeProviderError(this.signal, this.deps.model, err),
                    this.details())
            }
            throw err
        }
        release(turn.usage)
        this.deps.addUsage(turn.usage)
        this.deadline.check()
        return turn
    }

    // Processing one complete response (2.6) and its dispatch (2.7).
    private async process (turn:ModelTurn):Promise<StepOutcome> {
        if (turn.finishReason !== 'stop' &&
            turn.finishReason !== 'tool-calls') {
            this.abnormalFinish(turn)
            return { dispatched:false, stopRequested:false }
        }
        const calls:ReviewCall[] = []
        for (const p of turn.parts) {
            if (p.type === 'tool-call') {
                calls.push({ id:p.id, name:p.name, input:p.input })
            }
        }
        this.stopCause = null
        const d = reviewResponse({
            calls,
            finalTool:this.opts.finalTool,
            toolNames:this.toolNames,
            recordTools:this.recordTools,
            finalPhase:this.finalPhase,
            turn:this.turn,
            submissionAttempts:this.submissionAttempts,
            recordRounds:this.recordRounds,
            maxAttempts:this.deps.maxAttempts,
            mayContinue:() => this.mayContinueFinalization(),
            validateFinal:input => {
                const v = typeValidate(input, this.opts.final)
                return v.ok ? null : v.error
            },
        })
        for (const call of d.unknownCalls) {
            this.opts.onTurn?.({
                turn:this.turn,
                tool:call.name,
                args:decodeArgs(call.input),
            })
        }
        this.submissionAttempts = d.submissionAttempts
        this.recordRounds = d.recordRounds
        this.stopCause = d.stopCause
        if (d.finalErr !== undefined) this.finalErr = d.finalErr
        if (d.validationExhausted) this.validationExhausted = true
        if (d.halt) this.halt = true
        if (!d.dispatch) return { dispatched:false, stopRequested:false }

        const parts:AssistantPart[] = [...turn.parts]
        const all = [...calls]
        if (d.nudge) {
            const nudge:ReviewCall = {
                id:d.nudge.id,
                name:NUDGE_TOOL_NAME,
                input:JSON.stringify({ message:d.nudge.message }),
            }
            parts.push({ type:'tool-call', ...nudge })
            all.push(nudge)
        }
        this.items.push({ role:'assistant', parts })
        const results:ToolResult[] = []
        let stopRequested = false
        for (const call of all) {
            const r = await this.dispatch(call, d)
            results.push(r.result)
            if (r.stop) stopRequested = true
        }
        this.items.push({ role:'tool', results })
        return { dispatched:all.length > 0, stopRequested }
    }

    private abnormalFinish (turn:ModelTurn):void {
        const reason = turn.finishReason
        let text = `the response ended with finish reason "${reason}"`
        if (turn.rawFinishReason && turn.rawFinishReason !== reason) {
            text += ` (the provider sent "${turn.rawFinishReason}")`
        }
        if (reason === 'length') {
            text += '; raise max_output_tokens if the output was cut off'
        }
        this.stopCause = { kind:'finish-reason', text }
        this.finish = { reason, raw:turn.rawFinishReason }
    }

    private mayContinueFinalization ():boolean {
        if (this.deadline.check()) this.forceFinal('work-deadline')
        return this.cutoff === null
    }

    // One call: required-field validation, then the tool's own handling.
    private async dispatch (
        call:ReviewCall,
        d:ReviewDecision
    ):Promise<{ result:ToolResult, stop?:boolean }> {
        const ok = (output:string):ToolResult => ({
            callId:call.id,
            name:call.name,
            output,
            isError:false,
        })
        const fail = (output:string):ToolResult => ({
            callId:call.id,
            name:call.name,
            output,
            isError:true,
        })
        const tool = this.tools.get(call.name)
        if (!tool && call.name !== NUDGE_TOOL_NAME) {
            return {
                result:fail(`tool not found: ${call.name}. Available ` +
                    `tools: ${this.definitions.map(t => t.name).join(', ')}`),
            }
        }
        const schema = tool?.schema ?? NUDGE_TOOL.schema
        let invalid = checkRequired(schema, call.input)
        if (invalid !== null && tool?.recordsResult) {
            // Record tools receive decodeArgs' error map on malformed
            // JSON, so the finder can retain an all-zero finding. Valid
            // JSON still goes through required-field validation.
            try { JSON.parse(call.input) } catch { invalid = null }
        }
        if (invalid !== null) return { result:fail(invalid) }

        if (!tool) {
            const message = decodeArgs(call.input).message
            return { result:ok(typeof message === 'string' ? message : '') }
        }
        if (call.name === this.opts.finalTool) {
            return this.dispatchFinal(call, d, ok, fail)
        }
        const record = this.recordTools.has(call.name)
        if (d.blockExploration && !record) {
            return { result:fail(d.blockExploration) }
        }
        const args = decodeArgs(call.input)
        const outcome = await this.deadline.runTool(tool, args, this.signal)
        const value = 'error' in outcome ?
            { error:outcome.error.message } :
            outcome.value
        this.opts.onTurn?.({ turn:this.turn, tool:tool.name, args })
        let text:string
        try {
            text = encodeToolResult(value ?? null) ?? 'null'
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            text = encodeToolResult({ error:message })
        }
        return { result:ok(text) }
    }

    private dispatchFinal (
        call:ReviewCall,
        d:ReviewDecision,
        ok:(output:string) => ToolResult,
        fail:(output:string) => ToolResult
    ):{ result:ToolResult, stop?:boolean } {
        if (this.finalErr !== null) {
            return { result:fail(this.finalErr), stop:true }
        }
        if (d.rejectFinal) return { result:fail(d.rejectFinal) }
        if (this.done) return { result:ok('Already submitted.'), stop:true }
        const accepted = d.accept
        if (!accepted || accepted.id !== call.id ||
            accepted.input !== call.input) {
            return {
                result:fail('Not accepted: call `' + this.opts.finalTool +
                    '` once per response.'),
            }
        }
        const v = typeValidate(call.input, this.opts.final)
        if (!v.ok) {
            this.finalErr = v.error
            return { result:fail(v.error), stop:true }
        }
        this.result = v.value
        this.done = true
        return { result:ok(call.input), stop:true }
    }

    // Stop conditions (2.10).
    private shouldStop ():boolean {
        if (this.done || this.validationExhausted || this.halt) return true
        if (this.finalPhase &&
            this.submissionAttempts >= this.deps.maxAttempts) {
            return true
        }
        if (this.finalPhase && this.deadline.check()) {
            this.forceFinal('work-deadline')
            if (!this.stopCause) {
                this.stopCause = {
                    kind:'deadline-during-finalization',
                    text:'the work deadline passed before `' +
                        this.opts.finalTool + '` was called',
                }
            }
            return true
        }
        return false
    }

    private details ():ErrorDetails {
        const d:ErrorDetails = {
            model:this.deps.model,
            submissionAttempts:this.submissionAttempts,
            recordRounds:this.recordRounds,
        }
        if (this.stopCause) d.stopCause = this.stopCause.kind
        if (this.finish) {
            d.finishReason = this.finish.reason
            if (this.finish.raw !== undefined) {
                d.rawFinishReason = this.finish.raw
            }
        }
        return d
    }

    // Result precedence (2.14).
    private conclude (failed:boolean, failure:unknown):T {
        if (this.done) return this.result as T
        const model = this.deps.model
        const final = this.opts.finalTool
        if (this.finalErr !== null) {
            const err = new FinalArgumentsError(
                `${model}: ${final} arguments did not satisfy the schema ` +
                    `(${this.finalErr}); if truncated, raise max_output_tokens`,
                { ...this.details(), stopCause:'invalid-arguments' })
            if (this.cutoff) {
                throw cutoffError(this.cutoff, 'wrap-up submission was ' +
                    'invalid', err)
            }
            throw err
        }
        if (failed) {
            if (hasSentinel(failure, 'no-final-call')) throw failure
            if (this.cutoff) {
                throw cutoffError(this.cutoff, 'wrap-up turn failed', failure,
                    this.details())
            }
            throw normalizeProviderError(this.signal, model, failure)
        }
        const cause = this.stopCause ?
            new Error(`${model}: ${this.stopCause.text}`) :
            undefined
        if (this.cutoff) {
            throw cutoffError(this.cutoff, 'wrap-up turn produced no ' +
                'submission', cause, this.details())
        }
        const head = SENTINEL_MESSAGE['no-final-call']
        throw new NoFinalCallError(
            cause ? `${head}: ${cause.message}` : head,
            { details:this.details() })
    }
}

// Runs one conversation (`converse`, or `completeStructured` when
// `structured`) to its accepted final call.
export async function runConversation<T> (
    deps:LoopDeps,
    system:string,
    user:string,
    opts:ConverseOptions<T>,
    structured:boolean,
    signal:AbortSignal
):Promise<T> {
    if (!opts.tools.some(t => t.name === opts.finalTool)) {
        throw new Error(`final tool "${opts.finalTool}" is not configured`)
    }
    return new Conversation(deps, system, user, opts, structured, signal)
        .run()
}
