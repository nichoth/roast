// Endpoint and protocol overrides at the module seam (spec 02, 2.9).
import { test } from '../helpers/test.js'
import { ConfigError } from '../../src/config/load.js'
import {
    type CredentialSource,
    type Env,
    internal,
    overrideEndpoint,
} from '../../src/config/credential.js'
import { defaultBaseURL } from '../../src/config/provider.js'
import { type ResolvedRole, updateRole } from '../../src/config/role.js'
import {
    CUSTOM_ENDPOINT,
    FakeStore,
    OPENROUTER,
    bothStored,
    resolveFinder,
    thrown,
} from './helpers.js'

const GATEWAY = 'https://gateway.example/v1'
const CHOSEN = 'https://chosen.example/v1'

interface OverrideCase {
    name:string;
    profile:Record<string, string>;
    env:Env;
    store?:FakeStore;
    protocol?:string;
    baseURL?:string;
    wantEndpoint:string;
    wantKey:string;
}

function runCases (
    t:Parameters<Parameters<typeof test>[1]>[0],
    cases:OverrideCase[]
):void {
    for (const c of cases) {
        const role = resolveFinder(c.profile, c.env, c.store)
        const moved = overrideEndpoint('finder', role,
            { baseURL:c.baseURL, protocol:c.protocol }, c.env)
        t.deepEqual({ endpoint:moved.baseURL, key:moved.apiKey },
            { endpoint:c.wantEndpoint, key:c.wantKey }, c.name)
    }
}

test('override table: where an override lands and its key', t => {
    runCases(t, [
        {
            name:'1 unset endpoint goes to the new provider default',
            profile:{ model:'m', api_key_env:'MY_OPENAI' },
            env:{
                MY_OPENAI:'openai-profile',
                ANTHROPIC_BASE_URL:GATEWAY,
                ANTHROPIC_API_KEY:'anthropic-key',
            },
            protocol:'anthropic',
            wantEndpoint:defaultBaseURL('anthropic'),
            wantKey:'anthropic-key',
        },
        {
            name:'2 explicit default endpoint with a trailing slash moves',
            profile:{
                model:'m',
                endpoint:defaultBaseURL('responses') + '/',
                api_key_env:'MY_OPENAI',
            },
            env:{
                MY_OPENAI:'openai-profile',
                ANTHROPIC_API_KEY:'anthropic-key',
            },
            protocol:'anthropic',
            wantEndpoint:defaultBaseURL('anthropic'),
            wantKey:'anthropic-key',
        },
        {
            name:'3 explicit custom endpoint stays with its credential',
            profile:{
                model:'m', endpoint:CUSTOM_ENDPOINT, api_key_env:'MY_GW',
            },
            env:{ MY_GW:'gateway-profile', ANTHROPIC_API_KEY:'anthropic-key' },
            protocol:'anthropic',
            wantEndpoint:CUSTOM_ENDPOINT,
            wantKey:'gateway-profile',
        },
        {
            name:'4 same provider protocol keeps the profile credential',
            profile:{ model:'m', api_key_env:'MY_OPENAI' },
            env:{ MY_OPENAI:'openai-profile', OPENAI_API_KEY:'openai-key' },
            protocol:'chat',
            wantEndpoint:defaultBaseURL('chat'),
            wantKey:'openai-profile',
        },
        {
            name:'5 endpoint and protocol override keep the profile key',
            profile:{ model:'m', api_key_env:'MY_OPENAI' },
            env:{
                MY_OPENAI:'openai-profile',
                ANTHROPIC_API_KEY:'anthropic-key',
            },
            protocol:'anthropic',
            baseURL:CHOSEN,
            wantEndpoint:CHOSEN,
            wantKey:'openai-profile',
        },
        {
            name:'6 endpoint override moves a role off OpenRouter keyless',
            profile:{ model:'m', endpoint:OPENROUTER, protocol:'chat' },
            env:{ OPENROUTER_API_KEY:'router-key' },
            baseURL:CHOSEN,
            wantEndpoint:CHOSEN,
            wantKey:'',
        },
        {
            name:'7 protocol override on OpenRouter keeps endpoint and key',
            profile:{ model:'m', endpoint:OPENROUTER, protocol:'chat' },
            env:{
                OPENROUTER_API_KEY:'router-key',
                OPENAI_API_KEY:'openai-key',
            },
            protocol:'responses',
            wantEndpoint:OPENROUTER,
            wantKey:'router-key',
        },
        {
            name:'8 anthropic protocol on OpenRouter drops its key',
            profile:{ model:'m', endpoint:OPENROUTER, protocol:'chat' },
            env:{
                OPENROUTER_API_KEY:'router-key',
                ANTHROPIC_API_KEY:'anthropic-key',
            },
            protocol:'anthropic',
            wantEndpoint:OPENROUTER,
            wantKey:'',
        },
        {
            name:'9 endpoint override never carries an ambient key',
            profile:{ model:'m' },
            env:{ OPENAI_API_KEY:'openai-key' },
            baseURL:CHOSEN,
            wantEndpoint:CHOSEN,
            wantKey:'',
        },
        {
            name:'an explicitly empty base URL is still an override',
            profile:{ model:'m' },
            env:{ OPENAI_API_KEY:'openai-key' },
            baseURL:'',
            wantEndpoint:'',
            wantKey:'',
        },
        {
            name:'a role key follows every override',
            profile:{ model:'m' },
            env:{ ROAST_FINDER_API_KEY:'role-key' },
            protocol:'anthropic',
            baseURL:CHOSEN,
            wantEndpoint:CHOSEN,
            wantKey:'role-key',
        },
    ])
})

test('a stored credential does not follow an override', t => {
    const anthropicOnly = ():FakeStore =>
        new FakeStore({ anthropic:'project-anthropic' })
    runCases(t, [
        {
            name:'10 endpoint override to a custom endpoint',
            profile:{ model:'m', protocol:'anthropic' },
            env:{},
            store:anthropicOnly(),
            baseURL:CUSTOM_ENDPOINT,
            wantEndpoint:CUSTOM_ENDPOINT,
            wantKey:'',
        },
        {
            name:'11 protocol override moves an implicit endpoint',
            profile:{ model:'m', protocol:'anthropic' },
            env:{},
            store:anthropicOnly(),
            protocol:'responses',
            wantEndpoint:defaultBaseURL('responses'),
            wantKey:'',
        },
        {
            name:'12 protocol override moves an explicit default endpoint',
            profile:{
                model:'m',
                protocol:'anthropic',
                endpoint:defaultBaseURL('anthropic'),
            },
            env:{},
            store:anthropicOnly(),
            protocol:'chat',
            wantEndpoint:defaultBaseURL('chat'),
            wantKey:'',
        },
        {
            name:"13 the new provider's own stored key applies",
            profile:{ model:'m', protocol:'anthropic' },
            env:{},
            store:bothStored(),
            protocol:'responses',
            wantEndpoint:defaultBaseURL('responses'),
            wantKey:'project-openai',
        },
    ])
})

test('14 an unset profile variable on a built-in endpoint prefers the ' +
    'provider variable', t => {
    const env = { OPENROUTER_API_KEY:'ambient' }
    const role = resolveFinder({
        model:'m',
        protocol:'chat',
        endpoint:OPENROUTER,
        api_key_env:'MY_OR_KEY',
    }, env, bothStored())
    t.equal(role.apiKey, 'ambient', 'initial resolution')
    const moved = overrideEndpoint('finder', role, { protocol:'responses' },
        env)
    t.equal(moved.apiKey, role.apiKey, 'same key after the override')
})

test('an override returns a new role and leaves the original', t => {
    const role = resolveFinder({ model:'m' }, { OPENAI_API_KEY:'k' })
    const moved = overrideEndpoint('finder', role, { baseURL:CHOSEN },
        { OPENAI_API_KEY:'k' })
    t.equal(role.baseURL, defaultBaseURL('responses'))
    t.equal(role.apiKey, 'k')
    t.equal(moved.explicitEndpoint, true)
    t.equal(moved.model, 'm')
})

test('an override fails only when a needed store is unusable', t => {
    const store = new FakeStore({}, {}, new Error('unreadable'))
    const env = { OPENAI_API_KEY:'k' }
    const role = resolveFinder({ model:'m' }, env, store)
    t.ok(thrown(() => overrideEndpoint('finder', role,
        { protocol:'anthropic' }, env)) instanceof ConfigError,
    'store reached after moving to anthropic')
    t.equal(thrown(() => overrideEndpoint('finder', role,
        { protocol:'chat' }, env)), undefined, 'env key: store not read')
})

test('rebindCredential re-checks ambient keys', t => {
    const env = { OPENAI_API_KEY:'openai', ANTHROPIC_API_KEY:'anthropic' }
    const base = resolveFinder({ model:'m' }, env)
    const role = (
        baseURL:string,
        protocol:string,
        apiKey:string,
        credential:CredentialSource
    ):ResolvedRole =>
        updateRole(base, { baseURL, protocol, apiKey, credential })
    const ambient = (baseURL:string, protocol:string):ResolvedRole =>
        role(baseURL, protocol, 'openai',
            { kind:'provider_env', env:'OPENAI_API_KEY' })
    const profile = (baseURL:string, protocol:string):ResolvedRole =>
        role(baseURL, protocol, 'profile',
            { kind:'profile_env', env:'PROFILE_KEY' })
    const cases:[string, ResolvedRole, boolean, string][] = [
        ['ambient key to custom endpoint',
            ambient(CUSTOM_ENDPOINT, 'responses'), false, ''],
        ['ambient key to other provider',
            ambient(defaultBaseURL('anthropic'), 'anthropic'), true,
            'anthropic'],
        ['ambient key protocol on gateway',
            ambient(defaultBaseURL('responses'), 'anthropic'), false, ''],
        ['profile key follows explicit flag',
            profile('https://flag.example/v1', 'responses'), false,
            'profile'],
        ['profile key stays with provider',
            profile(defaultBaseURL('anthropic'), 'anthropic'), true,
            'anthropic'],
        ['ambient key at the default address',
            ambient(defaultBaseURL('chat'), 'chat'), false, 'openai'],
    ]
    for (const [name, r, crossed, wantKey] of cases) {
        t.equal(internal.rebindCredential('finder', r, crossed, env).apiKey,
            wantKey, name)
    }
})
