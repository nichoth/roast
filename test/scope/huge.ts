import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import { build } from '../../src/scope/index.js'
import { newRepo } from './helpers.js'

const LINE = 'a b c d e f g h\n'
const LINES = 1_500_000
const HUGE = LINE.length * LINES // 24 MB

// V8 frees discarded pipe chunks only when external memory crosses a
// soft limit, and the allocator keeps freed pages, so RSS mostly
// reflects GC timing. The sampler collects first and tracks both RSS
// and live memory (heap plus external buffers), which is what a build
// that buffered a file whole would grow.
v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void

interface Usage {
    rss:number;
    live:number;
}

function usage ():Usage {
    gc()
    const m = process.memoryUsage()
    return { rss:m.rss, live:m.heapUsed + m.external }
}

// Writes the huge file in small chunks, so the test itself never holds it.
function writeHuge (file:string):void {
    const chunk = Buffer.from(LINE.repeat(4096))
    const fd = fs.openSync(file, 'w')
    let left = LINES
    while (left > 0) {
        const n = Math.min(4096, left)
        fs.writeSync(fd, chunk, 0, n * LINE.length)
        left -= n
    }
    fs.closeSync(fd)
}

test('huge files are cut at the cap without being buffered whole',
    async t => {
        const repo = newRepo()
        repo.git('branch', 'base')
        writeHuge(path.join(repo.dir, 'data.txt'))
        repo.commitAll('big')
        writeHuge(path.join(repo.dir, 'untracked.txt'))
        repo.write('small.go', 'package a\n\nfunc Small() {}\n')

        const cap = 64 * 1024
        const before = usage()
        const peak = { ...before }
        const sample = () => {
            const u = usage()
            peak.rss = Math.max(peak.rss, u.rss)
            peak.live = Math.max(peak.live, u.live)
        }
        const timer = setInterval(sample, 2)
        const s = await build(repo.dir, {
            base:'base',
            maxFileDiffBytes:cap,
            env:repo.env,
        })
        clearInterval(timer)
        sample()

        t.ok(s.diffBytes.length < 4 * cap, 'diff under 4x the cap')
        const markers = s.diff.split('\\ roast: the rest of this file')
            .length - 1
        t.equal(markers, 2, 'two omission markers')
        t.ok(s.diff.includes('+func Small() {}'), 'small file intact')
        const notes = s.notes.join('\n')
        t.ok(notes.includes('data.txt') && notes.includes('untracked.txt'),
            'notes name both cut files')
        t.deepEqual([...s.files], ['data.txt', 'small.go', 'untracked.txt'],
            'all three in files')
        const live = peak.live - before.live
        t.ok(live < HUGE / 8, `peak live memory growth ${live} well ` +
            `below ${HUGE}`)
        const rss = peak.rss - before.rss
        t.ok(rss < HUGE, `peak RSS growth ${rss} below ${HUGE}`)
        repo.cleanup()
    })
