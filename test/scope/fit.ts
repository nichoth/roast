import { test } from '@substrate-system/tapzero'
import { build, fit } from '../../src/scope/index.js'
import { newRepo } from './helpers.js'

test('fit truncates with a descending breakdown', async t => {
    const repo = newRepo()
    const big = 'x'.repeat(500) + '\n'
    repo.write('big.go', big)
    repo.write('small.go', 'y\n')
    repo.write('mid.go', 'z'.repeat(100) + '\n')
    repo.commitAll()
    repo.write('big.go', big + '// modified\n')
    repo.write('small.go', 'y\n// modified\n')
    repo.write('mid.go', 'z'.repeat(100) + '\n// modified\n')
    repo.git('add', '.')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(s.diffBytes.length > 100, 'diff larger than the budget')

    const same = fit(s, s.diffBytes.length)
    t.equal(same.breakdown, null, 'no breakdown within budget')
    t.equal(same.scope.diff, s.diff, 'unchanged within budget')

    const { scope, breakdown } = fit(s, 100)
    t.ok(scope.diffBytes.subarray(0, 100).equals(s.diffBytes.subarray(0,
        100)), 'keeps the first maxBytes bytes')
    t.ok(scope.diff.endsWith('\n... (diff truncated)\n'), 'marker')
    t.equal(scope.diff, scope.diffBytes.toString('utf8'), 'diff decodes')
    t.equal(scope.notes.length, s.notes.length + 1, 'note added')
    t.equal(s.diff.includes('(diff truncated)'), false, 'input untouched')
    t.deepEqual(breakdown?.map(e => e.path), ['big.go', 'mid.go',
        'small.go'], 'largest first')
    for (const e of breakdown ?? []) t.ok(e.bytes > 0, `${e.path} counted`)
    repo.cleanup()
})

test('fit keeps files order for equal sizes', async t => {
    const repo = newRepo()
    const names = ['d.go', 'a.go', 'c.go', 'b.go']
    for (const n of names) repo.write(n, 'same\n')
    // The last section keeps its trailing newline; make it the largest.
    repo.write('z.go', 'other\n')
    repo.commitAll()
    for (const n of names) repo.write(n, 'same\nedit\n')
    repo.write('z.go', 'other\nlonger edit\n')
    repo.git('add', '.')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    const { breakdown } = fit(s, 10)
    const ties = breakdown?.slice(1) ?? []
    t.equal(breakdown?.[0].path, 'z.go', 'largest first')
    t.equal(new Set(ties.map(e => e.bytes)).size, 1, 'the rest are equal')
    t.deepEqual(ties.map(e => e.path), ['a.go', 'b.go', 'c.go', 'd.go'],
        'ties keep files order')
    repo.cleanup()
})
