// pattern: Functional Core
import type { Report } from '../render/render.js'
import { toJSON } from '../render/render.js'
import { DROP } from '../review/types.js'
import { goStringify, rfc3339Local, sortedMap } from './json.js'
import { orderedMap, FIELDS } from './meta-json.js'

export type PriorSighting = { runTS:string; dropReason:string }

export function priorLine (
    line:string,
    repo:string,
    targets:ReadonlySet<string>,
    out:Map<string, PriorSighting>
):void {
    try {
        const raw:unknown = JSON.parse(line)
        if (raw === null || typeof raw !== 'object') return
        const r = raw as Record<string, unknown>
        if (r.repo !== repo || (r.ts != null && typeof r.ts !== 'string')) {
            return
        }
        const findings = [r.findings, r.dropped_findings]
            .flatMap(value => {
                if (value == null) return []
                if (!Array.isArray(value)) throw new Error('invalid findings')
                return value as unknown[]
            }).map(value => {
                if (value === null) return {}
                if (typeof value !== 'object') throw new Error('invalid item')
                const f = value as Record<string, unknown>
                for (const key of ['fingerprint', '_drop_reason']) {
                    if (f[key] != null && typeof f[key] !== 'string') {
                        throw new Error('invalid finding field')
                    }
                }
                return f
            })
        for (const f of findings) {
            const fp = f.fingerprint as string|undefined
            if (fp && targets.has(fp) && !out.has(fp)) {
                out.set(fp, {
                    runTS:(r.ts as string|null) ?? '',
                    dropReason:(f._drop_reason as string|null) ?? '',
                })
            }
        }
    } catch { /* Malformed index lines do not hide later valid lines. */ }
}

export function runLine (
    report:Report,
    repo:string,
    argv:readonly string[]|null,
    now:Date
):string {
    // Reuse the render area's ordered finding/usage representation,
    // without the transient annotation of prior sightings.
    const rendered = JSON.parse(toJSON({ ...report, prior:null }))
    return goStringify({
        ts:rfc3339Local(now),
        ...(report.runId ? { run_id:report.runId } : {}),
        repo,
        argv,
        mode:report.mode,
        quick:report.quick ?? false,
        verified:report.verified ?? false,
        assessment:report.result.assessment,
        n_findings:report.result.findings.length,
        n_dropped:report.result.dropped.length,
        n_refuted:report.result.dropped.filter(f =>
            f._drop_reason === DROP.REFUTED_BY_VERIFIER).length,
        files_reviewed:report.filesReviewed ?? null,
        findings:rendered.findings,
        dropped_findings:rendered.dropped_findings,
        usage:report.usage ? orderedMap(report.usage, FIELDS.usage) : null,
        prompt_packs:report.promptPacks ?? null,
        ...(report.budgets != null ?
            { budgets:sortedMap(report.budgets) } : {}),
    }) + '\n'
}
