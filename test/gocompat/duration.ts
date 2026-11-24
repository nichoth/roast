import { test } from '@substrate-system/tapzero'
import {
    parseGoDuration,
    isGoDuration,
    formatGoDuration,
    toMillis,
} from '../../src/gocompat/duration.js'

const S = 1_000_000_000n
const MS = 1_000_000n

test('parseGoDuration accepts the time.ParseDuration grammar', t => {
    const cases:[string, bigint][] = [
        ['90s', 90n * S],
        ['10m', 600n * S],
        ['1h30m', 5400n * S],
        ['1.5h', 5400n * S],
        ['.5s', 500n * MS],
        ['5.s', 5n * S],
        ['-1s', -S],
        ['+2s', 2n * S],
        ['0', 0n],
        ['-0s', 0n],
        ['+0', 0n],
        ['1\u00b5s', 1000n],
        ['1\u03bcs', 1000n],
        ['3us', 3000n],
        ['7ns', 7n],
        ['1.5ms', 1_500_000n],
        ['1h1m1s1ms1us1ns', 3661n * S + MS + 1000n + 1n],
        ['9223372036854775807ns', 9223372036854775807n],
        ['-9223372036854775808ns', -9223372036854775808n],
        ['2562047h', 2562047n * 3600n * S],
        ['0.000000001s', 1n],
        ['0.1234567891s', 123456789n],
    ]
    for (const [s, want] of cases) {
        t.equal(parseGoDuration(s), want, s)
        t.ok(isGoDuration(s), `${s} is a duration`)
    }
})

test('parseGoDuration rejects malformed and overflowing input', t => {
    const bad = [
        '', '10', '1x', '-', '+', '.s', 's', '1.2.3s', ' 1s', '1s ',
        '1S', '-10', '9223372036854775808ns', '2562048h',
        '9223372036854775807ns1ns', '99999999999999999999s',
    ]
    for (const s of bad) {
        t.throws(() => parseGoDuration(s), JSON.stringify(s))
        t.ok(!isGoDuration(s), `${JSON.stringify(s)} is not a duration`)
    }
})

test('formatGoDuration reproduces Go Duration.String', t => {
    const cases:[bigint, string][] = [
        [0n, '0s'],
        [45n * S, '45s'],
        [180n * S, '3m0s'],
        [600n * S, '10m0s'],
        [1500n * S, '25m0s'],
        [5400n * S, '1h30m0s'],
        [90n * S + 500n * MS, '1m30.5s'],
        [1_500_000n, '1.5ms'],
        [1500n, '1.5\u00b5s'],
        [12n, '12ns'],
        [-S, '-1s'],
        [-1_500_000n, '-1.5ms'],
        [9223372036854775807n, '2562047h47m16.854775807s'],
        [-9223372036854775808n, '-2562047h47m16.854775808s'],
    ]
    for (const [ns, want] of cases) t.equal(formatGoDuration(ns), want, want)
})

test('parse then format round-trips Go-formatted strings', t => {
    for (const s of ['0s', '45s', '3m0s', '10m0s', '1h30m0s', '1m30.5s',
        '1.5ms']) {
        t.equal(formatGoDuration(parseGoDuration(s)), s, s)
    }
})

test('toMillis converts nanoseconds to whole milliseconds', t => {
    t.equal(toMillis(90n * S), 90000, '90s')
    t.equal(toMillis(1_500_000n), 1, 'sub-millisecond part truncated')
    t.equal(toMillis(0n), 0, 'zero')
})
