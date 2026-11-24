import { test } from '@substrate-system/tapzero'
import { SectionCapper } from '../../src/scope/patch.js'
import { SECTION_OMITTED_MARKER } from '../../src/scope/constants.js'

function section (name:string, body:string):string {
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${
        name}\n@@ -1 +1 @@\n${body}`
}

// Feeds `input` to a capper in chunks of `size` bytes.
function cap (input:Buffer, max:number, size:number) {
    const c = new SectionCapper(max)
    for (let i = 0; i < input.length; i += size) {
        c.write(input.subarray(i, i + size))
    }
    return c.finish()
}

test('SectionCapper keeps small sections whole and cuts the large one',
    t => {
        const small1 = section('a.go', '+one\n')
        const big = section('big.go', '+' + 'x'.repeat(5000) + '\n' +
            '+tail\n')
        const small2 = section('z.go', '+two\n')
        const input = Buffer.from(small1 + big + small2)
        for (const size of [1, 7, 100, 65536, input.length]) {
            const { out, cut } = cap(input, 1000, size)
            const text = out.toString()
            t.deepEqual(cut, ['big.go'], `cut list (chunk ${size})`)
            t.ok(text.startsWith(small1), `first section intact (${size})`)
            t.ok(text.endsWith(small2), `last section intact (${size})`)
            const bigStart = small1.length
            const bigEnd = text.length - small2.length
            const kept = text.slice(bigStart, bigEnd)
            const marker = SECTION_OMITTED_MARKER(1000)
            t.ok(kept.endsWith('\n' + marker), `marker on its own line (${
                size})`)
            t.equal(Buffer.byteLength(kept) - Buffer.byteLength(marker) - 1,
                1000, 'cut at the cap')
            t.ok(!text.includes('+tail'), 'rest of the section dropped')
        }
    })

test('SectionCapper with a huge cap returns its input unchanged', t => {
    const input = Buffer.concat([
        Buffer.from('preamble\n'),
        Buffer.from(section('a.go', '+\u00e9\n')),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from(section('b.go', '+x')),
    ])
    const { out, cut } = cap(input, 1e9, 3)
    t.ok(out.equals(input), 'byte-identical')
    t.deepEqual(cut, [], 'nothing cut')
})

test('SectionCapper names a cut section that is not a/P b/P', t => {
    const input = Buffer.from('diff --git a/x b/y\n' + 'z'.repeat(50))
    const { out, cut } = cap(input, 10, 4)
    t.deepEqual(cut, ['a/x b/y'], 'raw header remainder')
    t.ok(out.toString().endsWith('\n' + SECTION_OMITTED_MARKER(10)),
        'marker')
})
