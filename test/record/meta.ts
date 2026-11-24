import { recordRepo } from './repo.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { test } from '../helpers/test.js'
import { recordDir } from '../../src/record/dir.js'
import {
    type Meta, writeMeta, readMeta, writeArtifact, readArtifact,
    serializeMeta,
    wireProtocol,
    captureEnv,
    digest,
    writeReport, reportPath,
    removeRun, resolveRunDir,
} from '../../src/record/meta.js'

export function meta (repo:string):Meta {
    return {
        run_id:'20260919T120000Z-1234abcd',
        ts:'2026-09-19T12:00:00Z',
        repo,
        roast:{ version:'dev', commit:'dev' },
        scope:{ kind:'diff', paths:[], staged_only:false },
        derived:{
            mode:'code',
            interactive:false,
            max_turns:3,
            confidence_floor:0.8,
            do_verify:true
        },
        roles:{
            verifier:{
                base_url:'https://example.test',
                model:'v',
                protocol:'chat',
                max_output_tokens:100
            },
            finder:{
                base_url:'https://example.test',
                model:'f',
                protocol:'chat',
                max_output_tokens:100
            }
        },
        snapshot:{ captured:false },
        digests:{ input_kind:'diff', input:'abc', input_bytes:7 },
        budgets:{ z:1, a:{ z:2, a:3 } },
        argv:[],
        caveats:[],
        env_names_only:[],
    }
}

test('metadata and gzip artifacts preserve replay evidence', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    const m = meta(repo.dir)
    Object.assign(m, { api_key:'secret-api-key-value' })
    Object.assign(m.roles.finder, { apiKey:'secret-api-key-value' })
    m.env_names_only = captureEnv({
        ROAST_FINDER_API_KEY:'secret-api-key-value',
        ROAST_GATEWAY_TOKEN:'secret-api-key-value',
    }, ['ROAST_GATEWAY_TOKEN'])
    const file = await writeMeta(dir, m)
    const got = await readMeta(dir, '20260919')
    t.equal(got.meta.run_id, m.run_id)
    t.equal(got.meta.roles.finder.model, m.roles.finder.model)
    t.equal(got.meta.roles.verifier.base_url, m.roles.verifier.base_url)
    t.equal(got.runDir, path.join(dir, m.run_id))
    const raw = await fs.readFile(file, 'utf8')
    t.equal(raw, serializeMeta(m))
    const out = JSON.parse(raw)
    t.deepEqual(Object.keys(out), [
        'run_id', 'ts', 'repo', 'roast', 'scope', 'derived', 'roles',
        'snapshot', 'digests', 'budgets',
    ])
    t.deepEqual(Object.keys(out.roles), ['finder', 'verifier'])
    t.deepEqual(Object.keys(out.budgets), ['a', 'z'])
    t.deepEqual(Object.keys(out.budgets.a), ['a', 'z'])
    t.deepEqual(out.scope, { kind:'diff' })
    t.ok(raw.endsWith('\n'))
    t.ok(raw.includes('\n  "run_id":'))
    const text = '<>&\u2028\u2029 \u00e9\n'
    await writeArtifact(dir, m.run_id, 'input', text)
    t.equal(await readArtifact(got.runDir, 'input'), text)
    await writeArtifact(dir, m.run_id, 'empty', '')
    t.equal(await readArtifact(got.runDir, 'empty'), '')
    m.caveats = [text]
    t.ok(serializeMeta(m).includes('<>&\u2028\u2029'))
    for (const name of await fs.readdir(got.runDir)) {
        const data = await fs.readFile(path.join(got.runDir, name))
        t.ok(!data.includes('secret-api-key-value'))
    }
})

test('invalid names are rejected without touching project state', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
        const operations = [
            () => writeMeta(dir, { ...meta(repo.dir), run_id:id }),
            () => writeArtifact(dir, id, 'input', 'text'),
            () => writeArtifact(dir, 'run', id, 'text'),
            () => readArtifact(dir, id),
            () => readMeta(dir, id),
            () => resolveRunDir(dir, id),
            () => removeRun(dir, id),
        ]
        for (const operation of operations) {
            t.ok(await operation().then(() => false, () => true))
        }
    }
    t.ok(await fs.lstat(path.dirname(dir)).then(() => false, () => true))
    await writeReport(dir, 'good', 'preserved')
    const ignore = path.join(repo.dir, '.roast/.gitignore')
    t.ok(await removeRun(dir, '..').then(() => false, () => true))
    t.equal(await fs.readFile(ignore, 'utf8'), '*\n')
    await removeRun(dir, 'good')
    t.ok(await fs.lstat(path.join(dir, 'good')).then(() => false, () => true))
    await removeRun('', 'good')
    t.equal(await fs.readFile(ignore, 'utf8'), '*\n')
})

test('stored reports resolve by unique prefix and reject ambiguity',
    async t => {
        const repo = recordRepo(t)
        const dir = await recordDir(repo.dir, { env:repo.env })
        const text = '# Report\n\n<raw> \u00e9\n'
        const file = await writeReport(dir, 'run-123', text)
        t.equal(await reportPath(dir, 'run'), file)
        const resolved = await reportPath(dir, 'run-1')
        t.equal(await fs.readFile(resolved, 'utf8'), text)
        await writeReport(dir, 'run-456', 'other')
        t.ok(await reportPath(dir, 'run').then(() => false, () => true))
        t.ok(await reportPath(dir, 'missing').then(() => false, () => true))
        // Symlinks and files do not count as matching run directories.
        await fs.symlink(path.join(dir, 'run-123'), path.join(dir, 'link'))
        t.ok(await reportPath(dir, 'link').then(() => false, () => true))
        await fs.writeFile(path.join(dir, 'ordinary'), '')
        t.ok(await reportPath(dir, 'ordinary').then(() => false, () => true))
    })

test('diff digests and gzip artifacts preserve invalid UTF-8 bytes',
    async t => {
        const repo = recordRepo(t)
        const dir = await recordDir(repo.dir, { env:repo.env })
        const bytes = Buffer.from([0x64, 0x69, 0x66, 0x66, 0xff, 0xc0, 0x0a])
        const expected = createHash('sha256').update(bytes).digest('hex')
        t.equal(digest(bytes), expected)
        t.ok(digest(bytes) !== digest(bytes.toString('utf8')))
        const file = await writeArtifact(dir, 'run', 'input', bytes)
        t.deepEqual(gunzipSync(await fs.readFile(file)), bytes)
        t.equal(digest('abc'),
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    })

test('captureEnv keeps sorted diagnostic names and excludes keys', t => {
    const names = captureEnv({
        ROAST_Z:'not-the-name',
        ROAST_A:'123',
        ROAST_FINDER_API_KEY:'secret-api-key-value',
        ROAST_VERIFIER_API_KEY:'secret-api-key-value',
        ROAST_OTHER_API_KEY:'secret-api-key-value',
        ROAST_CUSTOM_TOKEN:'secret-api-key-value',
        OPENAI_API_KEY:'secret-api-key-value',
        unrelated:'unrelated',
        ROAST_UNSET:undefined,
    }, ['ROAST_CUSTOM_TOKEN'])
    t.deepEqual(names, ['ROAST_A', 'ROAST_Z'])
})

test('legacy metadata uses api with exact keys and Go zero values',
    async t => {
        const repo = recordRepo(t)
        const dir = await recordDir(repo.dir, { env:repo.env })
        const m = meta(repo.dir)
        const file = await writeMeta(dir, m)
        await fs.writeFile(file, JSON.stringify({
            Run_ID:'wrong case',
            roles:{ finder:{ api:'responses' } },
            scope:null,
            extra:'ignored',
        }))
        const got = (await readMeta(dir, m.run_id)).meta
        t.equal(wireProtocol(got.roles.finder), 'responses')
        t.equal(got.roles.finder.protocol, '')
        t.equal(wireProtocol({
            ...got.roles.finder,
            protocol:'anthropic'
        }), 'anthropic')
        t.equal(got.run_id, '')
        t.equal(got.scope.kind, '')
        t.equal(got.derived.max_turns, 0)
        t.ok(!Object.hasOwn(got, 'extra'))
        await fs.writeFile(file, '{"roles":{"finder":{"model":123}}}')
        t.ok(await readMeta(dir, m.run_id).then(() => false, () => true))
        await fs.writeFile(file, '{"derived":{"max_turns":1.5}}')
        t.ok(await readMeta(dir, m.run_id).then(() => false, () => true))
        await fs.writeFile(file, '{"derived":{"max_turns":1.0}}')
        t.ok(await readMeta(dir, m.run_id).then(() => false, () => true))
    })
