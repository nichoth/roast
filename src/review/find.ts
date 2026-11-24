// pattern: Imperative Shell
import type { Client, Tool } from '../llm/types.js'
import { encodeToolResult } from '../llm/json.js'
import { hasSentinel } from '../llm/errors.js'
import {
    FINDINGS_RESPONSE_SCHEMA, WIRE_FINDING_SCHEMA,
    decodeFindingsResponse, decodeWireFinding,
} from './schema.js'
import { fingerprint } from './fingerprint.js'
import { validate, type Ground } from './validate.js'
import {
    toFinding, type WireFinding, type Result, type FindingsResponse,
} from './types.js'
import { goTrimSpace } from '../gocompat/strings.js'

// A grounder may be asynchronous (the context area reads Git); its
// answers are gathered before the synchronous validation runs.
export type AsyncGround = (file:string, quote:string) =>
    boolean|Promise<boolean>

export type FindInput = {
    system:string;
    user:string;
    quick?:boolean;
    confidenceFloor:number;
    interactive?:boolean;
    tools?:readonly Tool[];
    maxTurns?:number;
    survey?:boolean;
    ground?:AsyncGround;
    capture?:(finding:WireFinding) => void;
    deadline?:number;
}

export class FindingAccumulator {
    private readonly sink?:FindInput['capture']
    private readonly byKey = new Map<string, WireFinding>()

    constructor (sink?:FindInput['capture']) {
        this.sink = sink
    }

    add (finding:WireFinding):void {
        this.byKey.set(fingerprint(toFinding(finding)), finding)
        this.sink?.(finding)
    }

    ordered ():WireFinding[] {
        return [...this.byKey.values()]
    }

    get count ():number {
        return this.byKey.size
    }
}

export const REPORT_FINDING_DESCRIPTION =
    'Report ONE finding the moment you confirm it, instead of holding ' +
    'findings until the end \u2014 findings reported here are saved ' +
    'immediately and survive even if the run is cut off by a budget or ' +
    'deadline. Same grounding bar as submit_findings: verbatim code_quote, ' +
    'concrete fixed_code. Re-reporting a finding replaces the earlier ' +
    'version; submit_findings may repeat it safely (deduplicated).'

export function submitDescription (survey:boolean):string {
    return survey ?
        'Submit your findings. Call exactly once; this ends the review. ' +
        'Submit EVERY grounded defect you found rather than a curated ' +
        'best-of. Use confidence to express uncertainty and let the ' +
        'verifier adjudicate it. Every finding still needs a verbatim ' +
        'code_quote and concrete fixed_code.' :
        'Submit your final findings. Call exactly once when you have ' +
        'gathered enough context; this ends the review.'
}

function decodeFinal (value:unknown, text?:string) {
    const decoded = decodeFindingsResponse(value, text)
    if (!decoded.ok) throw new Error(decoded.error)
    return decoded.value
}

// Answers `ground` for every finding that reaches the grounding check
// and returns a synchronous lookup over those answers.
async function preground (
    findings:readonly WireFinding[],
    ground?:AsyncGround
):Promise<Ground|undefined> {
    if (!ground) return undefined
    const answers = new Map<string, boolean>()
    const key = (file:string, quote:string) => `${file}\u0000${quote}`
    for (const w of findings) {
        if (goTrimSpace(w.code_quote) === '' ||
            goTrimSpace(w.fixed_code) === '') continue
        const k = key(w.file, w.code_quote)
        if (!answers.has(k)) {
            answers.set(k, await ground(w.file, w.code_quote))
        }
    }
    return (file, quote) => answers.get(key(file, quote)) ?? false
}

async function validated (
    resp:FindingsResponse,
    input:FindInput
):Promise<Result> {
    const ground = await preground(resp.findings, input.ground)
    return validate(resp, input.confidenceFloor, ground)
}

export async function find (
    client:Client,
    input:FindInput,
    signal:AbortSignal
):Promise<Result> {
    if (!input.interactive) {
        const resp = await client.completeStructured(input.system, input.user,
            'findings', {
                schema:FINDINGS_RESPONSE_SCHEMA, decode:decodeFinal,
            }, signal)
        return validated(resp, input)
    }
    const acc = new FindingAccumulator(input.capture)
    const report:Tool = {
        name:'report_finding',
        description:REPORT_FINDING_DESCRIPTION,
        schema:WIRE_FINDING_SCHEMA,
        recordsResult:true,
        run (args) {
            try {
                const raw = encodeToolResult(args)
                const decoded = decodeWireFinding(JSON.parse(raw), raw)
                if (!decoded.ok) {
                    return { error:`malformed finding: ${decoded.error}` }
                }
                acc.add(decoded.value)
                return { recorded:true, reported_so_far:acc.count }
            } catch (err) {
                return {
                    error:err instanceof Error ?
                        err.message : String(err)
                }
            }
        },
    }
    let deadlineFired = false
    let budgetFired = false
    let resp
    try {
        resp = await client.converse(input.system, input.user, {
            tools:[...(input.tools ?? []), report, {
                name:'submit_findings',
                description:submitDescription(input.survey ?? false),
                schema:FINDINGS_RESPONSE_SCHEMA,
            }],
            finalTool:'submit_findings',
            final:{ decode:decodeFinal },
            maxTurns:input.maxTurns,
            workDeadline:input.deadline,
            onWorkDeadline:() => { deadlineFired = true },
            onBudgetExhausted:() => { budgetFired = true },
        }, signal)
    } catch (err) {
        if (!hasSentinel(err, 'no-final-call')) throw err
        const stopReason = hasSentinel(err, 'work-deadline') ? 'deadline' :
            hasSentinel(err, 'budget-exhausted') ? 'token_budget' :
                'budget_exhausted'
        const result = await validated({
            assessment:'INCOMPLETE_NO_SUBMISSION', findings:acc.ordered(),
        }, input)
        result.incomplete = true
        result.stopReason = stopReason
        const message = err instanceof Error ? err.message : String(err)
        result.notes.push('interactive review ended without submit_findings ' +
            '(even after the reserved wrap-up turn); stop reason: ' +
            `${stopReason}; cause: ${message}`)
        if (acc.count > 0) {
            result.notes.push(`${acc.count} incrementally-reported ` +
                'finding(s) retained from before the cutoff')
        }
        return result
    }
    for (const finding of resp.findings) acc.add(finding)
    const result = await validated({
        assessment:resp.assessment, findings:acc.ordered(),
    }, input)
    if (deadlineFired || budgetFired) {
        result.incomplete = true
        result.stopReason = deadlineFired ? 'deadline' : 'token_budget'
        result.notes.push((deadlineFired ? 'work deadline reached' :
            'run token budget exhausted') + '; the submission is the ' +
            'reserved wrap-up flush, not a converged review')
    }
    return result
}
