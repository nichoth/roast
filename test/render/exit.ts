import { test } from '../helpers/test.js'
import { reportExitCode } from '../../src/render/exit.js'
import { finding, report } from './fixtures.js'

test('report exits prioritize live effective severity over partial state',
    t => {
        const result = report().result
        for (const [severity, rank] of [
            ['INFO', 0], ['LOW', 1], ['MEDIUM', 2],
            ['HIGH', 3], ['CRITICAL', 4],
        ] as const) {
            result.findings = [finding({ severity })]
            for (const gate of [-1, 0, 1, 2, 3, 4]) {
                t.deepEqual(reportExitCode(result, gate, false),
                    gate >= 0 && gate <= rank ? 1 : 0)
                t.deepEqual(reportExitCode(result, gate, true),
                    gate >= 0 && gate <= rank ? 1 : 4)
            }
        }
        result.findings = [finding({
            severity:'CRITICAL',
            verdict:{ status:'confirmed', recalibrated_severity:'LOW' }
        })]
        t.deepEqual(reportExitCode(result, 2, true), 4)
        t.deepEqual(reportExitCode(result, 1, true), 1)
        result.dropped = [finding({ severity:'CRITICAL' })]
        result.findings = []
        t.deepEqual(reportExitCode(result, 0, false), 0)
        t.deepEqual(reportExitCode(result, 0, true), 4)
        result.findings = [finding({ verdict:{ status:'refuted' } })]
        t.deepEqual(reportExitCode(result, 0, false), 0)
        result.findings.push(finding({ severity:'INFO' }))
        t.deepEqual(reportExitCode(result, 1, false), 0)
        t.deepEqual(reportExitCode(result, 0, true), 1)
    })
