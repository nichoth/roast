import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { recordRepo } from './repo.js'
import { meta } from './meta.js'
import { finding } from '../render/fixtures.js'
import { recordDir, makeRunDir } from '../../src/record/dir.js'
import {
    writeMeta, writeArtifact, writeReport,
} from '../../src/record/meta.js'
import { ResponseRecorder } from '../../src/record/responses.js'
import { openFindingSpill } from '../../src/record/findings.js'
import { fingerprint } from '../../src/review/fingerprint.js'

for (const wide of [false, true]) {
    const name = `run files protect ${wide ? 'existing' : 'new'} evidence`
    test(name, async t => {
        const repo = recordRepo(t)
        const dir = await recordDir(repo.dir, { env:repo.env })
        const m = meta(repo.dir)
        const run = await makeRunDir(dir, m.run_id)
        const rootMode = (await fs.stat(repo.dir)).mode
        const state = path.dirname(dir)
        await fs.chmod(state, 0o755)
        const names = [
            'meta.json', 'meta.json.tmp', 'input.gz', 'report.md',
            'provider-responses.jsonl', 'findings.jsonl',
        ]
        if (wide) {
            for (const name of names) {
                await fs.writeFile(path.join(run, name), '', { mode:0o644 })
                await fs.chmod(path.join(run, name), 0o644)
            }
        }
        const recorder = new ResponseRecorder(dir, m.run_id)
        const spill = await openFindingSpill(dir, m.run_id)
        t.ok(spill)
        const writes = [
            () => writeMeta(dir, m),
            () => writeArtifact(dir, m.run_id, 'input', 'data'),
            () => writeReport(dir, m.run_id, 'report'),
            () => recorder.append('finder', 'chat', 'm', 'application/json',
                Buffer.from('{}')),
            () => spill!(finding()),
            () => spill!(finding()),
        ]
        for (const write of writes) {
            await fs.chmod(dir, 0o755)
            await fs.chmod(run, 0o755)
            await write()
            t.equal((await fs.stat(dir)).mode & 0o777, 0o700)
            t.equal((await fs.stat(run)).mode & 0o777, 0o700)
        }
        for (const name of names.filter(n => !n.endsWith('.tmp'))) {
            t.equal((await fs.stat(path.join(run, name))).mode & 0o777, 0o600)
        }
        t.equal((await fs.stat(repo.dir)).mode, rootMode)
        t.equal((await fs.stat(state)).mode & 0o777, 0o755)
        const lines = (await fs.readFile(path.join(run, 'findings.jsonl'),
            'utf8')).trim().split('\n').map(s => JSON.parse(s))
        t.equal(lines.length, 2)
        t.equal(lines[0].fingerprint, fingerprint(finding()))
        t.deepEqual(lines[0].finding, finding())
        t.ok(/^\d{4}-.*Z$/.test(lines[0].ts))
    })
}

test('finding spill is best effort when recording fails', async t => {
    const repo = recordRepo(t)
    t.deepEqual(await openFindingSpill('', 'run'), null)
    const dir = await recordDir(repo.dir, { env:repo.env })
    t.deepEqual(await openFindingSpill(dir, '..'), null)
    const sink = await openFindingSpill(dir, 'run')
    await fs.mkdir(path.join(dir, 'run/findings.jsonl'))
    await sink!(finding())
    t.ok((await fs.stat(path.join(dir, 'run/findings.jsonl'))).isDirectory())
})
