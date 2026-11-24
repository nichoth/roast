// Built-in provider registry at the module seam (spec 02, 2.7).
import { test } from '../helpers/test.js'
import {
    builtinProviders,
    defaultBaseURL,
    lookupProvider,
    providerAt,
    sameEndpoint,
} from '../../src/config/provider.js'

test('lookupProvider returns each built-in by exact name', t => {
    const want = [
        ['openai', 'https://api.openai.com/v1', ['responses', 'chat'],
            'OPENAI_API_KEY', 'https://platform.openai.com/api-keys',
            'paste'],
        ['anthropic', 'https://api.anthropic.com/v1', ['anthropic'],
            'ANTHROPIC_API_KEY',
            'https://console.anthropic.com/settings/keys', 'paste'],
        ['openrouter', 'https://openrouter.ai/api/v1', ['chat', 'responses'],
            'OPENROUTER_API_KEY', 'https://openrouter.ai/settings/keys',
            'browser'],
    ] as const
    for (const [name, endpoint, protocols, keyEnv, keyPage, login] of want) {
        const p = lookupProvider(name)
        t.deepEqual(p && {
            name:p.name,
            endpoint:p.endpoint,
            protocols:[...p.protocols],
            keyEnv:p.keyEnv,
            keyPage:p.keyPage,
            login:p.login,
        }, {
            name, endpoint, protocols:[...protocols], keyEnv, keyPage, login,
        }, `lookupProvider(${name})`)
    }
    t.equal(lookupProvider('OpenAI'), undefined, 'names are exact')
    t.equal(lookupProvider('toString'), undefined, 'no prototype keys')
    t.deepEqual(builtinProviders().map(p => p.name),
        ['openai', 'anthropic', 'openrouter'], 'registry order')
})

test('builtinProviders returns copies', t => {
    const list = builtinProviders() as unknown as { protocols:string[] }[]
    try {
        list[0].protocols.push('anthropic')
    } catch {
        // a frozen copy is fine too
    }
    t.equal(providerAt('https://api.openai.com/v1', 'anthropic'),
        undefined, 'registry unchanged')
})

test('providerAt matches the example table', t => {
    const cases:[string, string, string][] = [
        ['https://api.openai.com/v1', 'responses', 'openai'],
        ['https://api.openai.com/v1/', 'chat', 'openai'],
        ['HTTPS://API.OPENAI.COM/v1', 'responses', 'openai'],
        ['https://api.openai.com/v1', 'anthropic', ''],
        ['https://api.anthropic.com/v1', 'anthropic', 'anthropic'],
        ['https://api.anthropic.com/v1', 'chat', ''],
        ['https://api.anthropic.com/v1', 'responses', ''],
        ['https://openrouter.ai/api/v1', 'chat', 'openrouter'],
        ['https://openrouter.ai/api/v1', 'responses', 'openrouter'],
        ['https://openrouter.ai/api/v1', 'anthropic', ''],
        ['https://gateway.example/v1', 'responses', ''],
        ['http://api.openai.com/v1', 'responses', ''],
        ['https://api.openai.com/v2', 'responses', ''],
        ['https://api.openai.com/v1?x=1', 'responses', ''],
        ['https://u@api.openai.com/v1', 'responses', ''],
        ['', 'responses', ''],
    ]
    for (const [endpoint, protocol, want] of cases) {
        t.equal(providerAt(endpoint, protocol)?.name ?? '', want,
            `providerAt(${JSON.stringify(endpoint)}, ${protocol})`)
    }
})

test('every registered endpoint and protocol maps back', t => {
    for (const p of builtinProviders()) {
        for (const protocol of p.protocols) {
            t.equal(providerAt(p.endpoint, protocol)?.name, p.name,
                `${p.name} ${protocol}`)
        }
    }
})

test('an endpoint without an authority has an empty host', t => {
    for (const endpoint of ['https:///v1', 'https:v1',
        'https:api.openai.com/v1',
        'https:/api.openai.com/v1']) {
        t.equal(providerAt(endpoint, 'responses'), undefined, endpoint)
        t.ok(!sameEndpoint(endpoint, endpoint), `${endpoint} never matches`)
    }
})

test('defaultBaseURL never names OpenRouter', t => {
    t.equal(defaultBaseURL('anthropic'), 'https://api.anthropic.com/v1')
    t.equal(defaultBaseURL('responses'), 'https://api.openai.com/v1')
    t.equal(defaultBaseURL('chat'), 'https://api.openai.com/v1')
    t.equal(defaultBaseURL('bogus'), 'https://api.openai.com/v1')
})
