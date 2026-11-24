import { test } from '@substrate-system/tapzero'
import {
    newQuoteGrounder,
    normalizedDiffSides,
} from '../../src/context/grounding.js'
import { LIVE_TREE } from '../../src/context/tree.js'
import { newRepo } from '../scope/helpers.js'
import { fieldsReference, rng } from './helpers.js'

test('grounder: file, diff sections, sides, and keys', async t => {
    const repo = newRepo()
    repo.write('a.go', 'func Foo() {\n\treturn\tbar(1,\n\t\t2)\n}\n')
    const opts = { env:repo.env }
    const ground = (diff:string) =>
        newQuoteGrounder(repo.dir, LIVE_TREE, Buffer.from(diff), opts)
    const g = ground('diff --git a/b.go b/b.go\n--- a/b.go\n+++ b/b.go\n' +
        '@@ -1 +0,0 @@\n-deletedLine := old()\n' +
        'diff --git a/c.go b/c.go\n--- a/c.go\n+++ b/c.go\n' +
        '@@ -0,0 +1 @@\n+addedLine := new()\n')

    t.ok(await g('a.go', 'func Foo() {'), 'exact quote grounds')
    t.ok(await g('a.go', 'return bar(1, 2)'), 'whitespace variant grounds')
    t.ok(await g('b.go', 'deletedLine := old()'),
        'deleted code grounds via its own section')
    t.ok(!(await g('a.go', 'deletedLine := old()')),
        'diff content does not ground another file')
    t.ok(!(await g('missing.go', 'addedLine := new()')),
        'diff content does not ground a fabricated path')
    t.ok(!(await g('a.go', 'func Bar() { panic("nope") }')),
        'confabulated quote does not ground')
    t.ok(!(await g('a.go', '  \t\n ')), 'empty quote does not ground')

    const replace = 'diff --git a/d.go b/d.go\n--- a/d.go\n+++ b/d.go\n' +
        '@@ -1 +1 @@\n-oldCall()\n+newCall()\n'
    const gd = ground(replace)
    t.ok(!(await gd('d.go', 'oldCall() newCall()')),
        'hybrid -/+ quote does not ground')
    t.ok(await gd('d.go', 'oldCall()') && await gd('d.go', 'newCall()'),
        'each side grounds alone')
    t.ok(!(await gd('d.go', 'oldCall() \u0000 newCall()')),
        'a NUL-carrying quote does not bridge sentinels')

    const ge = ground('diff --git a/e.go b/e.go\n--- a/e.go\n+++ b/e.go\n' +
        '@@ -1,3 +1,3 @@\n ctx1()\n-oldA()\n+newA()\n ctx2()\n')
    t.ok(await ge('e.go', 'oldA()\nctx2()'),
        'old-side multiline quote grounds across an interleave')
    t.ok(await ge('e.go', 'ctx1()\nnewA()\nctx2()'),
        'new-side quote with context grounds')

    const gh = ground('diff --git a/real.go b/real.go\n--- a/real.go\n' +
        '+++ b/real.go\n@@ -1,2 +1 @@\n--- a/other.go\n realContent := 1\n')
    t.ok(!(await gh('other.go', 'realContent := 1')),
        'header-shaped hunk line does not steal the key')
    t.ok(await gh('real.go', 'realContent := 1'), 'section keeps its key')
    t.ok(await gh('real.go', '-- a/other.go'),
        'the deleted line is old-side content')

    const gq = ground('diff --git "a/f\\303\\266.go" "b/f\\303\\266.go"\n' +
        '--- "a/f\\303\\266.go"\n+++ "b/f\\303\\266.go"\n' +
        '@@ -1 +0,0 @@\n-umlautGone := 1\n')
    t.ok(await gq('f\u00f6.go', 'umlautGone := 1'),
        'git-quoted path keys its section')
    t.ok(!(await gq('other.go', 'umlautGone := 1')),
        'quoted section does not ground another file')
    repo.cleanup()
})

test('grounder matches diff bytes, not decoded text', async t => {
    const repo = newRepo()
    const diff = Buffer.concat([
        Buffer.from('diff --git a/x.go b/x.go\n--- a/x.go\n+++ b/x.go\n' +
            '@@ -0,0 +1 @@\n+s := "\u00e9'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"\n'),
    ])
    const g = newQuoteGrounder(repo.dir, LIVE_TREE, diff, { env:repo.env })
    // A quote string cannot hold 0xff; U+FFFD stands where it would be.
    t.ok(!(await g('x.go', 's := "\u00e9\ufffd\ufffd"')),
        'U+FFFD does not stand in for invalid bytes')
    t.ok(await g('x.go', 's  :=  "\u00e9'),
        'the same bytes ground, next to the invalid ones')
    repo.cleanup()
})

// normalizedDiffSides as written before it streamed: raw sides first,
// then strings.Fields.
function referenceDiffSides (s:Buffer):Buffer {
    const oldSide:Buffer[] = []
    const newSide:Buffer[] = []
    const nl = Buffer.from('\n')
    const sentinel = (b:Buffer[]) => {
        if (b.length > 0) b.push(Buffer.from('\n\u0000\n'))
    }
    let inHunk = false
    let start = 0
    for (;;) {
        const end = s.indexOf(0x0a, start)
        const l = s.subarray(start, end === -1 ? s.length : end)
        const text = l.toString('latin1')
        if (text.startsWith('@@')) {
            sentinel(oldSide)
            sentinel(newSide)
            inHunk = true
        } else if (text.startsWith('diff --git ')) {
            inHunk = false
        } else if (inHunk && l.length > 0) {
            const rest = l.subarray(1)
            if (text[0] === ' ') {
                oldSide.push(rest, nl)
                newSide.push(rest, nl)
            } else if (text[0] === '-') {
                oldSide.push(rest, nl)
            } else if (text[0] === '+') {
                newSide.push(rest, nl)
            }
        }
        if (end === -1) break
        start = end + 1
    }
    const o = fieldsReference(Buffer.concat(oldSide))
    const n = fieldsReference(Buffer.concat(newSide))
    if (o.length === 0) return n
    if (n.length === 0) return o
    return Buffer.concat([o, Buffer.from(' \u0000 '), n])
}

test('normalizedDiffSides equals the reference', t => {
    const lines = [
        '@@ -1 +1 @@', 'diff --git a/x b/x', ' ctx  line', '-old\tline',
        '+new line', '+', '-', ' ', '\\ No newline at end of file', '',
        '+   ', '--- a/x', '+++ b/x',
    ].map(l => Buffer.from(l))
        .concat([Buffer.from([0x2b, 0xe2]), Buffer.from('-\u0080 tail')])
        .concat([Buffer.from([0x2d, 0x80, 0x20, 0x74])])
    const r = rng(2)
    let bad = 0
    for (let i = 0; i < 3000; i++) {
        const parts:Buffer[] = []
        for (let j = r(12); j > 0; j--) {
            if (parts.length > 0) parts.push(Buffer.from('\n'))
            parts.push(lines[r(lines.length)])
        }
        const s = Buffer.concat(parts)
        if (!normalizedDiffSides(s).equals(referenceDiffSides(s))) {
            bad++
            if (bad === 1) t.fail(`normalizedDiffSides(${s.toString('hex')})`)
        }
    }
    t.equal(bad, 0, 'streamed sides match the reference')
})
