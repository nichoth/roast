import { test } from '@substrate-system/tapzero'
import {
    classifyMode,
    classifyLangs,
    resolveLangs,
} from '../../src/review/classify.js'
import { UsageError } from '../../src/cli/errors.js'

// ---- classifyMode ----

test('classifyMode returns code for empty list', t => {
    t.equal(classifyMode([]), 'code')
})

test('classifyMode returns prose when every extension is prose', t => {
    t.equal(classifyMode(['a.md', 'b.txt']), 'prose')
    t.equal(classifyMode(['README.MARKDOWN', 'doc.MDX']), 'prose')
    t.equal(classifyMode(['x.adoc', 'y.rst', 'z.tex']), 'prose')
})

test('classifyMode returns mixed when some are prose', t => {
    t.equal(classifyMode(['a.md', 'b.go']), 'mixed')
    t.equal(classifyMode(['README.txt', 'src/main.ts']), 'mixed')
})

test('classifyMode returns code when none are prose', t => {
    t.equal(classifyMode(['a.go', 'b.tsx']), 'code')
    t.equal(classifyMode(['Makefile']), 'code')
    t.equal(classifyMode(['build.sh']), 'code')
})

test('classifyMode compares extensions case-insensitively', t => {
    t.equal(classifyMode(['a.MD', 'b.TXT']), 'prose')
    t.equal(classifyMode(['a.RST', 'b.GO']), 'mixed')
})

test('classifyMode treats dotfile dots as extension separators (Go Ext)', t => {
    // docs/.md -> ext is .md, which is prose
    t.equal(classifyMode(['docs/.md', 'src/main.go']), 'mixed')
    t.equal(classifyMode(['docs/.mdx']), 'prose')
    // A file whose last dot is the only one in the last path element:
    // extension is "." (code)
    t.equal(classifyMode(['file.']), 'code')
})

test('classifyMode handles dotfiles without a prose extension', t => {
    // .bashrc -> ext is ".bashrc" which is unknown -> code
    t.equal(classifyMode(['.bashrc']), 'code')
    t.equal(classifyMode(['.bashrc', 'README.md']), 'mixed')
})

// ---- classifyLangs ----

test('classifyLangs maps extensions to language tags', t => {
    const langs = classifyLangs([
        'app.tsx', 'comp.jsx',
        'page.vue', 'widget.svelte',
        'index.js', 'style.css',
        'cmd/main.go',
    ])
    t.deepEqual(langs, ['frontend', 'go', 'react', 'web'])
})

test('classifyLangs dedupes and sorts', t => {
    const langs = classifyLangs([
        'a.tsx', 'b.ts', 'c.tsx', 'd.ts',
    ])
    t.deepEqual(langs, ['react', 'web'])
})

test('classifyLangs ignores unknown extensions', t => {
    const langs = classifyLangs(['Makefile', '.bashrc', 'README.md'])
    t.deepEqual(langs, [])
})

test('classifyLangs returns [] for empty input', t => {
    t.deepEqual(classifyLangs([]), [])
})

// Extension grouping tests from the table.
test('classifyLangs: .tsx/.jsx -> react', t => {
    t.deepEqual(classifyLangs(['a.tsx', 'b.jsx']), ['react'])
})

test('classifyLangs: .vue/.svelte/.astro -> frontend', t => {
    t.deepEqual(classifyLangs(['a.vue', 'b.svelte', 'c.astro']), ['frontend'])
})

test('classifyLangs: .ts/.js/.mjs/.cjs/.css/.scss -> web', t => {
    t.deepEqual(classifyLangs([
        'a.ts', 'b.js', 'c.mjs', 'd.cjs', 'e.css', 'f.scss',
    ]), ['web'])
})

test('classifyLangs: .go -> go', t => {
    t.deepEqual(classifyLangs(['main.go']), ['go'])
})

// Dotfile extensions (uses goExt, not path.extname).
test('classifyLangs: dotfiles with mapped extensions classify correctly', t => {
    // .tsx -> react
    t.deepEqual(classifyLangs(['.tsx']), ['react'])
    // .md is prose but not in the lang table
    t.deepEqual(classifyLangs(['README.md']), [])
})

// ---- resolveLangs ----

test('resolveLangs returns [] for prose mode (flags ignored)', t => {
    t.deepEqual(resolveLangs(['go'], [], 'prose'), [])
    t.deepEqual(resolveLangs(['none'], [], 'prose'), [])
    t.deepEqual(resolveLangs(['unknown-stuff'], [], 'prose'), [])
})

test('resolveLangs auto-classifies with no flag values', t => {
    const langs = resolveLangs([], ['a.tsx', 'b.vue', 'c.go'], 'code')
    t.deepEqual(langs, ['frontend', 'go', 'react'])
})

test('resolveLangs: lone "none" returns []', t => {
    t.deepEqual(resolveLangs(['none'], [], 'code'), [])
})

test('resolveLangs: "none" combined with another pack throws UsageError', t => {
    let caught:unknown
    try { resolveLangs(['none', 'go'], [], 'code') } catch (e) { caught = e }
    t.ok(caught instanceof Error, 'throws an error')
    t.ok(caught instanceof UsageError, 'a UsageError')
    if (caught instanceof Error) {
        t.equal(
            caught.message,
            '--lang none cannot be combined with another language pack',
            'correct message',
        )
    }
})

test('resolveLangs: unknown pack throws UsageError (case-sensitive)', t => {
    let caught:Error|undefined
    try { resolveLangs(['react-native'], [], 'code') } catch (e) { caught = e as Error }
    t.ok(caught instanceof UsageError, 'a UsageError')
    t.equal(caught!.message, 'unknown language pack "react-native"')
})

test('resolveLangs: no trimming — case-sensitive on input', t => {
    // "go" is known; "Go" is not.
    let caught1:Error|undefined
    try { resolveLangs(['Go'], [], 'code') } catch (e) { caught1 = e as Error }
    t.ok(caught1 instanceof UsageError, '"Go" is unknown (case-sensitive)')
    t.equal(caught1!.message, 'unknown language pack "Go"')

    // A space-prefixed value is not trimmed.
    let caught2:Error|undefined
    try { resolveLangs([' go'], [], 'code') } catch (e) { caught2 = e as Error }
    t.ok(caught2 instanceof UsageError, '" go" is unknown (no trimming)')
    t.equal(caught2!.message, 'unknown language pack " go"')
})

test('resolveLangs: keeps flag order and duplicates', t => {
    t.deepEqual(resolveLangs(['go', 'react', 'go'], [], 'code'), ['go', 'react', 'go'])
    t.deepEqual(resolveLangs(['web', 'frontend'], [], 'code'), ['web', 'frontend'])
})

test('resolveLangs: auto-classification keeps result order from classifyLangs', t => {
    const langs = resolveLangs([], ['src/app.tsx', 'lib/util.go'], 'mixed')
    t.deepEqual(langs, ['go', 'react'])
})
