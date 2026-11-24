// pattern: Imperative Shell
// Validation orchestrates the supplied grounder and assigns random ids.
import { randomUUID } from 'node:crypto'
import { goTrimSpace } from '../gocompat/strings.js'
import {
    ASSESSMENT, DROP, parseSeverity, toFinding,
    type FindingsResponse, type Result,
} from './types.js'

export type Ground = (file:string, quote:string) => boolean

export function validate (
    resp:FindingsResponse,
    confidenceFloor:number,
    ground?:Ground
):Result {
    const result:Result = {
        findings:[], dropped:[], assessment:resp.assessment, notes:[],
    }
    for (const w of resp.findings) {
        const f = toFinding(w)
        const severity = parseSeverity(f.severity)
        if (severity !== null) f.severity = severity
        const reason = severity === null ? DROP.INVALID_SEVERITY :
            goTrimSpace(f.code_quote) === '' ? DROP.MISSING_CODE_QUOTE :
                goTrimSpace(f.fixed_code) === '' ? DROP.MISSING_FIXED_CODE :
                    ground && !ground(f.file, f.code_quote) ?
                        DROP.UNGROUNDED_CODE_QUOTE :
                        f.confidence < confidenceFloor ?
                            DROP.BELOW_CONFIDENCE_FLOOR : null
        if (reason !== null) {
            f._drop_reason = reason
            result.dropped.push(f)
        } else result.findings.push(f)
    }
    if (result.findings.length > 0) {
        result.assessment = ASSESSMENT.FINDINGS_PRESENT
    } else if (result.assessment === ASSESSMENT.FINDINGS_PRESENT) {
        result.assessment = ASSESSMENT.NO_FINDINGS
    }
    assignIdentity(result)
    return result
}

export function assignIdentity (
    result:Result,
    newId:() => string = randomUUID
):void {
    const all = [...result.findings, ...result.dropped]
    const counts = new Map<string, number>()
    const ids = all.map(f => {
        if (!f.id) f.id = newId()
        const hex = f.id.replaceAll('-', '')
        for (let n = 6; n <= hex.length; n++) {
            const prefix = hex.slice(0, n)
            counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
        }
        return hex
    })
    all.forEach((f, i) => {
        const hex = ids[i]
        let n = 6
        while (n < hex.length && counts.get(hex.slice(0, n))! > 1) n++
        f.alias = 'R-' + hex.slice(0, n)
    })
}
