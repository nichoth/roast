// Trust projection and approval need (spec 03, 2.2, 2.3, 5.1).
import { test } from '@substrate-system/tapzero'
import {
    requiresApproval,
    trustProjection,
} from '../../src/config/trust.js'
import { configFrom } from './helpers.js'

const OPENAI = 'https://api.openai.com/v1'
const ANTHROPIC = 'https://api.anthropic.com/v1'
const GATEWAY = 'https://gateway.example/v1'
const ROUTER = 'https://openrouter.ai/api/v1'

// A config whose finder and verifier both select one profile.
function single (endpoint:string, protocol:string, keyEnv:string) {
    const profile:Record<string, string> = { model:'m' }
    if (endpoint) profile.endpoint = endpoint
    if (protocol) profile.protocol = protocol
    if (keyEnv) profile.api_key_env = keyEnv
    return configFrom({
        inference_profiles:{ p:profile },
        roles:{ finder:{ profile:'p' }, verifier:{ profile:'p' } },
    })
}

test('requiresApproval for single-profile configs', t => {
    const cases:[string, string, string, string, boolean][] = [
        ['openai responses', OPENAI, 'responses', 'OPENAI_API_KEY', false],
        ['openai chat', OPENAI, 'chat', 'OPENAI_API_KEY', false],
        ['openai implicit endpoint', '', 'responses', '', false],
        ['openai implicit protocol', OPENAI, '', '', false],
        ['openai trailing slash', OPENAI + '/', 'chat', '', false],
        ['anthropic', ANTHROPIC, 'anthropic', 'ANTHROPIC_API_KEY', false],
        ['anthropic implicit endpoint', '', 'anthropic', '', false],
        ['openai custom key', OPENAI, 'responses', 'MY_KEY', true],
        ['openai with anthropic key', OPENAI, 'chat', 'ANTHROPIC_API_KEY',
            true],
        ['anthropic custom key', ANTHROPIC, 'anthropic', 'MY_KEY', true],
        ['anthropic with openai protocol', ANTHROPIC, 'chat', '', true],
        ['openai with anthropic protocol', OPENAI, 'anthropic', '', true],
        ['openrouter chat', ROUTER, 'chat', 'OPENROUTER_API_KEY', false],
        ['openrouter responses', ROUTER, 'responses', 'OPENROUTER_API_KEY',
            false],
        ['openrouter without key', ROUTER, 'chat', '', false],
        ['openrouter trailing slash', ROUTER + '/', 'chat', '', false],
        ['openrouter custom key', ROUTER, 'chat', 'MY_KEY', true],
        ['openrouter with openai key', ROUTER, 'chat', 'OPENAI_API_KEY',
            true],
        ['openrouter with anthropic protocol', ROUTER, 'anthropic', '',
            true],
        ['openai with openrouter key', OPENAI, 'chat', 'OPENROUTER_API_KEY',
            true],
        ['gateway', GATEWAY, 'responses', 'OPENAI_API_KEY', true],
        ['gateway without key', GATEWAY, 'chat', '', true],
    ]
    for (const [name, endpoint, protocol, keyEnv, want] of cases) {
        const p = trustProjection(single(endpoint, protocol, keyEnv))
        t.equal(requiresApproval(p), want, name)
    }
})

test('a prompt override requires approval', t => {
    const cfg = configFrom({
        inference_profiles:{ p:{ model:'m' } },
        roles:{ finder:{ profile:'p' }, verifier:{ profile:'p' } },
        prompts:{ verifier:'v.md' },
    })
    t.equal(requiresApproval(trustProjection(cfg)), true, 'needs approval')
})

test('projection order and contents', t => {
    const cfg = configFrom({
        inference_profiles:{
            a:{
                model:'m',
                endpoint:GATEWAY,
                protocol:'chat',
                api_key_env:'GW_KEY'
            },
            b:{ model:'m', protocol:'anthropic' },
            c:{ model:'m', endpoint:ROUTER, protocol:'chat' },
            unused:{ model:'m', endpoint:'https://unused.example/v1' },
        },
        roles:{
            verifier:{ profile:'b' },
            finder:{
                profile:'a',
                author_routes:{ openai:'c', anthropic:'b' },
            },
        },
        prompts:{ verifier:'v.md', finder_code:'code.md' },
    })
    const p = trustProjection(cfg)
    t.deepEqual(p.profiles, [
        {
            selector:'roles.finder',
            profile:'a',
            endpoint:GATEWAY,
            protocol:'chat',
            credentialEnv:'GW_KEY'
        },
        {
            selector:'roles.finder.author_routes.anthropic',
            profile:'b',
            endpoint:ANTHROPIC,
            protocol:'anthropic',
            credentialEnv:'ANTHROPIC_API_KEY'
        },
        {
            selector:'roles.finder.author_routes.openai',
            profile:'c',
            endpoint:ROUTER,
            protocol:'chat',
            credentialEnv:'OPENROUTER_API_KEY'
        },
        {
            selector:'roles.verifier',
            profile:'b',
            endpoint:ANTHROPIC,
            protocol:'anthropic',
            credentialEnv:'ANTHROPIC_API_KEY'
        },
    ], 'roles sorted, routes after their role, unused profile excluded')
    t.deepEqual(p.promptOverrides, [
        { name:'prompts.finder_code', path:'code.md' },
        { name:'prompts.verifier', path:'v.md' },
    ], 'prompt overrides in fixed order, raw paths')
})
