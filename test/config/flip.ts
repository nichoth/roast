// Author-aware finder selection at the module seam (spec 02, 2.10; spec
// 08, 2.20). Asserts the chosen profile and whether a note or warning
// exists, never the wording.
import { test } from '../helpers/test.js'
import { inferFamily } from '../../src/config/family.js'
import { defaultBaseURL } from '../../src/config/provider.js'
import { resolveFinderFlip, resolveRole } from '../../src/config/role.js'
import { OPENROUTER, configFrom } from './helpers.js'

test('the finder flip selects a named profile', t => {
    const cfg = configFrom({
        inference_profiles:{
            primary:{
                endpoint:'https://openai.example/v1',
                api_key_env:'OPENAI_TEST_KEY',
                model:'gpt-author',
                protocol:'responses',
                max_output_tokens:1000,
            },
            independent:{
                endpoint:'https://anthropic.example/v1',
                api_key_env:'ANTHROPIC_TEST_KEY',
                model:'claude-reviewer',
                protocol:'anthropic',
                max_output_tokens:2000,
            },
        },
        roles:{
            finder:{
                profile:'primary',
                author_routes:{ openai:'independent' },
            },
        },
    })
    const env = {
        OPENAI_TEST_KEY:'openai-key',
        ANTHROPIC_TEST_KEY:'anthropic-key',
    }
    const finder = resolveRole(cfg, 'finder', env)
    const got = resolveFinderFlip(cfg, finder, 'openai/gpt-author', env)
    t.equal(got.role.profile, 'independent')
    t.equal(got.role.model, 'claude-reviewer')
    t.equal(got.role.protocol, 'anthropic')
    t.equal(got.role.apiKey, 'anthropic-key')
    t.equal(got.role.maxOutputTokens, 2000)
    t.equal(got.role.pin, false, 'a route target is not pinned')
    t.ok(got.note, 'a note')
    t.ok(!got.warn, 'no warning')
})

test('an empty author model keeps the finder silently', t => {
    const cfg = configFrom({
        inference_profiles:{ f:{ model:'claude-x' }, o:{ model:'gpt-x' } },
        roles:{ finder:{ profile:'f', author_routes:{ anthropic:'o' } } },
    })
    const finder = resolveRole(cfg, 'finder', {})
    const got = resolveFinderFlip(cfg, finder, '  ', {})
    t.equal(got.role, finder)
    t.ok(!got.note && !got.warn, 'nothing to say')
})

test('the finder flip refuses a same-family target', t => {
    const cfg = configFrom({
        inference_profiles:{
            finder:{ model:'gpt-finder' },
            same:{
                model:'o3-reviewer',
                endpoint:defaultBaseURL('responses'),
                max_output_tokens:100,
            },
        },
        roles:{ finder:{ profile:'finder', author_routes:{ openai:'same' } } },
    })
    const finder = resolveRole(cfg, 'finder', {})
    const got = resolveFinderFlip(cfg, finder, 'openai', {})
    t.equal(got.role.profile, 'finder')
    t.ok(got.warn, 'a warning')
    t.ok(!got.note, 'no note')
})

test('the finder flip selects an exact author route', t => {
    const cfg = configFrom({
        inference_profiles:{
            finder:{ model:'gpt-default' },
            bar:{ model:'claude-reviewer', protocol:'anthropic' },
        },
        roles:{
            finder:{ profile:'finder', author_routes:{ 'foo-model':'bar' } },
        },
    })
    const finder = resolveRole(cfg, 'finder', {})
    const got = resolveFinderFlip(cfg, finder, 'FOO-MODEL', {})
    t.equal(got.role.profile, 'bar')
    t.equal(got.role.model, 'claude-reviewer')
    t.equal(got.role.protocol, 'anthropic')
    t.ok(got.note, 'a note')
})

test('an unknown author family without an exact route warns', t => {
    const cfg = configFrom({
        inference_profiles:{ finder:{ model:'gpt-default' } },
        roles:{ finder:{ profile:'finder' } },
    })
    const got = resolveFinderFlip(cfg, resolveRole(cfg, 'finder', {}),
        'mystery-model', {})
    t.equal(got.role.profile, 'finder')
    t.ok(got.warn, 'a warning')
})

test('a target with the author model itself is refused', t => {
    const cfg = configFrom({
        inference_profiles:{
            finder:{ model:'gpt-default' },
            twin:{ model:'Mystery-Model' },
        },
        roles:{
            finder:{
                profile:'finder', author_routes:{ 'mystery-model':'twin' },
            },
        },
    })
    const got = resolveFinderFlip(cfg, resolveRole(cfg, 'finder', {}),
        'mystery-model', {})
    t.equal(got.role.profile, 'finder')
    t.ok(got.warn, 'a warning')
})

// The flip and its same-family checks reach the same outcome whether the
// finder, author, and target use bare IDs or the slash form.
test('the finder flip treats slash IDs like bare IDs', t => {
    const cases:[string, string, string, string, boolean, string,
        boolean][] = [
        ['flip to another family', 'claude-opus-5-5', 'claude-sonnet-5-5',
            'gpt-6.1-terra', false, 'target', false],
        ['target shares the author family', 'claude-opus-5-5',
            'claude-sonnet-5-5', 'claude-haiku-5-5', false, 'finder', true],
        ['no route and finder shares the family', 'claude-opus-5-5',
            'claude-sonnet-5-5', '', false, 'finder', true],
        ['no route and different families', 'gpt-6.1-terra',
            'claude-sonnet-5-5', '', false, 'finder', false],
        ['pinned finder shares the family', 'claude-opus-5-5',
            'claude-sonnet-5-5', 'gpt-6.1-terra', true, 'finder', true],
    ]
    for (const [name, finderModel, author, target, pin, wantProfile,
        wantWarn] of cases) {
        for (const slash of [false, true]) {
            const id = (m:string):string =>
                (slash && m) ? `${inferFamily(m)}/${m}` : m
            const profiles:Record<string, object> = {
                finder:{ model:id(finderModel) },
            }
            const routes:Record<string, string> = {}
            if (target) {
                profiles.target = {
                    model:id(target),
                    protocol:'chat',
                    endpoint:OPENROUTER,
                    max_output_tokens:100,
                }
                routes.anthropic = 'target'
            }
            const cfg = configFrom({
                inference_profiles:profiles,
                roles:{
                    finder:{ profile:'finder', pin, author_routes:routes },
                },
            })
            const got = resolveFinderFlip(cfg,
                resolveRole(cfg, 'finder', {}), id(author), {})
            const label = `${name}${slash ? ' (slash)' : ''}`
            t.equal(got.role.profile, wantProfile, `${label}: profile`)
            t.equal(Boolean(got.warn), wantWarn, `${label}: warning`)
        }
    }
})
