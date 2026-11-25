// pattern: Functional Core
import { goTrimSpace } from '../gocompat/strings.js'

export const SEVERITIES = [
    'INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL',
] as const

export type Severity = typeof SEVERITIES[number]

export function severityRank (severity:string):number {
    const rank = SEVERITIES.findIndex(s => s === severity)
    return Math.max(0, rank)
}

export function parseSeverity (value:string):Severity|null {
    const canonical = goTrimSpace(value).toUpperCase()
    return SEVERITIES.find(s => s === canonical) ?? null
}

export type WireFinding = {
    reasoning:string;
    severity:string;
    confidence:number;
    cwe:string;
    description:string;
    file:string;
    lines:number[]|null;
    code_quote:string;
    fixed_code:string;
    frontend_category:string;
}

// Optional fields retain their Go zero values until verification.
export type Verdict = {
    reasoning?:string;
    status:string;
    confidence?:number;
    grounding?:string;
    recalibrated_severity?:string;
    verifier?:string;
    undecided?:boolean;
}

export type Finding = WireFinding&{
    verdict?:Verdict;
    _drop_reason?:string;
    id?:string;
    alias?:string;
}

export type FindingsResponse = {
    assessment:string;
    findings:WireFinding[];
}

export type Result = {
    findings:Finding[];
    dropped:Finding[];
    assessment:string;
    notes:string[];
    incomplete?:boolean;
    stopReason?:string;
}

export const ASSESSMENT = {
    FINDINGS_PRESENT:'FINDINGS_PRESENT',
    NO_FINDINGS:'NO_FINDINGS',
    NO_DIFF:'NO_DIFF',
    INCOMPLETE_NO_SUBMISSION:'INCOMPLETE_NO_SUBMISSION',
    NO_FINDINGS_IN_SAMPLED_AREAS:'NO_FINDINGS_IN_SAMPLED_AREAS',
} as const

export const DROP = {
    INVALID_SEVERITY:'invalid_severity',
    MISSING_CODE_QUOTE:'missing_code_quote',
    MISSING_FIXED_CODE:'missing_fixed_code',
    UNGROUNDED_CODE_QUOTE:'ungrounded_code_quote',
    BELOW_CONFIDENCE_FLOOR:'below_confidence_floor',
    REFUTED_BY_VERIFIER:'refuted_by_verifier',
} as const

export function toFinding (w:WireFinding):Finding {
    return {
        reasoning:w.reasoning,
        severity:w.severity,
        confidence:w.confidence,
        cwe:w.cwe,
        description:w.description,
        file:w.file,
        lines:w.lines?.length ? [...w.lines] : null,
        code_quote:w.code_quote,
        fixed_code:w.fixed_code,
        frontend_category:w.frontend_category === 'none' ?
            '' : w.frontend_category,
    }
}

export function effectiveSeverity (f:Finding):string {
    if (f.verdict?.status !== 'confirmed') return f.severity
    const recalibrated = parseSeverity(f.verdict.recalibrated_severity ?? '')
    return recalibrated !== null &&
        severityRank(recalibrated) < severityRank(f.severity) ?
        recalibrated : f.severity
}

export function maxSeverity (result:Pick<Result, 'findings'>):number {
    return result.findings.reduce((max, f) =>
        Math.max(max, severityRank(effectiveSeverity(f))), -1)
}
