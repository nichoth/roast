import { test } from '@substrate-system/tapzero'
import { globMatch, untrackedPasses } from '../../src/scope/glob.js'

test('globMatch cases from spec 2.14', t => {
    const cases:[string, string, boolean][] = [
        ['vendor/foo/bar.go', 'vendor/**', true],
        ['node_modules/dep.js', 'node_modules/**', true],
        ['a/node_modules/dep.js', '**/node_modules/**', true],
        ['node_modules/dep.js', '**/node_modules/**', true],
        ['foo.lock', '*.lock', true],
        ['go.sum', 'go.sum', true],
        ['foo.pb.go', '*.pb.go', true],
        ['keep.go', '*.pb.go', false],
        ['keep.go', 'vendor/**', false],
        // `*` crosses `/` (fnmatch semantics).
        ['a/b/c.min.js', '*.min.js', true],
        // `?` is one character, including a non-BMP one.
        ['a\u{1f600}c', 'a?c', true],
        ['abbc', 'a?c', false],
        // `.` and `[` are literal.
        ['fooxgo', 'foo.go', false],
        ['[a].go', '[a].go', true],
        ['a.go', '[a].go', false],
        // `.` in the pattern never matches a newline.
        ['a\nb', 'a?b', false],
    ]
    for (const [p, pat, want] of cases) {
        t.equal(globMatch(p, pat), want, `globMatch(${JSON.stringify(p)}, ${
            JSON.stringify(pat)})`)
    }
})

test('untrackedPasses applies excludes, then paths', t => {
    t.ok(untrackedPasses('a.go', [], []), 'no filters')
    t.ok(!untrackedPasses('vendor/x.go', [], ['vendor/**']), 'excluded')
    t.ok(!untrackedPasses('src/a.go', ['src/**'], ['*.go']),
        'exclude wins over path')
    t.ok(untrackedPasses('src/a.go', ['src/**'], []), 'path glob')
    t.ok(untrackedPasses('src/sub/a.go', ['src'], []), 'bare directory')
    t.ok(untrackedPasses('src/sub/a.go', ['src/'], []),
        'bare directory with slash')
    t.ok(!untrackedPasses('srcx/a.go', ['src'], []), 'prefix is not a dir')
    t.ok(!untrackedPasses('src/a.go', ['sr?'], []),
        'a glob does not select a subtree')
    t.ok(!untrackedPasses('other.go', ['src'], []), 'not selected')
})
