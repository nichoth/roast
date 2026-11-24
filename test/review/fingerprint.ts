import { test } from '../helpers/test.js'
import {
    collapseWhitespace, fingerprint,
} from '../../src/review/fingerprint.js'
import { wire } from './fixtures.js'

test('fingerprints match Go and use only file and collapsed code', t => {
    // Go sha256 + strings.Fields, independently computed baseline vector.
    const expected = '8e82a535023eb3bb'
    const f = wire()
    t.equal(fingerprint(f), expected)
    t.equal(fingerprint(wire({ code_quote:' \treturn\u0085value\n' })),
        expected)
    t.equal(fingerprint(wire({
        description:'different',
        severity:'LOW',
        lines:[99]
    })), expected)
    t.ok(fingerprint(wire({ file:'b.ts' })) !== expected)
    t.ok(fingerprint(wire({ code_quote:'return other' })) !== expected)
    t.ok(fingerprint(wire({ code_quote:'return\ufeffvalue' })) !== expected)
    t.ok(/^[a-f0-9]{16}$/.test(fingerprint(f)))
    for (const s of ['', ' \t\u0085', '\ufeff', ' a\n b ', '\u{1f600}']) {
        t.equal(collapseWhitespace(collapseWhitespace(s)),
            collapseWhitespace(s), 'normalization is idempotent')
    }
    t.equal(collapseWhitespace('\u0085a\ufeff b\u3000'), 'a\ufeff b')
})
