import { test } from '@substrate-system/tapzero'
import {
    formatFixed2,
    goTrimSpace,
    isGoSpace,
    goExt,
    truncateUtf8,
    compareBytes,
    goQuote,
} from '../../src/gocompat/strings.js'

test('formatFixed2 rounds exact ties half to even like Go %.2f', t => {
    const cases:[number, string][] = [
        [0.125, '0.12'],
        [0.375, '0.38'],
        [0.625, '0.62'],
        [0.875, '0.88'],
        [-0.125, '-0.12'],
        [-0.375, '-0.38'],
        [-0.625, '-0.62'],
        [-0.875, '-0.88'],
        [0, '0.00'],
        [1, '1.00'],
        [0.5, '0.50'],
        [0.9, '0.90'],
        [0.333, '0.33'],
        [0.666, '0.67'],
        [2.125, '2.12'],
    ]
    for (const [x, want] of cases) {
        t.equal(formatFixed2(x), want, String(x))
    }
})

test('goTrimSpace trims Go unicode.IsSpace, not JS whitespace', t => {
    t.equal(goTrimSpace('\u0085 x \u0085'), 'x', 'U+0085 is trimmed')
    t.equal(goTrimSpace('\ufeffx\ufeff'), '\ufeffx\ufeff',
        'U+FEFF is not trimmed')
    t.equal(goTrimSpace('\t\n\v\f\r \u00a0\u3000x\u2028\u2029\u205f'), 'x',
        'ASCII, NBSP, ideographic, and separators are trimmed')
    t.equal(goTrimSpace('a b'), 'a b', 'inner space kept')
    t.equal(goTrimSpace('   '), '', 'all space becomes empty')
    t.ok(isGoSpace(0x1680), 'U+1680 is space')
    t.ok(!isGoSpace(0x200b), 'U+200B is not space')
    t.ok(!isGoSpace(0x180e), 'U+180E is not space')
})

test('goExt follows Go filepath.Ext', t => {
    const cases:[string, string][] = [
        ['docs/.md', '.md'],
        ['file.', '.'],
        ['a/b.tar.gz', '.gz'],
        ['a.b/c', ''],
        ['Makefile', ''],
        ['.bashrc', '.bashrc'],
        ['', ''],
    ]
    for (const [p, want] of cases) t.equal(goExt(p), want, p)
})

test('truncateUtf8 measures bytes and never splits a code point', t => {
    t.equal(truncateUtf8('hello', 3), 'hel', 'ASCII cut')
    t.equal(truncateUtf8('hello', 10), 'hello', 'short input unchanged')
    t.equal(truncateUtf8('\u00e9\u00e9', 3), '\u00e9',
        'a two-byte character is not split')
    t.equal(truncateUtf8('a\u20ac', 3), 'a', 'a three-byte character')
    t.equal(truncateUtf8('a\u{1f600}b', 4), 'a', 'a four-byte character')
    t.equal(truncateUtf8('a\u{1f600}b', 5), 'a\u{1f600}', 'fits exactly')
    t.equal(truncateUtf8('abc', 0), '', 'zero bytes')
})

test('compareBytes orders by UTF-8 bytes', t => {
    const supp = '\u{10000}'
    const bmpTop = '\uffff'
    t.ok(supp < bmpTop, 'JS < puts the supplementary character first')
    t.ok(compareBytes(bmpTop, supp) < 0, 'U+FFFF sorts before U+10000')
    t.ok(compareBytes(supp, bmpTop) > 0, 'and the reverse')
    t.equal(compareBytes('a', 'a'), 0, 'equal strings')
    t.ok(compareBytes('a', 'ab') < 0, 'prefix sorts first')
    t.ok(compareBytes('B', 'a') < 0, 'byte order, not locale order')
    t.deepEqual(['\uffff', 'b', '\u{1f600}', 'a'].sort(compareBytes),
        ['a', 'b', '\uffff', '\u{1f600}'], 'sort helper')
})

test('goQuote matches Go strconv.Quote', t => {
    const cases:[string, string][] = [
        ['plain', '"plain"'],
        ['say "hi"', '"say \\"hi\\""'],
        ['back\\slash', '"back\\\\slash"'],
        ['\x07\b\f\n\r\t\v', '"\\a\\b\\f\\n\\r\\t\\v"'],
        ['nul\x00 esc\x1b del\x7f', '"nul\\x00 esc\\x1b del\\x7f"'],
        ['c1\u0085', '"c1\\u0085"'],
        ['nbsp\u00a0', '"nbsp\\u00a0"'],
        ['zwsp\u200b', '"zwsp\\u200b"'],
        ['ls\u2028', '"ls\\u2028"'],
        ['bom\ufeff', '"bom\\ufeff"'],
        ['tag\u{e0001}', '"tag\\U000e0001"'],
        ['caf\u00e9 \u2713 \u{1f600}', '"caf\u00e9 \u2713 \u{1f600}"'],
        ['<a>', '"<a>"'],
        ['hex\u00ff', '"hex\u00ff"'],
    ]
    for (const [s, want] of cases) t.equal(goQuote(s), want, want)
})
