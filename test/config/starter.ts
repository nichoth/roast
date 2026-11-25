import { test } from '../helpers/test.js'
import { decode, normalize } from '../../src/config/load.js'
import {
    starter,
    starterFromModels,
    UnplaceableModelError,
} from '../../src/config/starter.js'
import type {
    RoleChoice, CustomChoice,
} from '../../src/config/starter.js'
import { thrown } from './helpers.js'
import {
    DEFAULT_LIMITS,
    SUGGESTED_MODELS,
} from '../../src/config/defaults.js'
import { gateOffers, snapshotEnabled } from '../../src/config/load.js'
import {
    GATE_DEFAULT_TIMEOUT,
    GATE_DEFAULT_SEVERITY,
} from '../../src/cli/gate.js'

test('starter places models and separates different models', t => {
    const cases:Array<[string, string, string, string, number]> = [
        ['', '', 'openai', 'anthropic', 2],
        ['claude-opus-5-5', 'gpt-5', 'anthropic', 'openai', 2],
        ['gpt-5', 'claude-sonnet-5-5', 'openai', 'anthropic', 2],
        ['claude-opus-5-5', '', 'anthropic', 'openai', 2],
        ['', 'gpt-5', 'anthropic', 'openai', 2],
        ['codex-mini-latest', '', 'openai', 'anthropic', 2],
        ['claude-x', 'claude-y', 'anthropic', 'anthropic', 2],
        ['gpt-5', 'gpt-5', 'openai', 'openai', 1],
        ['anthropic/claude-x', 'openai/gpt-5',
            'openrouter', 'openrouter', 2],
        ['meta-llama/llama-4:free', 'anthropic/claude-x',
            'openrouter', 'openrouter', 2],
        ['claude-x', 'openai/gpt-5', 'anthropic', 'openrouter', 2],
        ['anthropic/claude-x', 'gpt-5', 'openrouter', 'openai', 2],
        ['anthropic/claude-x', '', 'openrouter', 'openrouter', 2],
        ['', 'openai/gpt-5', 'openrouter', 'openrouter', 2],
        [' \tgpt-5\u0085', '', 'openai', 'anthropic', 2],
    ]
    const providers = {
        openai:['responses', 'https://api.openai.com/v1', 'OPENAI_API_KEY'],
        anthropic:['anthropic', 'https://api.anthropic.com/v1',
            'ANTHROPIC_API_KEY'],
        openrouter:['chat', 'https://openrouter.ai/api/v1',
            'OPENROUTER_API_KEY'],
    }
    for (const [finder, verifier, fAt, vAt, count] of cases) {
        const cfg = normalize(
            decode(starterFromModels(finder, verifier)), ''
        )
        t.equal(Object.keys(cfg.inference_profiles).length, count)
        for (const [role, at, model] of [
            ['finder', fAt, finder], ['verifier', vAt, verifier],
        ] as const) {
            const name = cfg.roles[role]!.profile
            const p = cfg.inference_profiles[name!]!
            t.deepEqual([p.protocol, p.endpoint, p.api_key_env],
                providers[at as keyof typeof providers])
            t.equal(p.model, model.trim().replace(/\u0085$/, '') ||
                `<${role}-model>`)
        }
        if (finder !== verifier) {
            t.ok(cfg.roles.finder!.profile !== cfg.roles.verifier!.profile,
                'different models have different profiles')
        }
    }
})

test('starter gives default and OpenRouter profiles stable names', t => {
    for (const [f, v, names] of [
        ['', '', ['openai', 'anthropic']],
        ['anthropic/claude-x', 'openai/gpt-5',
            ['openrouter-finder', 'openrouter-verifier']],
    ] as const) {
        const cfg = normalize(decode(starterFromModels(f, v)), '')
        t.deepEqual(
            [
                cfg.roles.finder!.profile,
                cfg.roles.verifier!.profile,
            ],
            [...names]
        )
    }
})

test('starter rejects unplaceable IDs with role and trimmed model', t => {
    for (const model of [
        'gemini-2.5-pro', 'some-model', 'openai',
        'claude-opus-5-5[1m]', 'openai:api', 'Claude-Opus-5-5',
        'claude-x@2024', 'gpt-5 mini', 'Anthropic/claude-opus-5-5',
        'anthropic/Claude-Opus-5-5', 'anthropic/ claude-opus-5-5',
        'anthropic/claude-opus-5-5[1m]', 'openai/gpt-5:api',
        'anthropic/anthropic', 'google/gemini', 'openai/', '/gpt-5',
        'openai/gpt-5/mini', 'meta-llama/llama-4:',
    ]) {
        for (const role of ['finder', 'verifier']) {
            const err = thrown(() => starterFromModels(
                role === 'finder' ? ` ${model} ` : '',
                role === 'verifier' ? ` ${model} ` : ''
            ))
            t.ok(err instanceof UnplaceableModelError)
            if (!(err instanceof UnplaceableModelError)) continue
            t.equal(err.role, role)
            t.equal(err.model, model)
        }
    }
    const first = thrown(() => starterFromModels(
        'invalid-finder', 'invalid-verifier'
    ))
    t.equal((first as UnplaceableModelError).role, 'finder')
})

test('suggested model constants exist for each built-in provider', t => {
    t.ok(SUGGESTED_MODELS.anthropic, 'anthropic suggested model')
    t.ok(SUGGESTED_MODELS.openai, 'openai suggested model')
    t.ok(SUGGESTED_MODELS.openrouter, 'openrouter suggested models')
    t.equal(SUGGESTED_MODELS.anthropic, 'claude-opus-5-5')
    t.equal(SUGGESTED_MODELS.openai, 'gpt-6.1-terra')
    t.ok(
        SUGGESTED_MODELS.openrouter.includes(
            'anthropic/claude-opus-5-5'
        ),
        'openrouter has anthropic slug'
    )
    t.ok(
        SUGGESTED_MODELS.openrouter.includes(
            'openai/gpt-6.1-terra'
        ),
        'openrouter has openai slug'
    )
})

test('starter accepts RoleChoice per role', t => {
    const finder:RoleChoice = {
        provider:'openai', model:'gpt-5'
    }
    const verifier:RoleChoice = {
        provider:'anthropic', model:'claude-opus-5-5'
    }
    const cfg = normalize(decode(starter(finder, verifier)), '')
    const fp = cfg.inference_profiles[cfg.roles.finder!.profile!]!
    const vp = cfg.inference_profiles[cfg.roles.verifier!.profile!]!
    t.equal(fp.model, 'gpt-5')
    t.equal(vp.model, 'claude-opus-5-5')
    t.equal(fp.endpoint, 'https://api.openai.com/v1')
    t.equal(vp.endpoint, 'https://api.anthropic.com/v1')
})

test('starterFromModels produces same output as old starter', t => {
    const cases:[string, string][] = [
        ['', ''],
        ['claude-opus-5-5', 'gpt-5'],
        ['gpt-5', 'claude-sonnet-5-5'],
        ['claude-opus-5-5', ''],
        ['', 'gpt-5'],
        ['anthropic/claude-x', 'openai/gpt-5'],
    ]
    for (const [f, v] of cases) {
        const cfg = normalize(
            decode(starterFromModels(f, v)), ''
        )
        const fp = cfg.inference_profiles[
            cfg.roles.finder!.profile!
        ]!
        const vp = cfg.inference_profiles[
            cfg.roles.verifier!.profile!
        ]!
        t.ok(fp.model, `finder model set for [${f}, ${v}]`)
        t.ok(vp.model, `verifier model set for [${f}, ${v}]`)
    }
})

test('UnplaceableModelError uses suggested model constants', t => {
    const err = new UnplaceableModelError('finder', 'bad-model')
    t.ok(
        err.message.includes(SUGGESTED_MODELS.anthropic),
        'mentions anthropic suggested model'
    )
    t.ok(
        err.message.includes(
            SUGGESTED_MODELS.openrouter[0]!
        ),
        'mentions openrouter suggested model'
    )
})

test('starter custom profile with api_key_env loads correctly',
    t => {
        const finder:CustomChoice = {
            kind:'custom',
            endpoint:'http://openai.api.tiiny/v1',
            protocol:'chat',
            apiKeyEnv:'TIINY_KEY',
            model:'Qwen/Qwen3.6-35B-A3B',
        }
        const verifier:RoleChoice = {
            provider:'anthropic', model:'claude-opus-5-5'
        }
        const cfg = normalize(decode(starter(finder, verifier)), '')
        const fp = cfg.inference_profiles[
            cfg.roles.finder!.profile!
        ]!
        t.equal(fp.endpoint,
            'http://openai.api.tiiny/v1')
        t.equal(fp.protocol, 'chat')
        t.equal(fp.api_key_env, 'TIINY_KEY')
        t.equal(fp.model, 'Qwen/Qwen3.6-35B-A3B')
        t.equal(cfg.roles.finder!.profile, 'custom')
    })

test('starter custom profile without api_key_env loads correctly',
    t => {
        const finder:CustomChoice = {
            kind:'custom',
            endpoint:'http://openai.api.tiiny/v1',
            protocol:'chat',
            apiKeyEnv:'',
            model:'openai/gpt-oss-20b',
        }
        const verifier:RoleChoice = {
            provider:'openai', model:'gpt-5'
        }
        const cfg = normalize(decode(starter(finder, verifier)), '')
        const fp = cfg.inference_profiles[
            cfg.roles.finder!.profile!
        ]!
        t.equal(fp.endpoint,
            'http://openai.api.tiiny/v1')
        t.equal(fp.protocol, 'chat')
        t.equal(fp.api_key_env, undefined)
        t.equal(fp.model, 'openai/gpt-oss-20b')
    })

test('starter two custom roles different settings split names',
    t => {
        const finder:CustomChoice = {
            kind:'custom',
            endpoint:'http://openai.api.tiiny/v1',
            protocol:'chat',
            apiKeyEnv:'TIINY_KEY',
            model:'Qwen/Qwen3.6-35B-A3B',
        }
        const verifier:CustomChoice = {
            kind:'custom',
            endpoint:'http://localhost:8080/v1',
            protocol:'responses',
            apiKeyEnv:'LOCAL_KEY',
            model:'my-model',
        }
        const cfg = normalize(
            decode(starter(finder, verifier)), ''
        )
        t.equal(cfg.roles.finder!.profile,
            'custom-finder')
        t.equal(cfg.roles.verifier!.profile,
            'custom-verifier')
        const fp = cfg.inference_profiles['custom-finder']!
        const vp = cfg.inference_profiles['custom-verifier']!
        t.equal(fp.endpoint,
            'http://openai.api.tiiny/v1')
        t.equal(vp.endpoint,
            'http://localhost:8080/v1')
    })

test('starter two identical custom roles share custom name',
    t => {
        const choice:CustomChoice = {
            kind:'custom',
            endpoint:'http://openai.api.tiiny/v1',
            protocol:'chat',
            apiKeyEnv:'TIINY_KEY',
            model:'Qwen/Qwen3.6-35B-A3B',
        }
        const cfg = normalize(
            decode(starter(choice, choice)), ''
        )
        t.equal(cfg.roles.finder!.profile, 'custom')
        t.equal(cfg.roles.verifier!.profile, 'custom')
        t.equal(
            Object.keys(cfg.inference_profiles).length, 1
        )
    })

test('starter comments agree with runtime defaults', t => {
    const body = starterFromModels('', '')
    const comments = body.split('\n').filter(line =>
        /^ {2}\/\/ (?: *"| *})/.test(line))
        .map(line => line.slice(5)).join('\n')
    // Only object-property comments are executable JSONC when uncommented.
    const blocks = comments.slice(comments.indexOf('"review":'))
    const raw = decode('{"version":1,' + blocks + '}')
    const cfg = normalize(decode(body), '')
    t.deepEqual({ ...raw.limits }, {
        deadline:'10m',
        request_timeout:'10m',
        max_total_tokens:3000000,
        max_diff_bytes:1000000,
        max_prompt_bytes:8000000,
        max_file_ctx_bytes:400000,
        max_attempts:4,
        max_verified:25,
    })
    t.deepEqual({ ...raw.limits }, DEFAULT_LIMITS)
    t.equal(raw.review!.confidence_floor, cfg.review.confidence_floor)
    t.equal(raw.review!.quick_confidence_floor,
        cfg.review.quick_confidence_floor)
    t.equal(raw.review!.snapshot, snapshotEnabled(cfg))
    t.equal(raw.gate!.offer, gateOffers(cfg))
    t.equal(raw.gate!.timeout_seconds, GATE_DEFAULT_TIMEOUT)
    t.equal(raw.gate!.severity, GATE_DEFAULT_SEVERITY)
})
