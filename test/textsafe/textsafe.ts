import { test } from '@substrate-system/tapzero'
import {
    text,
    line,
    textBytes,
    lineBytes,
} from '../../src/textsafe/textsafe.js'

// Go vectors from internal/textsafe/textsafe_test.go (TestTextEscapesControls)
// whose input is valid UTF-8, so a JS string can carry them.
const TEXT_VECTORS:[string, string][] = [
    ['plain text', 'plain text'],
    ['keeps\nnewline\tand tab', 'keeps\nnewline\tand tab'],
    ['esc\x1b[2J', 'esc\\x1b[2J'],
    ['osc\x1b]0;title\x07', 'osc\\x1b]0;title\\x07'],
    ['nul\x00 del\x7f', 'nul\\x00 del\\x7f'],
    ['lone\rcarriage return', 'lone\\x0dcarriage return'],
    ['crlf\r\nline', 'crlf\nline'],
    ['c1 csi\u009b2J', 'c1 csi\\u009b2J'],
    ['c1 nel\u0085', 'c1 nel\\u0085'],
    ['unicode \u00e9 \u2713 stays', 'unicode \u00e9 \u2713 stays'],
]

test('text escapes controls and keeps newlines, tabs, non-ASCII', t => {
    for (const [input, want] of TEXT_VECTORS) {
        t.equal(text(input), want, JSON.stringify(input))
        t.equal(textBytes(Buffer.from(input)), want,
            'bytes ' + JSON.stringify(input))
    }
})

test('textBytes escapes each invalid byte on its own', t => {
    const cases:[number[], string][] = [
        [[...Buffer.from('raw byte'), 0x9b], 'raw byte\\x9b'],
        [[0xe2, 0x82], '\\xe2\\x82'],
        [[0xe2, 0x82, 0xac], '\u20ac'],
        // Overlong encoding of '/'.
        [[0xc0, 0xaf], '\\xc0\\xaf'],
        // UTF-8-encoded surrogate U+D800.
        [[0xed, 0xa0, 0x80], '\\xed\\xa0\\x80'],
        // Above U+10FFFF.
        [[0xf4, 0x90, 0x80, 0x80], '\\xf4\\x90\\x80\\x80'],
        [[0xf0, 0x9f, 0x98, 0x80], '\u{1f600}'],
        [[0xef, 0xbf, 0xbd], '\ufffd'],
    ]
    for (const [bytes, want] of cases) {
        t.equal(textBytes(Uint8Array.from(bytes)), want,
            Buffer.from(bytes).toString('hex'))
    }
})

test('line escapes newline and tab and does not collapse CRLF', t => {
    const input = 'desc\n## Roast complete \u2014 no findings\r\n\tx\x1b'
    const want = 'desc\\n## Roast complete \u2014 no findings' +
        '\\x0d\\n\\tx\\x1b'
    t.equal(line(input), want, 'string variant')
    t.equal(lineBytes(Buffer.from(input)), want, 'byte variant')
})

test('a lone surrogate is escaped, a surrogate pair kept', t => {
    t.equal(text('a\ud800b'), 'a\\ud800b', 'lone high surrogate')
    t.equal(line('a\udfffb'), 'a\\udfffb', 'lone low surrogate')
    t.equal(text('x\udc00\ud83dy'), 'x\\udc00\\ud83dy',
        'reversed pair is two lone surrogates')
    t.equal(text('pair \u{1f600}'), 'pair \u{1f600}',
        'well-formed pair unchanged')
    t.equal(line('pair \u{1f600}'), 'pair \u{1f600}',
        'well-formed pair unchanged in line mode')
})

// True when `s` holds a character that must never survive sanitizing.
function badChar (s:string, lineMode:boolean):string|null {
    for (const ch of s) {
        const cp = ch.codePointAt(0)!
        const control = (cp < 0x20 && cp !== 0x0a && cp !== 0x09) ||
            (cp >= 0x7f && cp <= 0x9f)
        if (control || cp === 0xfffd || (cp >= 0xd800 && cp <= 0xdfff)) {
            return ch
        }
        if (lineMode && (cp === 0x0a || cp === 0x09)) return ch
    }
    return null
}

test('outputs over U+0000..U+00FF are clean and idempotent', t => {
    let all = ''
    for (let cp = 0; cp < 0x100; cp++) all += String.fromCodePoint(cp)
    const bytes = Buffer.concat([
        Buffer.from(all),
        Buffer.from([0xff, 0xfe, 0xc2]),
    ])
    const variants:[string, (s:string) => string, string, boolean][] = [
        ['text', text, text(all), false],
        ['line', line, line(all), true],
        ['textBytes', text, textBytes(bytes), false],
        ['lineBytes', line, lineBytes(bytes), true],
    ]
    for (const [name, fn, out, lineMode] of variants) {
        t.equal(badChar(out, lineMode), null, `${name} output is clean`)
        t.equal(fn(out), out, `${name} output is idempotent`)
    }
})

// A small deterministic PRNG so failures reproduce.
function prng (seed:number):() => number {
    let x = seed >>> 0
    return () => {
        x ^= x << 13
        x >>>= 0
        x ^= x >>> 17
        x ^= x << 5
        x >>>= 0
        return x
    }
}

test('random byte arrays come out clean and idempotent', t => {
    const next = prng(0x5eed)
    let failures = 0
    for (let i = 0; i < 2000; i++) {
        const len = next() % 64
        const bytes = new Uint8Array(len)
        for (let j = 0; j < len; j++) {
            // Bias toward interesting bytes: controls, CR/LF, UTF-8 leads.
            const r = next()
            bytes[j] = r % 4 === 0 ?
                [0x0d, 0x0a, 0x09, 0x1b, 0x7f, 0xc2, 0xe2, 0xed,
                    0xf0, 0xf4, 0x80, 0x9b, 0xbf][r % 13] :
                (r >>> 8) & 0xff
        }
        for (const [mode, fnBytes, fn] of [
            [false, textBytes, text],
            [true, lineBytes, line],
        ] as const) {
            const out = fnBytes(bytes)
            const again = fnBytes(Buffer.from(out))
            if (badChar(out, mode) !== null || fn(out) !== out ||
                again !== out) {
                failures++
                if (failures < 5) {
                    t.fail(`${mode ? 'line' : 'text'} on ` +
                        Buffer.from(bytes).toString('hex'))
                }
            }
        }
    }
    t.equal(failures, 0, 'every random input sanitizes cleanly')
})
