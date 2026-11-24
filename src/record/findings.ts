// pattern: Imperative Shell
import path from 'node:path'
import { isValidName, makeRunDir, openPrivate } from './dir.js'
import { goStringify, rfc3339NanoUTC } from './json.js'
import { type WireFinding, toFinding } from '../review/types.js'
import { fingerprint } from '../review/fingerprint.js'

export type FindingSink = (finding:WireFinding) => Promise<void>

export async function openFindingSpill (
    dir:string,
    runId:string
):Promise<FindingSink|null> {
    if (!dir || !isValidName(runId)) return null
    try {
        await makeRunDir(dir, runId)
    } catch { return null }
    let tail:Promise<void> = Promise.resolve()
    return wf => {
        const append = tail.then(async () => {
            const finding = toFinding(wf)
            const line = goStringify({
                ts:rfc3339NanoUTC(new Date()),
                fingerprint:fingerprint(finding),
                finding:{ ...finding, lines:wf.lines },
            }) + '\n'
            const run = await makeRunDir(dir, runId)
            const handle = await openPrivate(path.join(run, 'findings.jsonl'),
                'a')
            try {
                await handle.writeFile(line)
            } finally {
                await handle.close()
            }
        }).catch(() => {})
        tail = append
        return append
    }
}
