import { recordRepo } from './repo.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { tempDir } from '../helpers/repo.js'
import { finding, report } from '../render/fixtures.js'
import { recordDir } from '../../src/record/dir.js'
import { fingerprint } from '../../src/review/fingerprint.js'
import { appendRunLine, seenBefore } from '../../src/record/index-file.js'

test('monthly index records completed runs using local time', async t => {
    const repo = recordRepo(t)
    const outside = tempDir()
    t.cleanup(outside.remove)
    const zone = process.env.TZ
    process.env.TZ = 'Etc/GMT+8'
    t.cleanup(() => {
        if (zone === undefined) delete process.env.TZ
        else process.env.TZ = zone
    })
    const dir = await recordDir(repo.dir, { env:repo.env })
    const r = report({
        runId:'run',
        promptPacks:['frontend', 'security'],
        verified:true,
        budgets:{ z:1, a:2 },
        prior:new Map([['fp', 'do not persist']]),
    })
    r.result.dropped = [finding({ _drop_reason:'refuted_by_verifier' })]
    const now = new Date('2026-11-01T03:04:05.120Z')
    await appendRunLine(dir, r, repo.dir, ['review'], now)
    await appendRunLine(dir, r, repo.dir, null, now)
    const files = await fs.readdir(dir)
    t.deepEqual(files, ['runs-2026-10.jsonl'])
    const lines = (await fs.readFile(path.join(dir, files[0]), 'utf8'))
        .trim().split('\n').map(s => JSON.parse(s))
    t.equal(lines.length, 2)
    t.deepEqual(Object.keys(lines[0]), [
        'ts', 'run_id', 'repo', 'argv', 'mode', 'quick', 'verified',
        'assessment', 'n_findings', 'n_dropped', 'n_refuted',
        'files_reviewed', 'findings', 'dropped_findings', 'usage',
        'prompt_packs', 'budgets',
    ])
    t.equal(lines[0].ts, '2026-10-31T19:04:05-08:00')
    t.equal(lines[0].repo, repo.dir)
    t.deepEqual(lines[0].argv, ['review'])
    t.deepEqual(lines[1].argv, null)
    t.deepEqual(lines[0].prompt_packs, ['frontend', 'security'])
    t.equal(lines[0].n_findings, 1)
    t.equal(lines[0].n_dropped, 1)
    t.equal(lines[0].n_refuted, 1)
    t.equal(lines[0].findings[0].fingerprint, fingerprint(finding()))
    t.equal(lines[0].dropped_findings[0].fingerprint, fingerprint(finding()))
    t.deepEqual(lines[0].usage, null)
    t.deepEqual(lines[0].files_reviewed, null)
    t.deepEqual(Object.keys(lines[0].budgets), ['a', 'z'])
    await appendRunLine('', r, outside.dir, [], now)
    t.deepEqual(await fs.readdir(outside.dir), [])
    const bad = path.join(repo.dir, 'file')
    await fs.writeFile(bad, '')
    await appendRunLine(path.join(bad, 'runs'), r, repo.dir, [], now)
    t.equal(await fs.readFile(bad, 'utf8'), '')
})

test('prior sightings keep oldest line in newest matching month', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    const f = finding()
    const fp = fingerprint(f)
    t.equal((await seenBefore(dir, repo.dir, [f], 3)).size, 0)
    const r = report({
        result:{
            findings:[],
            dropped:[{ ...f, _drop_reason:'below_confidence_floor' }],
            assessment:'NO_FINDINGS',
            notes:[],
        }
    })
    await appendRunLine(dir, r, repo.dir, [], new Date(2026, 9, 1))
    await appendRunLine(dir, r, '/other/repo', [], new Date(2026, 10, 1))
    await appendRunLine(dir, r, repo.dir, [], new Date(2026, 10, 2))
    await appendRunLine(dir, r, repo.dir, [], new Date(2026, 10, 3))
    const month = path.join(dir, 'runs-2026-11.jsonl')
    const lines = (await fs.readFile(month, 'utf8')).trim().split('\n')
    await fs.writeFile(month, 'invalid\nnull\n{}\n' + lines.join('\n') + '\n')
    const got = await seenBefore(dir, repo.dir, [f], 3)
    t.deepEqual(got.get(fp), {
        runTS:JSON.parse(lines[1]).ts,
        dropReason:'below_confidence_floor',
    })
    t.equal((await seenBefore(dir, '/other', [f], 3)).size, 0)
    t.equal((await seenBefore(dir, repo.dir,
        [finding({ file:'missing.ts' })], 3)).size, 0)
    t.equal((await seenBefore(dir, repo.dir, [], 3)).size, 0)
    await appendRunLine(dir, report(), '/other', [], new Date(2026, 11, 1))
    t.equal((await seenBefore(dir, repo.dir, [f], 1)).size, 0)
    t.equal((await seenBefore(dir, repo.dir, [f], 2)).get(fp)?.runTS,
        JSON.parse(lines[1]).ts)
    t.equal((await seenBefore(dir, repo.dir, [f], 0)).get(fp)?.runTS,
        JSON.parse(lines[1]).ts)
    t.equal((await seenBefore('', repo.dir, [f], 3)).size, 0)
})

test('prior scan stops a monthly file at the Go scanner limit', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    await appendRunLine(dir, report(), repo.dir, [], new Date(2026, 10, 1))
    const file = path.join(dir, 'runs-2026-11.jsonl')
    const line = await fs.readFile(file)
    await fs.writeFile(file, Buffer.concat([
        Buffer.alloc(4 * 1024 * 1024, 0x78), Buffer.from('\n'), line,
    ]))
    t.equal((await seenBefore(dir, repo.dir, [finding()], 3)).size, 0)
})

test('monthly index tightens existing files on append', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    const now = new Date(2026, 10, 20)
    const file = path.join(dir, 'runs-2026-11.jsonl')
    await appendRunLine(dir, report(), repo.dir, [], now)
    t.equal((await fs.stat(file)).mode & 0o777, 0o600)
    await fs.chmod(file, 0o644)
    await fs.chmod(dir, 0o755)
    await appendRunLine(dir, report(), repo.dir, [], now)
    t.equal((await fs.stat(file)).mode & 0o777, 0o600)
    t.equal((await fs.stat(dir)).mode & 0o777, 0o755)
})

test('monthly index sorts arbitrary map keys bytewise', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    const bmp = '\ue000'
    const astral = '\ud800\udc00'
    const usage = {
        uncached_input_tokens:1,
        cached_input_tokens:2,
        cache_write_tokens:3,
        output_tokens:4,
        calls:5
    }
    const r = report({
        budgets:{ [astral]:1, [bmp]:2 },
        usage:{ [astral]:usage, [bmp]:usage },
    })
    await appendRunLine(dir, r, repo.dir, [], new Date(2026, 10, 1))
    const raw = await fs.readFile(path.join(dir, 'runs-2026-11.jsonl'), 'utf8')
    const line = JSON.parse(raw)
    t.deepEqual(Object.keys(line.budgets), [bmp, astral])
    t.deepEqual(Object.keys(line.usage), [bmp, astral])
    t.deepEqual(Object.keys(line.usage[bmp]), [
        'uncached_input_tokens', 'cached_input_tokens', 'cache_write_tokens',
        'output_tokens', 'calls',
    ])
})
