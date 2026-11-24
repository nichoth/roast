import { recordRepo } from './repo.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { recordDir } from '../../src/record/dir.js'
import {
    ResponseRecorder, PROVIDER_RESPONSES_FILE,
} from '../../src/record/responses.js'

test('concurrent captured responses have durable gap-free sequences',
    async t => {
        const repo = recordRepo(t)
        const dir = await recordDir(repo.dir, { env:repo.env })
        const recorder = new ResponseRecorder(dir, 'run')
        const results = await Promise.allSettled(Array.from({ length:20 },
            (_, i) => recorder.append('verifier', 'chat', 'model',
                'application/json', Buffer.from(`{"i":${i}}`))))
        t.ok(results.every(r => r.status === 'fulfilled'))
        const text = await fs.readFile(
            path.join(dir, 'run', PROVIDER_RESPONSES_FILE), 'utf8')
        t.ok(text.endsWith('\n'))
        const lines = text.trim().split('\n').map(s => JSON.parse(s))
        t.equal(lines.length, 20)
        t.deepEqual(lines.map(l => l.sequence),
            Array.from({ length:20 }, (_, i) => i + 1))
        t.deepEqual(lines.map(l => l.body.i),
            Array.from({ length:20 }, (_, i) => i))
        t.deepEqual(Object.keys(lines[0]), [
            'sequence', 'role', 'protocol', 'model', 'content_type', 'body',
        ])
    })

test('response bodies retain raw streams and JSON number spellings',
    async t => {
        const repo = recordRepo(t)
        const dir = await recordDir(repo.dir, { env:repo.env })
        const recorder = new ResponseRecorder(dir, 'run')
        const raw = ': ping\r\n\r\ndata: {"text":"\ufeff\u00e9 <>&"}\r\n\r\n'
        await recorder.append('finder', 'chat', 'm',
            'text/event-stream', Buffer.from(raw))
        await recorder.append('finder', 'chat', 'm', 'application/json',
            Buffer.from(' { "n":1.0, "n":12345678901234567890, ' +
                '"s":"a \\" b <>&\u2028\u2029", "e":1e+09 } '))
        const text = await fs.readFile(
            path.join(dir, 'run', PROVIDER_RESPONSES_FILE), 'utf8')
        const lines = text.trim().split('\n')
        t.equal(JSON.parse(lines[0]).body, raw)
        t.ok(lines[1].includes('"n":1.0,"n":12345678901234567890'))
        t.ok(lines[1].includes('"e":1e+09'))
        t.ok(lines[1].includes('<>&\u2028\u2029'))
        for (const [ct, body] of [
            ['application/json', Buffer.from('{bad')],
            ['text/event-stream', Buffer.from([0xff])],
            ['text/plain', Buffer.from('{}')],
        ] as const) {
            t.ok(await recorder.append('f', 'chat', 'm', ct, body)
                .then(() => false, () => true))
        }
        await recorder.append('finder', 'chat', 'm',
            'application/json', Buffer.from('null'))
        const after = await fs.readFile(
            path.join(dir, 'run', PROVIDER_RESPONSES_FILE), 'utf8')
        t.deepEqual(after.trim().split('\n').map(s => JSON.parse(s).sequence),
            [1, 2, 3])
    })

test('invalid captures never create a run directory', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    const r = new ResponseRecorder(dir, 'run')
    t.ok(await r.append('f', 'chat', 'm', 'application/json',
        Buffer.from('not JSON')).then(() => false, () => true))
    t.ok(await fs.lstat(path.dirname(dir)).then(() => false, () => true))
})
