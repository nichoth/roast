import { test } from '@substrate-system/tapzero'
import { globstarMatch } from '../../src/context/glob.js'

test('globstarMatch: ** matches zero or more segments', t => {
    const p = '**/*_test.go'
    t.ok(globstarMatch(p, 'root_test.go'), 'zero segments')
    t.ok(globstarMatch(p, 'one/one_test.go'), 'one segment')
    t.ok(globstarMatch(p, 'one/two/two_test.go'), 'two segments')
    t.ok(!globstarMatch(p, 'one/two/code.go'), 'not a non-match')
    t.ok(globstarMatch('src/**', 'src/a/b/c.ts'), 'trailing **')
    t.ok(globstarMatch('a/**/b', 'a/b'), 'middle ** matches nothing')
    t.ok(globstarMatch('a/**/b', 'a/x/y/b'), 'middle ** matches many')
})

test('globstarMatch: other segments follow path.Match', t => {
    t.ok(globstarMatch('*.go', 'main.go'))
    t.ok(!globstarMatch('*.go', 'sub/main.go'), '* stays in one segment')
    t.ok(globstarMatch('?.go', 'a.go'))
    t.ok(globstarMatch('[a-c].go', 'b.go'))
    t.ok(!globstarMatch('[^a-c].go', 'b.go'))
    t.ok(globstarMatch('\\*.go', '*.go'), 'escaped star')
    t.ok(!globstarMatch('[a-', 'a'), 'a malformed segment never matches')
})
