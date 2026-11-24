import { test } from '@substrate-system/tapzero'
import { parseSse, type SseEvent } from '../../src/llm/sse.js'

const enc = new TextEncoder()

async function * chunksOf (...parts:(string|Uint8Array)[]) {
    for (const p of parts) yield typeof p === 'string' ? enc.encode(p) : p
}

async function collect (it:AsyncIterable<SseEvent>):Promise<SseEvent[]> {
    const out:SseEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

test('sse: LF, CRLF, and CR line endings', async t => {
    for (const nl of ['\n', '\r\n', '\r']) {
        const body = `event: a${nl}data: 1${nl}${nl}data: 2${nl}${nl}`
        t.deepEqual(await collect(parseSse(chunksOf(body))), [
            { event:'a', data:'1' },
            { event:'', data:'2' },
        ], JSON.stringify(nl))
    }
})

test('sse: CRLF split across chunks is one line ending', async t => {
    const evs = await collect(parseSse(chunksOf(
        'data: 1\r', '\n\r', '\ndata: 2\r\n\r\n')))
    t.deepEqual(evs, [{ event:'', data:'1' }, { event:'', data:'2' }])
})

test('sse: multi-line data, comments, ignored fields, no data', async t => {
    const body = [
        ': keepalive',
        'id: 7',
        'retry: 100',
        'data: one',
        'data:two',
        'data:  three',
        '',
        'event: empty',
        '',
        'data',
        '',
    ].join('\n') + '\n'
    t.deepEqual(await collect(parseSse(chunksOf(body))), [
        { event:'', data:'one\ntwo\n three' },
        { event:'', data:'' },
    ])
})

test('sse: trailing event without a final blank line', async t => {
    t.deepEqual(await collect(parseSse(chunksOf('data: x\n'))),
        [{ event:'', data:'x' }], 'line ending, no blank line')
    t.deepEqual(await collect(parseSse(chunksOf('data: y'))),
        [{ event:'', data:'y' }], 'no line ending at all')
})

test('sse: boundaries inside a line and a UTF-8 sequence', async t => {
    const bytes = enc.encode('data: caf\u00e9 \u2713\n\n')
    const parts:Uint8Array[] = []
    for (let i = 0; i < bytes.length; i++) parts.push(bytes.slice(i, i + 1))
    t.deepEqual(await collect(parseSse(chunksOf(...parts))),
        [{ event:'', data:'caf\u00e9 \u2713' }])
})

test('sse: reads no further than the requested event', async t => {
    let reads = 0
    async function * counted () {
        for (const p of ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']) {
            reads++
            yield enc.encode(p)
        }
    }
    const it = parseSse(counted())[Symbol.asyncIterator]()
    const first = await it.next()
    t.deepEqual(first.value, { event:'', data:'1' }, 'first event')
    t.equal(reads, 1, 'one chunk read for the first event')
    await it.next()
    t.equal(reads, 2, 'two chunks for the second')
    await it.return?.(undefined)
})
