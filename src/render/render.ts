// pattern: Functional Core
import type { RecordUsage } from '../llm/types.js'
import type { Finding, Result } from '../review/types.js'
import { effectiveSeverity, severityRank } from '../review/types.js'
import { headline, renderFinding } from './markdown.js'
import { fingerprint } from '../review/fingerprint.js'

export type SizeEntry = { path:string; bytes:number }

export type Report = {
    result:Omit<Result, 'notes'>&{ notes?:string[]|null };
    mode:string;
    filesReviewed?:string[]|null;
    task?:string;
    runId?:string;
    budgets?:Record<string, unknown>|null;
    quick?:boolean;
    verified?:boolean;
    diffTruncated?:boolean;
    originalDiffBytes?:number;
    sizeBreakdown?:SizeEntry[]|null;
    usage?:Record<string, RecordUsage>|null;
    prior?:Map<string, string>|null;
    promptPacks?:string[]|null;
    reviewKind?:''|'survey_triage';
    completion?:string;
    manifestFileCount?:number;
    stopReason?:string;
}

function findingOut (f:Finding, r:Report):Record<string, unknown> {
    const out:Record<string, unknown> = {
        reasoning:f.reasoning,
        severity:f.severity,
        confidence:f.confidence,
        cwe:f.cwe,
        description:f.description,
        file:f.file,
        lines:f.lines ?? null,
        code_quote:f.code_quote,
        fixed_code:f.fixed_code,
        frontend_category:f.frontend_category,
    }
    if (f.verdict) {
        const v = f.verdict
        const verdict:Record<string, unknown> = {
            reasoning:v.reasoning ?? '',
            status:v.status,
            confidence:v.confidence ?? 0,
            grounding:v.grounding ?? '',
        }
        if (v.recalibrated_severity) {
            verdict.recalibrated_severity = v.recalibrated_severity
        }
        if (v.verifier) verdict.verifier = v.verifier
        if (v.undecided) verdict.undecided = true
        out.verdict = verdict
    }
    for (const key of ['_drop_reason', 'id', 'alias'] as const) {
        if (f[key]) out[key] = f[key]
    }
    const fp = fingerprint(f)
    if (fp) out.fingerprint = fp
    const note = r.prior?.get(fp)
    if (note) out.prior_sighting = note
    return out
}

function sortedValue (value:unknown):unknown {
    if (Array.isArray(value)) return value.map(sortedValue)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, v]) => [key, sortedValue(v)]))
}

function usageOut (usage:Record<string, RecordUsage>):unknown {
    return Object.fromEntries(Object.keys(usage).sort().map(role => {
        const u = usage[role]
        return [role, {
            uncached_input_tokens:u.uncached_input_tokens,
            cached_input_tokens:u.cached_input_tokens,
            cache_write_tokens:u.cache_write_tokens,
            output_tokens:u.output_tokens,
            calls:u.calls,
        }]
    }))
}

export function toJSON (r:Report):string {
    const payload:Record<string, unknown> = {
        assessment:r.result.assessment,
        dropped_findings:r.result.dropped.map(f => findingOut(f, r)),
        files_reviewed:r.filesReviewed ?? null,
        findings:r.result.findings.map(f => findingOut(f, r)),
        mode:r.mode,
        notes:r.result.notes ?? null,
        prompt_packs:r.promptPacks ?? null,
        quick:r.quick ?? false,
        usage:r.usage ? usageOut(r.usage) : null,
        verified:r.verified ?? false,
    }
    if (r.budgets != null) payload.budgets = sortedValue(r.budgets)
    if (r.diffTruncated) {
        payload.diff_truncated = true
        payload.original_diff_bytes = r.originalDiffBytes ?? 0
        payload.size_breakdown = r.sizeBreakdown?.map(s => ({
            path:s.path, bytes:s.bytes,
        })) ?? null
    }
    if (r.result.incomplete) payload.incomplete = true
    if (r.result.stopReason) payload.stop_reason = r.result.stopReason
    if (r.reviewKind === 'survey_triage') {
        payload.review_kind = r.reviewKind
        payload.completion = r.completion ?? ''
        payload.manifest_file_count = r.manifestFileCount ?? 0
        payload.stop_reason = r.stopReason ?? ''
    }
    if (r.runId) payload.run_id = r.runId
    return JSON.stringify(Object.fromEntries(
        Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    ))
}

export function toMarkdown (r:Report, showDropped:boolean):string {
    const lines:string[] = []
    if (r.reviewKind === 'survey_triage') {
        lines.push('> Survey triage \u2014 manifest contains ' +
            `${r.manifestFileCount ?? 0} files, ` +
            `completion=${r.completion ?? ''}, stop=${r.stopReason ?? ''}`,
        '')
    }
    lines.push(...headline(r))
    const sorted = [...r.result.findings].sort((a, b) =>
        severityRank(effectiveSeverity(b)) -
        severityRank(effectiveSeverity(a)) || b.confidence - a.confidence)
    for (const [i, f] of sorted.entries()) {
        lines.push(...renderFinding(i + 1, f, false, r.prior))
    }
    if (showDropped && r.result.dropped.length) {
        lines.push('## Dropped findings (--show-dropped)', '')
        for (const [i, f] of r.result.dropped.entries()) {
            lines.push(...renderFinding(i + 1, f, true, r.prior))
        }
    }
    return lines.join('\n')
}

export { writeReport } from './write.js'
