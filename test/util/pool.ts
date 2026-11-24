import { test } from '@substrate-system/tapzero'
import { mapPool } from '../../src/util/pool.js'

function sleep (ms:number):Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

test('mapPool keeps at most `limit` in flight and preserves order', async t => {
    let inFlight = 0
    let peak = 0
    const started:number[] = []
    // Later items finish first, so completion order differs from input.
    const delays = [50, 40, 30, 20, 10]
    const out = await mapPool(delays, 2, async (ms, i) => {
        started.push(i)
        inFlight++
        peak = Math.max(peak, inFlight)
        await sleep(ms)
        inFlight--
        return `item${i}`
    })
    t.equal(peak, 2, 'never more than 2 in flight')
    t.deepEqual(out, ['item0', 'item1', 'item2', 'item3', 'item4'],
        'results in input order')
    t.deepEqual(started, [0, 1, 2, 3, 4], 'items start in input order')
})

test('mapPool does not start every item at once', async t => {
    const started:number[] = []
    const gates:(() => void)[] = []
    const run = mapPool([0, 1, 2, 3, 4], 2, (n:number) => {
        started.push(n)
        return new Promise<number>(resolve => {
            gates.push(() => resolve(n * 10))
        })
    })
    await sleep(5)
    t.deepEqual(started, [0, 1], 'only two started before any finishes')
    while (gates.length) {
        gates.shift()!()
        await sleep(1)
    }
    t.deepEqual(await run, [0, 10, 20, 30, 40], 'all results')
})

test('mapPool over no items resolves an empty array', async t => {
    t.deepEqual(await mapPool([], 3, async () => 1), [], 'empty')
})

test('mapPool rejects with the first error and starts no more', async t => {
    const started:number[] = []
    let err:unknown
    try {
        await mapPool([0, 1, 2, 3, 4, 5], 1, async n => {
            started.push(n)
            if (n === 1) throw new Error('boom')
            return n
        })
    } catch (e) {
        err = e
    }
    t.equal((err as Error)?.message, 'boom', 'rejects with the error')
    t.deepEqual(started, [0, 1], 'no item starts after the failure')
})

test('mapPool stops starting items once the signal aborts', async t => {
    const ac = new AbortController()
    const reason = new Error('stop')
    const started:number[] = []
    let err:unknown
    try {
        await mapPool([0, 1, 2, 3], 1, async n => {
            started.push(n)
            if (n === 1) ac.abort(reason)
            return n
        }, ac.signal)
    } catch (e) {
        err = e
    }
    t.equal(err, reason, 'rejects with the abort reason')
    t.deepEqual(started, [0, 1], 'nothing starts after the abort')
})
