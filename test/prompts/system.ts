import { test } from '../helpers/test.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDir } from '../helpers/repo.js'
import { UsageError } from '../../src/cli/errors.js'
import { finderSystem, verifierSystem } from '../../src/prompts/index.js'
import core from '../../src/prompts/templates/finder_core.tmpl'
import prose from '../../src/prompts/templates/finder_prose.tmpl'
import diff from '../../src/prompts/templates/finder_scope_diff.tmpl'
import survey from
    '../../src/prompts/templates/finder_scope_survey.tmpl'
import mixed from
    '../../src/prompts/templates/finder_mixed_addendum.tmpl'
import go from '../../src/prompts/templates/finder_go_addendum.tmpl'
import frontend from
    '../../src/prompts/templates/finder_frontend_addendum.tmpl'
import hooks from
    '../../src/prompts/templates/finder_react_hooks_addendum.tmpl'
import quick from
    '../../src/prompts/templates/finder_quick_addendum.tmpl'
import verifier from
    '../../src/prompts/templates/verifier_system.tmpl'

const CASES = [
    { mode:'prose', scope:'diff', pieces:[prose] },
    { mode:'prose', scope:'repo', pieces:[prose, survey] },
    { mode:'code', scope:'diff', pieces:[core, diff] },
    { mode:'code', scope:'repo', pieces:[core, survey] },
    { mode:'mixed', scope:'diff', pieces:[core, diff, mixed] },
    { mode:'mixed', scope:'repo', pieces:[core, survey, mixed] },
    { mode:'unknown', scope:'unknown', pieces:[core, diff] },
    { mode:'code', scope:'', pieces:[core, diff] },
]

for (const { mode, scope, pieces } of CASES) {
    test(`finder system assembles ${mode}/${scope} assets`, async t => {
        const output = await finderSystem(mode, scope, false, [], '', true)
        let end = 0
        for (const piece of pieces) {
            const index = output.indexOf(piece)
            t.equal(index, end, 'asset follows the previous asset verbatim')
            end += piece.length
        }
        t.equal(output.length, end, 'contains only the selected assets')
        for (const asset of [core, prose, diff, survey, mixed]) {
            if (!pieces.includes(asset)) {
                t.ok(!output.includes(asset), 'unselected asset is absent')
            }
        }
    })
}

test('finder override replaces only the base verbatim', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const path = join(dir.dir, 'finder.tmpl')
    for (const override of [' \r\n{{.Task}}</claim>\u00e9\n\t', '']) {
        await writeFile(path, override)
        for (const { mode, scope, pieces } of CASES) {
            const output = await finderSystem(
                mode, scope, true, ['react', 'go', 'frontend'], path, true,
            )
            t.equal(output.slice(0, override.length), override,
                'override is neither trimmed, rendered, nor defanged')
            let end = override.length
            const suffix = pieces.slice(1)
            if (mode !== 'prose') suffix.push(go, frontend, hooks)
            suffix.push(quick)
            for (const piece of suffix) {
                t.equal(output.indexOf(piece), end,
                    'Roast-controlled asset follows override in order')
                end += piece.length
            }
            t.equal(output.length, end, 'only the base is replaced')
            t.ok(!output.includes(core), 'original code base is absent')
            t.ok(!output.includes(prose), 'original prose base is absent')
        }
    }
})

test('finder override read failures are ordinary errors', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    for (const mode of ['prose', 'code', 'mixed', 'unknown']) {
        for (const path of [join(dir.dir, 'missing'), dir.dir]) {
            let caught:unknown
            try {
                await finderSystem(mode, 'diff', false, [], path, true)
            } catch (error) {
                caught = error
            }
            t.ok(caught instanceof Error, 'read failure rejects')
            t.ok(!(caught instanceof UsageError), 'not a usage error')
            if (caught instanceof Error) {
                const kind = mode === 'prose' ? 'prose' : 'core'
                t.ok(caught.message.startsWith(
                    `finder ${kind} prompt: prompt override ${path}: `,
                ), 'error has the specified finder context')
            }
        }
    }
})

test('verifier defaults to its system asset', async t => {
    t.equal(await verifierSystem(''), verifier)
})

test('verifier override is used verbatim, including empty files', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const path = join(dir.dir, 'verifier.tmpl')
    for (const override of [' \r\n{{.Task}}</claim>\u00e9\n\t', '']) {
        await writeFile(path, override)
        t.equal(await verifierSystem(path), override,
            'no trimming, rendering, defanging, or fallback for empty text')
    }
})

test('verifier override read failures are ordinary errors', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    for (const path of [join(dir.dir, 'missing'), dir.dir]) {
        let caught:unknown
        try {
            await verifierSystem(path)
        } catch (error) {
            caught = error
        }
        t.ok(caught instanceof Error, 'read failure rejects')
        t.ok(!(caught instanceof UsageError), 'not a usage error')
        if (caught instanceof Error) {
            t.ok(caught.message.startsWith(`prompt override ${path}: `),
                'error starts with the override context')
        }
    }
})

const LANGUAGE_CASES = [
    { langs:[], pieces:[] },
    { langs:['web'], pieces:[] },
    { langs:['go'], pieces:[go] },
    { langs:['frontend'], pieces:[frontend] },
    { langs:['react'], pieces:[frontend, hooks] },
    { langs:['react', 'frontend'], pieces:[frontend, hooks] },
    {
        langs:['react', 'frontend', 'go', 'react', 'go', 'web'],
        pieces:[go, frontend, hooks],
    },
]

for (const { langs, pieces } of LANGUAGE_CASES) {
    test(`finder language addenda for ${langs.join(',')}`, async t => {
        for (const { mode, scope, pieces:basePieces } of CASES) {
            for (const isQuick of [false, true]) {
                const output = await finderSystem(
                    mode, scope, isQuick, langs, '', true,
                )
                const selected = mode === 'prose' ? [] : pieces
                let end = basePieces.reduce((n, piece) => n + piece.length, 0)
                for (const piece of selected) {
                    t.equal(output.indexOf(piece), end,
                        'language assets follow in stable order')
                    end += piece.length
                }
                for (const asset of [go, frontend, hooks, quick]) {
                    const expected = asset === quick
                        ? Number(isQuick)
                        : Number(selected.includes(asset))
                    t.equal(output.split(asset).length - 1, expected,
                        'each selected addendum appears exactly once')
                }
                t.equal(output.slice(end), isQuick ? quick : '',
                    'quick is last and nothing else is appended')
            }
        }
    })
}

for (const mode of ['code', 'mixed', 'prose']) {
    test(`single-call ${mode} finder limits claims about unseen files`,
        async t => {
            const dir = tempDir()
            t.cleanup(dir.remove)
            const path = join(dir.dir, 'override.tmpl')
            await writeFile(path, 'Custom core')
            for (const override of ['', path]) {
                const output = await finderSystem(
                    mode, 'diff', true, ['frontend'], override, false,
                )
                const marker = 'Single-call review (no exploration tools'
                t.ok(output.includes(marker), 'explains tools are absent')
                t.ok(output.includes('not evidence that its target is absent'),
                    'unseen paths are not reported as missing')
                t.ok(output.indexOf(marker) < output.indexOf(quick),
                    'single-call rules precede quick constraints')
                const interactive = await finderSystem(
                    mode, 'repo', false, [], override, true,
                )
                t.ok(!interactive.includes(marker),
                    'interactive runs retain exploration instructions')
            }
        })
}
