// pattern: Functional Core
import type { Report } from './render.js'
import { formatFixed2, goTrimSpace } from '../gocompat/strings.js'
import { line, text } from '../textsafe/textsafe.js'
import { fingerprint } from '../review/fingerprint.js'
import { effectiveSeverity, type Finding } from '../review/types.js'

function longestBacktickRun (s:string):number {
    let longest = 0
    let run = 0
    for (const ch of s) {
        run = ch === '`' ? run + 1 : 0
        longest = Math.max(longest, run)
    }
    return longest
}

function inlineCode (s:string):string {
    const delim = '`'.repeat(longestBacktickRun(s) + 1)
    const padded = s.startsWith('`') || s.endsWith('`') ? ` ${s} ` : s
    return delim + padded + delim
}

export function listItemText (s:string, indent:string):string {
    return text(goTrimSpace(s)).replaceAll('\n', '\n' + indent)
}

export function renderFinding (
    ordinal:number,
    f:Finding,
    dropped:boolean,
    prior?:Map<string, string>|null,
):string[] {
    let sev = line(f.severity) || 'INFO'
    const effective = effectiveSeverity(f)
    if (effective !== f.severity) {
        sev = `${line(effective)} (finder claimed ${sev} ` +
            '\u2014 verifier recalibrated)'
    }
    const handle = line(f.alias ?? '') || `${ordinal}.`
    const tag = dropped ? `[DROPPED:${line(f._drop_reason || '?')}] ` : ''
    const conf = formatFixed2(f.confidence)
    const ln = !f.lines?.length ? '?' : f.lines.length === 1 ?
        `${f.lines[0]}` : `${f.lines[0]}-${f.lines[f.lines.length - 1]}`
    const desc = line(goTrimSpace(f.description))
    const out = [
        `### ${handle} ${tag}[${sev} \u00b7 conf ${conf}] ${desc}`,
        '- **File:** ' + inlineCode(line(f.file || '?') + ':' + ln),
    ]
    if (f.cwe) out.push('- **CWE:** ' + line(f.cwe))
    out.push('- **Reasoning:** ' + listItemText(f.reasoning, '  '))
    if (f.verdict) {
        const v = f.verdict
        out.push(`- **Verifier (${line(v.verifier || '?')}):** ` +
            `${line(v.status)} (conf ${formatFixed2(v.confidence ?? 0)})`)
        if (v.grounding) {
            out.push('  - grounding: ' + listItemText(v.grounding, '    '))
        }
    }
    for (const [label, value] of [
        ['Current', f.code_quote], ['Proposed fix', f.fixed_code],
    ]) {
        const block = text(value).replace(/\n+$/, '')
        if (block) {
            const fence = '`'.repeat(Math.max(3,
                longestBacktickRun(block) + 1))
            out.push(`- **${label}:**`, '  ' + fence,
                ...block.split('\n').map(l => '  ' + l), '  ' + fence)
        } else if (dropped) {
            out.push(`- **${label}:** *(not provided)*`)
        }
    }
    const fp = fingerprint(f)
    if (prior?.has(fp)) {
        out.push('- **Seen previously:** ' + line(prior.get(fp)!))
    }
    out.push('')
    return out
}

export function headline (r:Report):string[] {
    const res = r.result
    const lines:string[] = []
    const refuted = res.dropped.filter(f =>
        f._drop_reason === 'refuted_by_verifier').length
    const malformed = res.dropped.length - refuted
    if (!res.findings.length) {
        if (res.assessment === 'NO_DIFF') {
            lines.push('## Nothing to review in this scope ' +
                '\u2014 no review ran', '',
            'No model was called, so this is NOT a clean review. ' +
                'Already committed? Try `--base <ref>`; use `--staged` ' +
                'before committing or `--scope repo` for a repository survey.')
        } else if (res.stopReason === 'deadline' ||
            res.stopReason === 'token_budget') {
            lines.push(`## Roast cut off early (${res.stopReason}) ` +
                '\u2014 no findings before the cutoff', '',
            'The review was cut short by a run ceiling; ' +
                'this is NOT a clean review.')
        } else if (res.assessment === 'INCOMPLETE_NO_SUBMISSION') {
            lines.push('## Roast incomplete \u2014 ' +
                'no findings were submitted', '',
            'The interactive review exhausted its budget before ' +
                'submitting; this is NOT a clean review.')
        } else {
            let msg = 'The adversary found nothing to complain about.'
            if (refuted > 0) {
                msg += ` (${refuted} candidate finding(s) were refuted ` +
                    'by the cross-model verifier.)'
            }
            lines.push('## Roast complete \u2014 no findings', '', msg)
        }
    } else {
        if (res.stopReason) {
            lines.push(`## Roast cut off early (${line(res.stopReason)}) ` +
                '\u2014 partial findings follow', '')
        }
        const suffix = r.verified ? ' (cross-model verified)' : ''
        lines.push(`## Roast: ${res.findings.length} finding(s)${suffix}`)
    }
    if (malformed > 0) {
        lines.push('', `*(${malformed} candidate(s) dropped by schema ` +
            'gates; --show-dropped to see them.)*')
    }
    lines.push('')
    return lines
}
