// pattern: Functional Core
import { maxSeverity, type Result } from '../review/types.js'

export function reportExitCode (
    result:Pick<Result, 'findings'>,
    gateRank:number,
    partial:boolean,
):number {
    const live = result.findings.filter(f => f.verdict?.status !== 'refuted')
    if (gateRank >= 0 && maxSeverity({ findings:live }) >= gateRank) return 1
    return partial ? 4 : 0
}
