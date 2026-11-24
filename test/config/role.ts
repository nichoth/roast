// Role and credential resolution at the module seam (spec 02, 2.5, 2.6,
// 2.11).
import util from 'node:util'
import { test } from '../helpers/test.js'
import { ConfigError } from '../../src/config/load.js'
import {
    type CredentialSource,
    describeSource,
    roleKeyVar,
} from '../../src/config/credential.js'
import { defaultBaseURL } from '../../src/config/provider.js'
import {
    type ResolvedRole,
    resolveFinderFlip,
    resolveRole,
    updateRole,
    validateRole,
} from '../../src/config/role.js'
import {
    AMBIENT_GATEWAY,
    CUSTOM_ENDPOINT,
    FakeStore,
    OPENROUTER,
    bothStored,
    configFrom,
    finderConfig,
    resolveFinder,
    thrown,
} from './helpers.js'

test('named profiles resolve with defaults', t => {
    const cfg = configFrom({
        inference_profiles:{
            primary:{
                endpoint:'https://finder.example/v1',
                api_key_env:'FINDER_PROFILE_KEY',
                model:'finder-file',
                protocol:'chat',
                session_header:'X-Session',
            },
            verify:{ model:'verifier-file' },
        },
        roles:{
            finder:{ profile:'primary', pin:true },
            verifier:{ profile:'verify' },
        },
    })
    const env = {
        FINDER_PROFILE_KEY:'profile-key',
        ROAST_FINDER_MODEL:'finder-env',
        OPENAI_API_KEY:'openai-key',
    }
    const finder = resolveRole(cfg, 'finder', env)
    t.equal(finder.profile, 'primary')
    t.equal(finder.model, 'finder-file')
    t.equal(finder.apiKey, 'profile-key')
    t.equal(finder.baseURL, 'https://finder.example/v1')
    t.equal(finder.protocol, 'chat')
    t.equal(finder.sessionHeader, 'X-Session')
    t.equal(finder.pin, true)
    t.equal(finder.explicitEndpoint, true)
    t.equal(finder.credential.kind, 'profile_env')
    const verifier = resolveRole(cfg, 'verifier', env)
    t.equal(verifier.model, 'verifier-file')
    t.equal(verifier.apiKey, 'openai-key')
    t.equal(verifier.protocol, 'responses')
    t.equal(verifier.baseURL, 'https://api.openai.com/v1')
    t.equal(verifier.maxOutputTokens, 32768)
    t.equal(verifier.sessionHeader, '')
    t.equal(verifier.pin, false)
    t.equal(verifier.explicitEndpoint, false)
    t.deepEqual({ ...verifier.authorRoutes }, {})
    t.equal(verifier.credential.kind, 'provider_env')
})

test('an anthropic profile gets the native Anthropic defaults', t => {
    const cfg = configFrom({
        inference_profiles:{
            claude:{ model:'claude-test', protocol:'anthropic' },
        },
        roles:{ finder:{ profile:'claude' } },
    })
    const role = resolveRole(cfg, 'finder', {
        ANTHROPIC_API_KEY:'anthropic-key',
        OPENAI_API_KEY:'openai-key',
    })
    t.equal(role.baseURL, 'https://api.anthropic.com/v1')
    t.equal(role.apiKey, 'anthropic-key')
    t.equal(role.protocol, 'anthropic')
    t.equal(thrown(() => validateRole('finder', role)), undefined,
        'validates')
})

test('a role missing from the config is not configured', t => {
    const cfg = configFrom({ inference_profiles:{ p:{ model:'m' } } })
    t.ok(thrown(() => resolveRole(cfg, 'finder', {})) instanceof
        ConfigError, 'finder missing')
})

test('legacy global and removed role variables have no effect', t => {
    const cfg = configFrom({
        inference_profiles:{ finder:{ model:'finder-model' } },
        roles:{ finder:{ profile:'finder' } },
    })
    const role = resolveRole(cfg, 'finder', {
        ROAST_API_KEY:'wrong-key',
        ROAST_BASE_URL:'https://wrong.example/v1',
        OPENAI_API_KEY:'ambient',
        ROAST_FINDER_BASE_URL:'https://role.example/v1',
        ROAST_FINDER_PROTOCOL:'anthropic',
        ROAST_FINDER_MODEL:'env-model',
        ROAST_FINDER_MAX_OUTPUT_TOKENS:'lots',
        OPENAI_BASE_URL:AMBIENT_GATEWAY,
        ANTHROPIC_BASE_URL:AMBIENT_GATEWAY,
        ROAST_AUTHOR_MODEL:'claude-opus',
    })
    t.equal(role.baseURL, defaultBaseURL('responses'))
    t.equal(role.protocol, 'responses')
    t.equal(role.model, 'finder-model')
    t.equal(role.maxOutputTokens, 32768)
    t.equal(role.apiKey, 'ambient')
})

// Every combination of protocol, profile endpoint, profile credential,
// ambient base-URL variables, and role key. The base-URL variables must
// never matter.
test('credential and endpoint precedence matrix', t => {
    for (const protocol of ['responses', 'chat', 'anthropic']) {
        const keyVar = protocol === 'anthropic' ?
            'ANTHROPIC_API_KEY' :
            'OPENAI_API_KEY'
        for (const endpoint of ['unset', 'default', 'custom', 'ambient']) {
            for (const credential of ['none', 'api_key_env']) {
                for (const ambientBase of [false, true]) {
                    for (const roleKey of [false, true]) {
                        const name = `${protocol}/endpoint=${endpoint}/` +
                            `credential=${credential}/base_url_env=` +
                            `${ambientBase}/role_key=${roleKey}`
                        const env:Record<string, string> = {
                            [keyVar]:'ambient-key',
                            PROFILE_KEY:'profile-key',
                        }
                        if (ambientBase) {
                            env.OPENAI_BASE_URL = AMBIENT_GATEWAY
                            env.ANTHROPIC_BASE_URL = AMBIENT_GATEWAY
                        }
                        if (roleKey) env.ROAST_FINDER_API_KEY = 'role-key'
                        const profile:Record<string, string> = {
                            model:'m', protocol,
                        }
                        const endpoints:Record<string, string> = {
                            default:defaultBaseURL(protocol),
                            custom:CUSTOM_ENDPOINT,
                            ambient:AMBIENT_GATEWAY,
                        }
                        if (endpoint !== 'unset') {
                            profile.endpoint = endpoints[endpoint]
                        }
                        if (credential === 'api_key_env') {
                            profile.api_key_env = 'PROFILE_KEY'
                        }
                        const role = resolveFinder(profile, env)
                        const builtin = endpoint === 'unset' ||
                            endpoint === 'default'
                        const want = {
                            endpoint:endpoints[endpoint] ??
                                defaultBaseURL(protocol),
                            key:'',
                            kind:'none',
                        }
                        if (roleKey) {
                            want.key = 'role-key'
                            want.kind = 'role_env'
                        } else if (credential === 'api_key_env') {
                            want.key = 'profile-key'
                            want.kind = 'profile_env'
                        } else if (builtin) {
                            want.key = 'ambient-key'
                            want.kind = 'provider_env'
                        }
                        t.deepEqual({
                            endpoint:role.baseURL,
                            key:role.apiKey,
                            kind:role.credential.kind,
                        }, want, name)
                        if (want.kind === 'none') {
                            t.equal(role.credential.withheld, keyVar,
                                `${name}: withheld`)
                        }
                    }
                }
            }
        }
    }
})

test('OPENROUTER_API_KEY is used only at OpenRouter', t => {
    const cases:[string, string, string, string][] = [
        ['openrouter chat', OPENROUTER, 'chat', 'router-key'],
        ['openrouter responses', OPENROUTER, 'responses', 'router-key'],
        ['openrouter slash', OPENROUTER + '/', 'chat', 'router-key'],
        ['openrouter anthropic', OPENROUTER, 'anthropic', ''],
        ['custom chat', CUSTOM_ENDPOINT, 'chat', ''],
        ['custom anthropic', CUSTOM_ENDPOINT, 'anthropic', ''],
        ['openai', defaultBaseURL('chat'), 'chat', ''],
        ['anthropic', defaultBaseURL('anthropic'), 'anthropic', ''],
    ]
    for (const [name, endpoint, protocol, wantKey] of cases) {
        const role = resolveFinder({ endpoint, model:'m', protocol },
            { OPENROUTER_API_KEY:'router-key' })
        t.equal(role.apiKey, wantKey, `${name}: key`)
        if (wantKey) {
            t.equal(role.credential.env, 'OPENROUTER_API_KEY',
                `${name}: source`)
        } else {
            t.equal(role.credential.withheld, 'OPENROUTER_API_KEY',
                `${name}: withheld`)
        }
    }
})

test('a custom endpoint without a named credential gets no key', t => {
    const env = {
        ANTHROPIC_API_KEY:'personal-anthropic-key',
        OPENAI_API_KEY:'personal-openai-key',
        ANTHROPIC_BASE_URL:AMBIENT_GATEWAY,
    }
    for (const protocol of ['anthropic', 'responses']) {
        const role = resolveFinder(
            { endpoint:CUSTOM_ENDPOINT, model:'m', protocol }, env)
        t.equal(role.baseURL, CUSTOM_ENDPOINT, `${protocol}: endpoint`)
        t.equal(role.apiKey, '', `${protocol}: no key`)
        const err = thrown(() => validateRole('finder', role))
        const withheld = protocol === 'anthropic' ?
            'ANTHROPIC_API_KEY' :
            'OPENAI_API_KEY'
        t.ok(err instanceof ConfigError, `${protocol}: invalid`)
        t.ok(err?.message.includes(withheld),
            `${protocol}: names the withheld variable`)
        t.ok(err?.message.includes('ROAST_FINDER_API_KEY'),
            `${protocol}: names the role variable`)
    }
})

test('a trailing slash on a default endpoint still matches', t => {
    const role = resolveFinder(
        { model:'m', endpoint:defaultBaseURL('responses') + '/' },
        { OPENAI_API_KEY:'ambient' })
    t.equal(role.apiKey, 'ambient')
    t.equal(role.credential.kind, 'provider_env')
})

test('an author-route profile follows the same credential rule', t => {
    const cfg = configFrom({
        inference_profiles:{
            primary:{ model:'gpt-primary' },
            independent:{
                endpoint:CUSTOM_ENDPOINT,
                model:'claude-reviewer',
                protocol:'anthropic',
            },
            verifier:{ model:'v' },
        },
        roles:{
            finder:{
                profile:'primary',
                author_routes:{ openai:'independent' },
            },
            verifier:{ profile:'verifier' },
        },
    })
    const env = {
        ANTHROPIC_BASE_URL:AMBIENT_GATEWAY,
        ANTHROPIC_API_KEY:'ambient',
    }
    const flip = resolveFinderFlip(cfg, resolveRole(cfg, 'finder', env),
        'gpt-author', env)
    t.equal(flip.role.profile, 'independent')
    t.equal(flip.role.baseURL, CUSTOM_ENDPOINT)
    t.equal(flip.role.apiKey, '')
    t.equal(flip.role.credential.withheld, 'ANTHROPIC_API_KEY')
})

test('stored keys are used at a built-in endpoint', t => {
    const providers:Record<string, string> = {
        responses:'openai', chat:'openai', anthropic:'anthropic',
    }
    for (const protocol of ['responses', 'chat', 'anthropic']) {
        const provider = providers[protocol]
        for (const endpoint of [undefined, defaultBaseURL(protocol)]) {
            const profile:Record<string, string> = { model:'m', protocol }
            if (endpoint) profile.endpoint = endpoint
            const role = resolveFinder(profile, {}, bothStored())
            const label = `${protocol} endpoint=${endpoint ?? 'unset'}`
            t.equal(role.apiKey, `project-${provider}`, `${label}: key`)
            t.deepEqual({ ...role.credential },
                { kind:'stored', provider, scope:'project' },
                `${label}: source`)
        }
    }
})

test('stored keys rank below every environment variable', t => {
    const anthropic = { model:'m', protocol:'anthropic' }
    const cases:[string, Record<string, string>, Record<string, string>,
        FakeStore, string][] = [
        ['role variable', { ROAST_FINDER_API_KEY:'role' }, anthropic,
            bothStored(), 'role'],
        ['profile variable', { PROFILE_KEY:'profile' },
            { ...anthropic, api_key_env:'PROFILE_KEY' }, bothStored(),
            'profile'],
        ['provider variable', { ANTHROPIC_API_KEY:'ambient' }, anthropic,
            bothStored(), 'ambient'],
        ['provider variable under an unset api_key_env',
            { ANTHROPIC_API_KEY:'ambient' },
            {
                ...anthropic,
                endpoint:defaultBaseURL('anthropic'),
                api_key_env:'PROFILE_KEY',
            },
            bothStored(), 'ambient'],
        ['project scope beats user scope', {}, anthropic, bothStored(),
            'project-anthropic'],
        ['user scope when the project has none', {}, anthropic,
            new FakeStore({}, { anthropic:'user-anthropic' }),
            'user-anthropic'],
        ["another provider's stored key is not used", {}, anthropic,
            new FakeStore({ openai:'project-openai' }), ''],
    ]
    for (const [name, env, profile, store, wantKey] of cases) {
        t.equal(resolveFinder(profile, env, store).apiKey, wantKey, name)
    }
})

test('stored keys never reach a custom endpoint', t => {
    for (const protocol of ['responses', 'chat', 'anthropic']) {
        const store = bothStored()
        const role = resolveFinder(
            { model:'m', protocol, endpoint:CUSTOM_ENDPOINT }, {}, store)
        t.equal(role.apiKey, '', `${protocol}: no key`)
        t.deepEqual(store.lookups, [], `${protocol}: store not asked`)
    }
})

test('an unusable store fails resolution only when reached', t => {
    const store = new FakeStore({}, {}, new Error('credentials unreadable'))
    const profile = { model:'m', protocol:'anthropic' }
    t.ok(thrown(() => resolveFinder(profile, {}, store)) instanceof
        ConfigError, 'store reached: fails')
    t.equal(thrown(() => resolveFinder(profile,
        { ANTHROPIC_API_KEY:'ambient' }, store)), undefined,
    'env credential first: store never read')
    t.equal(thrown(() => resolveFinder(
        { ...profile, endpoint:CUSTOM_ENDPOINT }, {}, store)), undefined,
    'custom endpoint: store never read')
})

test('no source rendering or role JSON contains the secret', t => {
    const secret = 'super-secret-value'
    const cases:[string, Record<string, string>, Record<string, string>,
        FakeStore|undefined][] = [
        ['profile', { PROFILE_KEY:secret },
            { model:'m', api_key_env:'PROFILE_KEY' }, undefined],
        ['role', { ROAST_FINDER_API_KEY:secret }, { model:'m' }, undefined],
        ['provider', { OPENAI_API_KEY:secret }, { model:'m' }, undefined],
        ['stored project', {}, { model:'m', protocol:'anthropic' },
            new FakeStore({ anthropic:secret })],
        ['stored user', {}, { model:'m', protocol:'anthropic' },
            new FakeStore({}, { anthropic:secret })],
    ]
    for (const [name, env, profile, store] of cases) {
        const role = resolveFinder(profile, env, store)
        t.equal(role.apiKey, secret, `${name}: key resolved`)
        const text = describeSource(role.credential)
        t.ok(!text.includes(secret), `${name}: describeSource`)
        t.ok(!JSON.stringify(role).includes(secret), `${name}: JSON`)
        t.ok(!util.inspect(role, { depth:10 }).includes(secret),
            `${name}: inspect`)
        t.ok(!JSON.stringify({ ...role }).includes(secret),
            `${name}: spread`)
        if (store) {
            t.ok(text.includes(name.split(' ')[1]), `${name}: names scope`)
            t.ok(text.includes('anthropic'), `${name}: names provider`)
        }
    }
    t.equal(describeSource(resolveFinder(
        { model:'m', api_key_env:'PROFILE_KEY' },
        { PROFILE_KEY:secret }).credential),
    'PROFILE_KEY (profile api_key_env)')
})

test('describeSource renders every kind', t => {
    const cases:[CredentialSource, string[]][] = [
        [{ kind:'role_env', env:'ROAST_FINDER_API_KEY' },
            ['ROAST_FINDER_API_KEY']],
        [{ kind:'provider_env', env:'OPENAI_API_KEY' }, ['OPENAI_API_KEY']],
        [{ kind:'stored', provider:'openai', scope:'user' },
            ['openai', 'user']],
        [{ kind:'none', withheld:'OPENAI_API_KEY' }, ['OPENAI_API_KEY']],
        [{ kind:'none' }, ['none']],
    ]
    for (const [source, parts] of cases) {
        const text = describeSource(source)
        t.ok(parts.every(p => text.includes(p)), `${source.kind}: ${text}`)
    }
    t.equal(roleKeyVar('verifier'), 'ROAST_VERIFIER_API_KEY')
})

test('a missing key on a built-in provider suggests login', t => {
    const role = resolveFinder({ model:'m', protocol:'anthropic' }, {},
        new FakeStore())
    const err = thrown(() => validateRole('finder', role))
    t.ok(err?.message.includes('npx roast login anthropic'),
        'names npx roast login')
    const viaProfile = resolveFinder(
        { model:'m', protocol:'chat', api_key_env:'MY_KEY' }, {})
    t.ok(thrown(() => validateRole('finder', viaProfile))?.message
        .includes('npx roast login openai'), 'profile variable on openai')
    const custom = resolveFinder(
        { model:'m', protocol:'chat', endpoint:CUSTOM_ENDPOINT }, {})
    t.ok(!thrown(() => validateRole('finder', custom))?.message
        .includes('login'), 'custom endpoint: no login hint')
})

function validRole (changes:Partial<ResolvedRole>):ResolvedRole {
    const base = resolveFinder({ model:'model', protocol:'chat' },
        { OPENAI_API_KEY:'key' })
    return updateRole(base, { apiKey:'key', ...changes })
}

test('validateRole checks model, key, and endpoint', t => {
    t.equal(thrown(() => validateRole('finder', validRole({}))), undefined,
        'a complete role is valid')
    const bad:[string, Partial<ResolvedRole>][] = [
        ['embedded userinfo',
            { baseURL:'https://user:password@example.com/v1' }],
        ['empty model', { model:'  ' }],
        ['placeholder model', { model:'<finder-model>' }],
        ['empty key', { apiKey:' ' }],
        ['query', { baseURL:'https://example.com/v1?x=1' }],
        ['no authority', { baseURL:'https:///v1' }],
        ['bad protocol', { protocol:'grpc' }],
        ['zero output limit', { maxOutputTokens:0 }],
    ]
    for (const [name, changes] of bad) {
        t.ok(thrown(() => validateRole('finder', validRole(changes))) instanceof
            ConfigError, name)
    }
    t.equal(thrown(() => validateRole('finder', validRole({ model:'<>' }))),
        undefined, 'a two-character model is not a placeholder')
})

test('a config without a store resolves with none attached', t => {
    const role = resolveRole(finderConfig({ model:'m' }), 'finder', {})
    t.equal(role.apiKey, '')
    t.equal(role.credential.kind, 'none')
})
