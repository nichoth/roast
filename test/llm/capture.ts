import { test } from '@substrate-system/tapzero'
import { CaptureGate, openCapturedBody } from '../../src/llm/capture.js'
import { CaptureError } from '../../src/llm/errors.js'

function sseResponse (pieces:Uint8Array[]):Response {
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
        pull (c) {
            if (i < pieces.length) c.enqueue(pieces[i++])
            else c.close()
        },
    }, { highWaterMark:0 })
    return new Response(stream, {
        headers:{ 'Content-Type':'text/event-stream' },
    })
}

test('streaming capture never holds more than the cap', async t => {
    const pieces = Array.from({ length:10 }, () => new Uint8Array(30))
    const gate = new CaptureGate()
    let calls = 0
    const body = await openCapturedBody(sseResponse(pieces), {
        role:'verifier',
        protocol:'chat',
        model:'m',
        limit:100,
        captureResponse:() => { calls++ },
    }, gate)
    let yielded = 0
    let err:unknown
    try {
        for await (const c of body.chunks) yielded += c.length
    } catch (e) {
        err = e
    }
    await body.release()
    t.ok(err instanceof CaptureError, 'overflow is a capture error')
    t.equal(yielded, 90, 'only chunks within the cap were passed on')
    t.equal(calls, 0, 'callback not called')
    t.equal(gate.failure, err, 'gate latched')
})

test('capture at exactly the cap succeeds', async t => {
    const pieces = [new Uint8Array(60), new Uint8Array(40)]
    const gate = new CaptureGate()
    let captured = -1
    const body = await openCapturedBody(sseResponse(pieces), {
        role:'finder',
        protocol:'chat',
        model:'m',
        limit:100,
        captureResponse:raw => { captured = raw.body.length },
    }, gate)
    for await (const _ of body.chunks) { /* drain */ }
    await body.release()
    await body.release()
    t.equal(captured, 100, 'all bytes captured')
    t.equal(gate.failure, undefined, 'no failure')
})

test('without a callback nothing is buffered or captured', async t => {
    const gate = new CaptureGate()
    const body = await openCapturedBody(new Response('not json', {
        headers:{ 'Content-Type':'application/json' },
    }), { role:'finder', protocol:'chat', model:'m' }, gate)
    let n = 0
    for await (const c of body.chunks) n += c.length
    await body.release()
    t.equal(n, 8, 'body passed through unchanged')
    t.equal(gate.failure, undefined, 'no JSON validation without capture')
})
