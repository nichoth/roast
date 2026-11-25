import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import { ROOT } from '../helpers/spawn.js'
import finderCore from '../../src/prompts/templates/finder_core.tmpl'
import finderFrontend from
    '../../src/prompts/templates/finder_frontend_addendum.tmpl'
import finderGo from '../../src/prompts/templates/finder_go_addendum.tmpl'
import finderMixed from
    '../../src/prompts/templates/finder_mixed_addendum.tmpl'
import finderProse from '../../src/prompts/templates/finder_prose.tmpl'
import finderQuick from
    '../../src/prompts/templates/finder_quick_addendum.tmpl'
import finderSingleCall from
    '../../src/prompts/templates/finder_single_call.tmpl'
import finderReactHooks from
    '../../src/prompts/templates/finder_react_hooks_addendum.tmpl'
import finderScopeDiff from
    '../../src/prompts/templates/finder_scope_diff.tmpl'
import finderScopeSurvey from
    '../../src/prompts/templates/finder_scope_survey.tmpl'
import finderUser from '../../src/prompts/templates/finder_user.tmpl'
import verifierSystem from
    '../../src/prompts/templates/verifier_system.tmpl'
import verifierUser from '../../src/prompts/templates/verifier_user.tmpl'
import skill from '../../src/skill/assets/roast/SKILL.md'
import hook from '../../src/gate/pre-commit.sh'

const ASSETS:[string, string][] = [
    ['src/prompts/templates/finder_core.tmpl', finderCore],
    ['src/prompts/templates/finder_frontend_addendum.tmpl',
        finderFrontend],
    ['src/prompts/templates/finder_go_addendum.tmpl', finderGo],
    ['src/prompts/templates/finder_mixed_addendum.tmpl', finderMixed],
    ['src/prompts/templates/finder_prose.tmpl', finderProse],
    ['src/prompts/templates/finder_quick_addendum.tmpl', finderQuick],
    ['src/prompts/templates/finder_react_hooks_addendum.tmpl',
        finderReactHooks],
    ['src/prompts/templates/finder_scope_diff.tmpl', finderScopeDiff],
    ['src/prompts/templates/finder_scope_survey.tmpl',
        finderScopeSurvey],
    ['src/prompts/templates/finder_user.tmpl', finderUser],
    ['src/prompts/templates/finder_single_call.tmpl', finderSingleCall],
    ['src/prompts/templates/verifier_system.tmpl', verifierSystem],
    ['src/prompts/templates/verifier_user.tmpl', verifierUser],
    ['src/skill/assets/roast/SKILL.md', skill],
    ['src/gate/pre-commit.sh', hook],
]

test('text assets imported through the loader equal the files', async t => {
    for (const [path, imported] of ASSETS) {
        const onDisk = await readFile(join(ROOT, path), 'utf8')
        t.ok(onDisk.length > 0, `${path} is not empty`)
        t.equal(imported, onDisk, `${path} matches the file on disk`)
    }
})
