// pattern: Imperative Shell
// The verifier stage (spec 09, 2.3-2.4): every finding the finder kept is
// adjudicated by the verifier role through the agent loop. Anything the
// verifier cannot decide fails open: the finding keeps gating with the
// reason on its verdict. `verify` never throws.
import type { Client, Tool } from '../llm/types.js'
import type { Ledger } from '../llm/ledger.js'
import { wellFormed } from '../llm/json.js'
import {
    ASSESSMENT, DROP, type Finding, type Result, type Verdict,
} from '../review/types.js'
import {
    formatFixed2, goTrimSpace, truncateUtf8,
} from '../gocompat/strings.js'
import { line } from '../textsafe/textsafe.js'
import { mapPool } from '../util/pool.js'

export interface VerifyDeps {
    systemPrompt:string;
    // The per-finding user message; it may read the cited file.
    userPrompt?:(f:Finding) => string|Promise<string>;
    tools:readonly Tool[];
    // 0 means the agent loop's default.
    maxTurns:number;
    // <= 0 means 4.
    concurrency?:number;
    log?:(line:string) => void;
    // 0 means no cap.
    maxVerified:number;
    // Absent is never exhausted.
    ledger?:Ledger|null;
}

// Go parity: an empty notes list becomes null after verification.
export type VerifiedResult = Omit<Result, 'notes'>&{ notes:string[]|null }

export const SUBMIT_VERDICT_TOOL_NAME = 'submit_verdict'

const DEFAULT_CONCURRENCY = 4

function freeze<T extends object> (value:T):T {
    for (const v of Object.values(value)) {
        if (v !== null && typeof v === 'object') freeze(v)
    }
    return Object.freeze(value)
}

// Property keys are alphabetical, as Go transmits them.
export const VERDICT_SCHEMA:Record<string, unknown> = freeze({
    additionalProperties:false,
    properties:{
        confidence:{ maximum:1, minimum:0, type:'number' },
        grounding:{
            description:'The exact lines / contradicting code / ' +
                'language-semantics fact the verdict rests on',
            type:'string',
        },
        reasoning:{ type:'string' },
        recalibrated_severity:{
            description:'If the finding is real but its severity is ' +
                'overstated, the corrected LOWER severity, justified in ' +
                'grounding. Omit to keep the finder\'s severity. ' +
                'Never raise severity.',
            enum:['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
            type:'string',
        },
        status:{
            enum:['confirmed', 'refuted', 'insufficient_context'],
            type:'string',
        },
    },
    required:['reasoning', 'status', 'confidence', 'grounding'],
    type:'object',
})

// The model-facing verdict: `verifier` and `undecided` are set by Roast
// only, so the model cannot fabricate them.
type WireVerdict = {
    reasoning:string;
    status:string;
    confidence:number;
    grounding:string;
    recalibrated_severity:string;
}

function field (v:Record<string, unknown>, key:string):unknown {
    return Object.hasOwn(v, key) ? v[key] : null
}

function str (v:Record<string, unknown>, key:string):string {
    const value = field(v, key)
    if (value === null || value === undefined) return ''
    if (typeof value !== 'string') {
        throw new Error(`expected a string in ${key}`)
    }
    return wellFormed(value)
}

function num (v:Record<string, unknown>, key:string):number {
    let value = field(v, key)
    if (value === null || value === undefined) return 0
    if (typeof value === 'bigint') value = Number(value)
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`expected a number in ${key}`)
    }
    return value
}

function decodeVerdict (value:unknown):WireVerdict {
    if (value === null) value = {}
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected an object')
    }
    const v = value as Record<string, unknown>
    return {
        reasoning:str(v, 'reasoning'),
        status:str(v, 'status'),
        confidence:num(v, 'confidence'),
        grounding:str(v, 'grounding'),
        recalibrated_severity:str(v, 'recalibrated_severity'),
    }
}

function unverified (reason:string):Verdict {
    return {
        reasoning:reason,
        status:'insufficient_context',
        confidence:0,
        grounding:'',
        undecided:true,
    }
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

async function verifyOne (
    signal:AbortSignal,
    verifier:Client,
    finding:Finding,
    deps:VerifyDeps
):Promise<Verdict> {
    try {
        const user = deps.userPrompt ? await deps.userPrompt(finding) : ''
        const wv = await verifier.converse(deps.systemPrompt, user, {
            tools:[...deps.tools, {
                name:SUBMIT_VERDICT_TOOL_NAME,
                description:'Submit your verdict on the finding. ' +
                    'Call exactly once.',
                schema:VERDICT_SCHEMA,
            }],
            finalTool:SUBMIT_VERDICT_TOOL_NAME,
            final:{ decode:decodeVerdict },
            maxTurns:deps.maxTurns,
        }, signal)
        const v:Verdict = {
            reasoning:wv.reasoning,
            status:wv.status,
            confidence:wv.confidence,
            grounding:wv.grounding,
        }
        if (wv.recalibrated_severity !== '') {
            v.recalibrated_severity = wv.recalibrated_severity
        }
        return v
    } catch (err) {
        return {
            reasoning:`verifier did not reach a verdict: ${message(err)}`,
            status:'insufficient_context',
            confidence:0,
            grounding:'',
            undecided:true,
        }
    }
}

export async function verify (
    signal:AbortSignal,
    verifier:Client,
    result:Result,
    deps:VerifyDeps
):Promise<VerifiedResult> {
    const concurrency = (deps.concurrency ?? 0) > 0 ?
        deps.concurrency! :
        DEFAULT_CONCURRENCY
    const log = deps.log ?? (() => {})
    const verdicts = await mapPool(result.findings, concurrency,
        async (finding, i) => {
            let v:Verdict
            if (deps.maxVerified > 0 && i >= deps.maxVerified) {
                v = unverified('unverified: over the per-run verifier cap ' +
                    `(${deps.maxVerified})`)
            } else if (deps.ledger?.exhausted()) {
                v = unverified('unverified: run token budget exhausted ' +
                    'before this finding\'s verification')
            } else {
                v = await verifyOne(signal, verifier, finding, deps)
            }
            v.verifier = verifier.name
            return v
        })

    const out:VerifiedResult = {
        findings:[],
        dropped:[...result.dropped],
        assessment:result.assessment,
        notes:result.notes.length ? [...result.notes] : null,
    }
    if (result.incomplete !== undefined) out.incomplete = result.incomplete
    if (result.stopReason !== undefined) out.stopReason = result.stopReason
    result.findings.forEach((finding, i) => {
        const v = verdicts[i]
        if (v.status === 'refuted' && goTrimSpace(v.grounding ?? '') === '') {
            v.status = 'insufficient_context'
            v.undecided = true
            v.reasoning = 'verifier returned refuted without grounding ' +
                '\u2014 treating as insufficient_context (fail-open)'
        }
        if (v.status === 'confirmed' && v.recalibrated_severity &&
            goTrimSpace(v.grounding ?? '') === '') {
            v.recalibrated_severity = ''
        }
        const f:Finding = { ...finding, verdict:v }
        if (v.status === 'refuted') {
            f._drop_reason = DROP.REFUTED_BY_VERIFIER
            out.dropped.push(f)
            log(`roast: verifier refuted [${line(finding.severity)}] ` +
                `${line(truncateUtf8(finding.description, 80))} ` +
                `(conf ${formatFixed2(v.confidence ?? 0)})`)
        } else {
            out.findings.push(f)
        }
    })
    if (out.findings.length === 0 &&
        out.assessment === ASSESSMENT.FINDINGS_PRESENT) {
        out.assessment = ASSESSMENT.NO_FINDINGS
    }
    return out
}
