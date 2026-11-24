import { test } from '@substrate-system/tapzero'
import {
    buildFileContext,
    numberedSnippet,
} from '../../src/context/snippet.js'
import { LIVE_TREE, pinnedWorktree } from '../../src/context/tree.js'
import { newRepo } from '../scope/helpers.js'

// The 1-indexed line numbers a snippet shows, in order.
function shownLines (snippet:string):number[] {
    const out:number[] = []
    for (const l of snippet.split('\n')) {
        const m = /^ *(\d+) {2}/.exec(l)
        if (m) out.push(Number(m[1]))
    }
    return out
}

test('numberedSnippet middle-truncates keeping both ends', async t => {
    const repo = newRepo()
    let content = ''
    for (let i = 1; i <= 200; i++) {
        content += `line ${i} content here for padding to make it long\n`
    }
    repo.write('big.go', content)
    const s = await numberedSnippet(repo.dir, 'big.go', 2000, LIVE_TREE,
        { env:repo.env })
    const nums = shownLines(s)
    t.equal(nums[0], 1, 'head starts at line 1')
    t.equal(nums[nums.length - 1], 200, 'tail ends at the last line')
    const gap = nums.findIndex((n, i) => i > 0 && n !== nums[i - 1] + 1)
    t.ok(gap > 0, 'there is an omitted middle')
    const omitted = /\((\d+) lines omitted/.exec(s)
    t.equal(Number(omitted?.[1]), nums[gap] - nums[gap - 1] - 1,
        'the omission marker counts the skipped lines')
    t.ok(s.includes(`  ${nums[gap]}  line ${nums[gap]} content`),
        'tail lines carry their real numbers')

    const whole = await numberedSnippet(repo.dir, 'big.go', 100000,
        LIVE_TREE, { env:repo.env })
    t.deepEqual(shownLines(whole), Array.from({ length:200 }, (_, i) => i + 1),
        'a file under maxBytes is shown whole')
    repo.cleanup()
})

test('captured-worktree ceiling header differs from the live one',
    async t => {
        const repo = newRepo()
        repo.write('large.go', 'package p\n' +
            'var captured = 1\n'.repeat(2000))
        repo.git('add', 'large.go')
        const tree = pinnedWorktree(repo.git('write-tree').trim())
        const opts = { env:repo.env }
        const captured = await numberedSnippet(repo.dir, 'large.go', 100,
            tree, opts)
        const live = await numberedSnippet(repo.dir, 'large.go', 100,
            LIVE_TREE, opts)
        const header = (s:string) => s.split('\n')[0]
        t.ok(header(captured).startsWith('### large.go ('),
            'captured snippet has a ceiling header')
        t.notEqual(header(captured), header(live),
            'captured and live ceiling headers differ')
        t.equal(shownLines(captured)[0], 1, 'captured content is shown')
        repo.cleanup()
    })

test('buildFileContext skips files over budget and continues', async t => {
    const repo = newRepo()
    repo.write('big.go', 'x'.repeat(2000) + '\n')
    repo.write('small.go', 'package p\n')
    const opts = { env:repo.env }
    const out = await buildFileContext(repo.dir, ['big.go', 'small.go'],
        100, LIVE_TREE, opts)
    const small = await numberedSnippet(repo.dir, 'small.go', 120000,
        LIVE_TREE, opts)
    t.ok(out.includes(small), 'the later small file is included whole')
    t.ok(!out.includes('xxxxxxxxxx'), 'the big file content is omitted')
    t.ok(out.includes('### big.go\n'), 'the big file is still named')

    const empty = await buildFileContext(repo.dir, [], 100, LIVE_TREE, opts)
    t.equal(empty, '(no files)', 'an empty list yields the empty marker')
    repo.cleanup()
})
