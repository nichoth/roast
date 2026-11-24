import { test } from '@substrate-system/tapzero'
import { normalizeWS, WsNormalizer } from '../../src/context/normalize.js'
import { fieldsReference, rng } from './helpers.js'

const ALPHABET = [
    'a', '\u00e9', ' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\u0085',
    '\u2009', '\u3000', '\ufeff', 'x', '\u0000', '\u{1f600}',
].map(s => Buffer.from(s))
    .concat([Buffer.from([0xff]), Buffer.from([0xe2, 0x80]),
        Buffer.from([0xed, 0xa0, 0x80])])

test('normalizeWS equals the strings.Fields reference', t => {
    const r = rng(1)
    let bad = 0
    for (let i = 0; i < 3000; i++) {
        const parts:Buffer[] = []
        for (let j = r(40); j > 0; j--) parts.push(ALPHABET[r(ALPHABET.length)])
        const s = Buffer.concat(parts)
        const want = fieldsReference(s)
        if (!normalizeWS(s).equals(want)) {
            bad++
            if (bad === 1) t.fail(`normalizeWS(${s.toString('hex')})`)
        }
        // The same input streamed in random chunks, splitting runes.
        const n = new WsNormalizer()
        const out:Buffer[] = []
        for (let rest = s; ;) {
            const k = Math.min(rest.length, r(4))
            out.push(n.write(rest.subarray(0, k), false))
            rest = rest.subarray(k)
            if (rest.length === 0) {
                out.push(n.write(Buffer.alloc(0), true))
                break
            }
        }
        if (!Buffer.concat(out).equals(want)) {
            bad++
            if (bad === 1) t.fail(`streamed(${s.toString('hex')})`)
        }
    }
    t.equal(bad, 0, 'whole and streamed forms match the reference')
})

test('normalizeWS keeps NUL and U+FEFF, collapses U+0085', t => {
    t.ok(normalizeWS(Buffer.from(' a\u0000b ')).equals(Buffer.from('a\u0000b')),
        'NUL is not whitespace')
    t.ok(normalizeWS(Buffer.from('a\u0085\u0085b')).equals(Buffer.from('a b')),
        'U+0085 is whitespace')
    t.ok(normalizeWS(Buffer.from('a\ufeffb')).equals(Buffer.from('a\ufeffb')),
        'U+FEFF is not whitespace')
})
