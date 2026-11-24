import { test } from '@substrate-system/tapzero'
import {
    MAX_WINDOW,
    parseOffsetLimit,
} from '../../src/context/offset-limit.js'

test('parseOffsetLimit defaults to 1 and 500', t => {
    t.deepEqual(parseOffsetLimit({}), { offset:1, limit:500 })
    t.deepEqual(parseOffsetLimit({ offset:null, limit:null }),
        { offset:1, limit:500 }, 'null means absent')
})

test('parseOffsetLimit truncates numbers and raises small ones to 1', t => {
    t.deepEqual(parseOffsetLimit({ offset:7.9, limit:-3.5 }),
        { offset:7, limit:1 })
    t.deepEqual(parseOffsetLimit({ offset:0, limit:-100 }),
        { offset:1, limit:1 })
})

test('parseOffsetLimit coerces strings like Go fmt.Sscan', t => {
    const cases:[string, number][] = [
        ['12', 12], [' \n 40', 40], ['12abc', 12], ['1.5', 1],
        ['+9', 9], ['0x10', 16], ['0b101', 5], ['0o17', 15],
        ['017', 15], ['1_000', 1000], ['-4', 1], ['0', 1],
    ]
    for (const [s, want] of cases) {
        t.deepEqual(parseOffsetLimit({ offset:s }),
            { offset:want, limit:500 }, `offset ${JSON.stringify(s)}`)
    }
})

test('parseOffsetLimit rejects non-numeric values', t => {
    for (const v of ['', 'abc', '  ', true, {}, [1]]) {
        const res = parseOffsetLimit({ limit:v })
        t.ok('error' in res, `limit ${JSON.stringify(v)} is an error`)
    }
})

test('parseOffsetLimit clamps huge values to 2^30', t => {
    t.equal(MAX_WINDOW, 2 ** 30)
    for (const v of [1e30, '99999999999999999999',
        JSON.parse('9007199254740993') as number,
        Infinity, '0x' + 'f'.repeat(40)]) {
        t.deepEqual(parseOffsetLimit({ offset:v, limit:v }),
            { offset:MAX_WINDOW, limit:MAX_WINDOW }, `clamps ${String(v)}`)
    }
    t.deepEqual(parseOffsetLimit({ offset:'-99999999999999999999' }),
        { offset:1, limit:500 }, 'a huge negative becomes 1')
})
