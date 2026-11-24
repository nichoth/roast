// `roast review` end to end on a fake `chat` server (spec 01, 2.8 and
// section 5 "Pipeline").
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import {
    FINDER_KEY,
    filesUnder,
    finderScript,
    finding,
    readGz,
    requestRecorder,
    reviewMeta,
    runDirs,
    runsDir,
    settingsRepo,
} from '../helpers/review.js'
import { verifyBundle } from '../../src/runbundle/bundle.js'

test('review --no-verify exits 0 with no findings', async t => {
    const r = await settingsRepo(t)
    const requests = requestRecorder(r)
    const res = await r.roast(['review', '--no-verify', '--format', 'json'])
    t.equal(res.code, 0, res.stderr)
    const lines = res.stdout.trimEnd().split('\n')
    t.equal(lines.length, 1, 'one JSON line')
    const report = JSON.parse(lines[0])
    t.deepEqual(report.findings, [], 'no findings')
    t.equal(requests().length, 1, 'one structured finder call')
})

test('review gates on --max-severity with a HIGH finding', async t => {
    const r = await settingsRepo(t, finderScript([finding()]))
    const res = await r.roast(['--no-verify', '--format', 'json',
        '--max-severity', 'HIGH'])
    t.equal(res.code, 1, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.findings.length, 1, 'finding reported')
    t.equal(report.findings[0].severity, 'HIGH', 'severity')
    t.equal(report.findings[0].file, 'main.go', 'file')
    const lower = await r.roast(['review', '--no-verify', '--format',
        'json', '--max-severity', 'critical'])
    t.equal(lower.code, 0, 'below the threshold exits 0')
})

test('review writes a complete run record', async t => {
    const r = await settingsRepo(t, finderScript([finding()]))
    const res = await r.roast(['review', '--no-verify', '--format', 'json'])
    t.equal(res.code, 0, res.stderr)
    const dirs = runDirs(r)
    t.equal(dirs.length, 1, 'one run directory')
    const run = dirs[0]
    for (const name of ['meta.json', 'input.gz', 'finder_system.gz',
        'finder_user.gz', 'verifier_system.gz', 'provider-responses.jsonl',
        'result.json.gz', 'report.md', 'bundle.tar.zst']) {
        t.ok(fs.existsSync(path.join(run, name)), `${name} written`)
    }
    const responses = fs.readFileSync(
        path.join(run, 'provider-responses.jsonl'), 'utf8')
        .trimEnd().split('\n').map(l => JSON.parse(l))
    t.equal(responses.length, 1, 'one line per finder call')
    t.equal(responses[0].role, 'finder', 'finder response')
    const result = JSON.parse(readGz(path.join(run, 'result.json.gz')))
    t.equal(result.findings.length, 1, 'result artifact holds the finding')
    t.equal(result.run_id, path.basename(run), 'result names the run')
    await verifyBundle(path.join(run, 'bundle.tar.zst'))
    t.ok(true, 'bundle verifies')
    const index = fs.readdirSync(runsDir(r))
        .filter(n => n.startsWith('runs-') && n.endsWith('.jsonl'))
    t.equal(index.length, 1, 'monthly index file')
    const lines = fs.readFileSync(path.join(runsDir(r), index[0]), 'utf8')
        .trimEnd().split('\n')
    t.equal(lines.length, 1, 'index gains one line')
    const meta = reviewMeta(r)
    t.equal(meta.run_id, path.basename(run), 'meta run id')
    t.equal(meta.roles.finder.protocol, 'chat', 'finder protocol')
    t.equal(meta.roles.finder.profile, 'fake', 'finder profile')
    t.equal(meta.roles.finder.model, 'finder-model', 'finder model')
    t.deepEqual(meta.argv, ['review', '--no-verify', '--format', 'json'],
        'argv recorded')
    t.equal(meta.digests.input_kind, 'diff', 'input kind')
    for (const file of filesUnder(r.dir).filter(f =>
        !f.includes(`${path.sep}.git${path.sep}`) &&
        !f.endsWith('.gz') && !f.endsWith('.zst'))) {
        t.ok(!fs.readFileSync(file, 'utf8').includes(FINDER_KEY),
            `no key in ${path.relative(r.dir, file)}`)
    }
    for (const file of filesUnder(run).filter(f => f.endsWith('.gz'))) {
        t.ok(!readGz(file).includes(FINDER_KEY), 'no key in artifact')
    }
    t.ok(!res.stdout.includes(FINDER_KEY) &&
        !res.stderr.includes(FINDER_KEY), 'no key in output')
})
