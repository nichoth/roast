// Review of one complete `stop` / `tool-calls` response (spec 07, 2.6):
// which calls run, which get a block or rejection result, which nudge is
// appended, and whether the conversation may continue. Pure apart from
// `mayContinue`, which may latch the work deadline.

import type { StopCauseKind } from './errors.js'

export interface ReviewCall {
    id:string;
    name:string;
    input:string;
}

export interface StopCause {
    kind:StopCauseKind;
    text:string;
}

export interface ReviewInput {
    calls:readonly ReviewCall[];
    finalTool:string;
    // Caller tools plus the nudge tool.
    toolNames:ReadonlySet<string>;
    recordTools:ReadonlySet<string>;
    finalPhase:boolean;
    turn:number;
    submissionAttempts:number;
    recordRounds:number;
    maxAttempts:number;
    // Finalization may make another call (no cutoff); may latch the
    // deadline and record its cutoff.
    mayContinue:() => boolean;
    // Type validation of the final arguments: the error text or null.
    validateFinal:(input:string) => string|null;
}

export interface ReviewDecision {
    // False: nothing is dispatched and the conversation ends.
    dispatch:boolean;
    nudge?:{ id:string, message:string };
    // Result text for exploration calls that must not run.
    blockExploration?:string;
    // Result text for every final call (a provisional rejection).
    rejectFinal?:string;
    // The final call that passed type validation.
    accept?:ReviewCall;
    // A terminal type-validation error; undefined = unchanged.
    finalErr?:string|null;
    validationExhausted:boolean;
    halt:boolean;
    stopCause:StopCause|null;
    submissionAttempts:number;
    recordRounds:number;
    unknownCalls:readonly ReviewCall[];
}

function tick (s:string):string {
    return '`' + s + '`'
}

export function reviewResponse (input:ReviewInput):ReviewDecision {
    const f = tick(input.finalTool)
    let final:ReviewCall|undefined
    let records = 0
    const unknownCalls:ReviewCall[] = []
    for (const call of input.calls) {
        if (call.name === input.finalTool) final = call
        else if (input.recordTools.has(call.name)) records++
        else if (!input.toolNames.has(call.name)) unknownCalls.push(call)
    }
    let submissionAttempts = input.submissionAttempts
    let recordRounds = input.recordRounds
    const decision = (d:Partial<ReviewDecision>):ReviewDecision => ({
        dispatch:true,
        validationExhausted:false,
        halt:false,
        stopCause:null,
        submissionAttempts,
        recordRounds,
        unknownCalls,
        ...d,
    })
    const canRetrySubmission = () =>
        input.mayContinue() && submissionAttempts < input.maxAttempts

    // A: a wrap-up response that only recorded results.
    if (input.finalPhase && !final && records > 0 &&
        records === input.calls.length) {
        recordRounds++
        if (!input.mayContinue()) {
            return decision({
                recordRounds,
                halt:true,
                stopCause:{
                    kind:'recorded-before-cutoff',
                    text:`the model recorded results but did not call ${f}` +
                        ' before the cutoff',
                },
            })
        }
        if (recordRounds > input.maxAttempts) {
            return decision({
                recordRounds,
                halt:true,
                stopCause:{
                    kind:'kept-recording',
                    text:'the model kept recording results without ' +
                        `calling ${f} (${recordRounds} recording rounds)`,
                },
            })
        }
        return decision({ recordRounds })
    }

    // B
    if (input.finalPhase) submissionAttempts++

    // C
    if (final) {
        const blockExploration = 'Not executed: this response also ' +
            `called ${f}, which ends the run.`
        const err = input.validateFinal(final.input)
        if (err !== null && input.finalPhase && canRetrySubmission()) {
            return decision({
                submissionAttempts,
                blockExploration,
                finalErr:null,
                rejectFinal:'your previous response was not valid JSON ' +
                    `matching the schema: ${err}. Call ${f} again with ` +
                    'valid arguments.',
                stopCause:{
                    kind:'schema-mismatch',
                    text:`the last ${f} call did not match the schema`,
                },
            })
        }
        if (err !== null) {
            return decision({
                submissionAttempts,
                blockExploration,
                finalErr:err,
                validationExhausted:true,
                accept:final,
                stopCause:{
                    kind:'tool-call-validation',
                    text:`the last ${f} call did not pass tool-call ` +
                        'validation',
                },
            })
        }
        return decision({
            submissionAttempts,
            blockExploration,
            finalErr:null,
            accept:final,
            stopCause:{
                kind:'tool-call-validation',
                text:`the last ${f} call did not pass tool-call validation`,
            },
        })
    }

    // D
    if (input.finalPhase) {
        const blockExploration = 'Not executed: exploration is finished.'
        if (canRetrySubmission()) {
            return decision({
                submissionAttempts,
                blockExploration,
                nudge:{
                    id:`roast-final-${submissionAttempts}`,
                    message:'Exploration is finished. Return the result ' +
                        `via the ${f} tool call, not prose or another tool.`,
                },
            })
        }
        const some = input.calls.length > 0
        const noun = submissionAttempts === 1 ? 'attempt' : 'attempts'
        const stopCause:StopCause = some ?
            {
                kind:'other-tools-instead',
                text:`the model called other tools instead of ${f}`,
            } :
            {
                kind:'answered-without-final',
                text:`the model answered without calling ${f}`,
            }
        stopCause.text += ` (${submissionAttempts} submission ${noun})`
        if (records > 0) {
            return decision({
                submissionAttempts,
                blockExploration,
                halt:true,
                stopCause,
            })
        }
        return decision({ submissionAttempts, dispatch:false, stopCause })
    }

    // E
    if (input.calls.length > 0) return decision({})

    // F
    return decision({
        nudge:{
            id:`roast-nudge-${input.turn}`,
            message:`Results must be delivered via the ${f} tool call. ` +
                'If you have enough context call it now; otherwise call an ' +
                'exploration tool.',
        },
    })
}
