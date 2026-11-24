import { test } from '@substrate-system/tapzero'
import { goPathMatch } from '../../src/gocompat/match.js'

// [pattern, name, want], mostly from Go's path.Match test table.
const CASES:[string, string, boolean][] = [
    ['abc', 'abc', true],
    ['*', 'abc', true],
    ['*c', 'abc', true],
    ['a*', 'a', true],
    ['a*', 'abc', true],
    ['a*', 'ab/c', false],
    ['a*/b', 'abc/b', true],
    ['a*/b', 'a/c/b', false],
    ['a*b*c*d*e*/f', 'axbxcxdxe/f', true],
    ['a*b*c*d*e*/f', 'axbxcxdxexxx/f', true],
    ['a*b*c*d*e*/f', 'axbxcxdxe/xxx/f', false],
    ['a*b*c*d*e*/f', 'axbxcxdxexxx/fff', false],
    ['a*b?c*x', 'abxbbxdbxebxczzx', true],
    ['a*b?c*x', 'abxbbxdbxebxczzy', false],
    ['ab[c]', 'abc', true],
    ['ab[b-d]', 'abc', true],
    ['ab[e-g]', 'abc', false],
    ['ab[^c]', 'abc', false],
    ['ab[^b-d]', 'abc', false],
    ['ab[^e-g]', 'abc', true],
    ['a\\*b', 'a*b', true],
    ['a\\*b', 'ab', false],
    ['a?b', 'a\u263ab', true],
    ['a[^a]b', 'a\u263ab', true],
    ['a???b', 'a\u263ab', false],
    ['a[^a][^a][^a]b', 'a\u263ab', false],
    ['[a-\u03b6]*', '\u03b1', true],
    ['*[a-\u03b6]', 'A', false],
    ['a?b', 'a/b', false],
    ['a*b', 'a/b', false],
    ['[\\]a]', ']', true],
    ['[\\-]', '-', true],
    ['[x\\-]', 'x', true],
    ['[x\\-]', '-', true],
    ['[x\\-]', 'z', false],
    ['[\\-x]', 'x', true],
    ['[\\-x]', '-', true],
    ['[\\-x]', 'a', false],
    ['*x', 'xxx', true],
    ['*.env', '.env', true],
    ['*.pem', 'dir/key.pem', false],
    ['id_rsa*', 'id_rsa.pub', true],
]

// Malformed patterns: Go returns ErrBadPattern, so they never match.
const BAD:[string, string][] = [
    ['[]a]', ']'],
    ['[-]', '-'],
    ['[x-]', 'x'],
    ['[x-]', '-'],
    ['[x-]', 'z'],
    ['[-x]', 'x'],
    ['[-x]', '-'],
    ['[-x]', 'a'],
    ['\\', 'a'],
    ['[a-b-c]', 'a'],
    ['[', 'a'],
    ['[^', 'a'],
    ['[^bc', 'a'],
    ['a[', 'a'],
    ['a[', 'ab'],
    ['a[', 'x'],
    ['a/b[', 'x'],
    ['*x[', 'xxx'],
    ['a\\', 'a'],
]

test('goPathMatch follows Go path.Match', t => {
    for (const [pattern, name, want] of CASES) {
        t.equal(goPathMatch(pattern, name), want,
            `${pattern} vs ${name} -> ${want}`)
    }
})

test('goPathMatch never matches with a malformed pattern', t => {
    for (const [pattern, name] of BAD) {
        t.equal(goPathMatch(pattern, name), false, `${pattern} vs ${name}`)
    }
})
