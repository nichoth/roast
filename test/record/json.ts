import { test } from '../helpers/test.js'
import {
    compactJSON, goStringify, rfc3339NanoUTC, rfc3339Local,
} from '../../src/record/json.js'

test('record JSON preserves string values and native numeric tokens', t => {
    const values = ['', '<>&\u2028\u2029', '\n\t"\\', '\u00e9\ud83c\udf0d']
    for (const value of values) {
        t.deepEqual(JSON.parse(goStringify({ value })), { value })
    }
    t.equal(compactJSON(' \n [ 1.0, 12345678901234567890, -0, 1e+09, ' +
        '" a \\" b ", { "x" : null } ] \t'),
    '[1.0,12345678901234567890,-0,1e+09," a \\" b ",{"x":null}]')
    t.equal(rfc3339NanoUTC(new Date('2026-11-01T00:00:00.000Z')),
        '2026-11-01T00:00:00Z')
    t.equal(rfc3339NanoUTC(new Date('2026-11-01T00:00:00.120Z')),
        '2026-11-01T00:00:00.12Z')
    t.equal(rfc3339NanoUTC(new Date('2026-11-01T00:00:00.001Z')),
        '2026-11-01T00:00:00.001Z')
    const old = process.env.TZ
    process.env.TZ = 'UTC'
    t.cleanup(() => {
        if (old === undefined) delete process.env.TZ
        else process.env.TZ = old
    })
    t.equal(rfc3339Local(new Date('2026-11-01T00:00:00.120Z')),
        '2026-11-01T00:00:00Z')
    process.env.TZ = 'Asia/Kolkata'
    t.equal(rfc3339Local(new Date('2026-11-01T00:00:00.120Z')),
        '2026-11-01T05:30:00+05:30')
})
