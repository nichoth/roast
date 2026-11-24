// loadConfig at the module seam (spec 02, 2.3 and 2.4).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import {
    ConfigError,
    loadConfig,
    promptPath,
    type ProjectConfig,
} from '../../src/config/load.js'
import { EXAMPLE_CONFIGS } from './examples.js'

function tempConfig (t:CleanupTest, text:string):string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-load-'))
    t.cleanup(() => fs.rmSync(dir, { recursive:true, force:true }))
    const file = path.join(dir, '.roast.json')
    fs.writeFileSync(file, text)
    return file
}

function load (t:CleanupTest, text:string):ProjectConfig {
    return loadConfig(tempConfig(t, text))
}

// Loads `text`, expecting a ConfigError.
function rejects (t:CleanupTest, text:string, why:string):void {
    let err:unknown
    try {
        load(t, text)
    } catch (e) {
        err = e
    }
    t.ok(err instanceof ConfigError, `rejected: ${why}`)
}

function accepts (t:CleanupTest, text:string, why:string):ProjectConfig {
    let cfg:ProjectConfig|undefined
    try {
        cfg = load(t, text)
    } catch (e) {
        t.fail(`expected to load (${why}): ${(e as Error).message}`)
    }
    t.ok(cfg, `accepted: ${why}`)
    return cfg as ProjectConfig
}

// A minimal valid profile, as JSON text.
const PROFILE = '{"model": "m", "api_key_env": "KEY"}'

test('example configs load', t => {
    for (const text of EXAMPLE_CONFIGS) accepts(t, text, 'example')
})

test('JSONC comments and a trailing comma load', t => {
    const cfg = accepts(t, `// leading comment
{
    /* block */
    "version": 1, // trailing comment
    "gate": {"severity": "low",},
}
`, 'comments and trailing commas')
    t.equal(cfg.gate?.severity, 'low', 'values survive')
})

test('loadConfig rejects invalid documents', t => {
    const cases:[string, string][] = [
        ['{"version": 1, "bogus": true}', 'unknown top-level field'],
        ['{"version": 1, "inference_profiles": {"p": {"base_url": "x"}}}',
            'unknown profile field'],
        ['{}', 'missing version'],
        ['{"version": null}', 'null version'],
        ['{"version": 0}', 'zero version'],
        ['{"version": 2}', 'future version'],
        ['{"version": "1"}', 'string version'],
        ['{"version": 1, "inference_profiles": {"p": {"api_key": "s"}}}',
            'literal api_key'],
        ['{"version": 1, "inference_profiles": {"p": {"api_key": null}}}',
            'null literal api_key'],
        [`{"version": 1, "inference_profiles": {"p":
            {"api_key_env": "K", "api_key": "s"}}}`,
        'api_key beside api_key_env'],
        ['{"version": 1, "upload": {}}', 'upload section'],
        ['{"version": 1} {"version": 1}', 'trailing document'],
        ['[1]', 'array'],
        ['"x"', 'string'],
        ['1', 'number'],
        ['version: 1\n', 'YAML'],
        ['', 'empty input'],
        ["{'version': 1}", 'single quotes'],
    ]
    for (const [text, why] of cases) rejects(t, text, why)
})

test('a missing file is an error', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-load-'))
    t.cleanup(() => fs.rmSync(dir, { recursive:true, force:true }))
    t.throws(() => loadConfig(path.join(dir, '.roast.json')),
        /open config/, 'missing file')
})

test('keys match exactly', t => {
    rejects(t, '{"Version": 1}', '"Version" is unknown')
    rejects(t, '{"version": 1, "Version": 1}', '"Version" beside version')
    rejects(t, `{"version": 1, "inference_profiles":
        {"p": {"Model": "m"}}}`, 'profile "Model" is unknown')
    rejects(t, `{"version": 1, "roles": {"Finder": {"profile": "p"}},
        "inference_profiles": {"p": ${PROFILE}}}`, 'role "Finder"')
})

test('a duplicate key keeps the last value', t => {
    const cfg = accepts(t, `{"version": 1,
        "gate": {"severity": "SEVERE", "severity": "low"}}`, 'duplicate')
    t.equal(cfg.gate?.severity, 'low', 'last value wins')
    rejects(t, `{"version": 1,
        "gate": {"severity": "low", "severity": "SEVERE"}}`,
    'last invalid value wins')
})

test('a profile named __proto__ is an ordinary profile', t => {
    const cfg = accepts(t, `{"version": 1,
        "inference_profiles": {"__proto__": ${PROFILE}},
        "roles": {"finder": {"profile": "__proto__"}}}`, '__proto__')
    const profiles = cfg.inference_profiles
    t.ok(Object.prototype.hasOwnProperty.call(profiles, '__proto__'),
        'own property')
    const own = Object.getOwnPropertyDescriptor(profiles, '__proto__')
    t.equal(own?.value?.model, 'm', 'its model is kept')
    t.equal(Object.keys(profiles).length, 1, 'one profile')
})

test('null fields act as unset', t => {
    const cfg = accepts(t, `{"version": 1, "$schema": null,
        "inference_profiles": {
            "p": {"model": "m", "max_output_tokens": null,
                "protocol": null, "endpoint": null},
            "q": null
        },
        "roles": {"finder": {"profile": "p", "pin": null,
            "author_routes": null}},
        "review": {"snapshot": null, "confidence_floor": null,
            "excludes": null},
        "prompts": null, "limits": null, "interactive": null,
        "gate": {"severity": null, "timeout_seconds": null}}`, 'nulls')
    t.equal(cfg.inference_profiles.p?.max_output_tokens, 32768,
        'null max_output_tokens defaults')
    t.equal(cfg.inference_profiles.p?.protocol, 'responses',
        'null protocol defaults')
    t.ok(cfg.inference_profiles.q, 'a null profile is an empty profile')
    t.equal(cfg.review?.confidence_floor, 0.6, 'null floor defaults')
    t.equal(cfg.gate?.severity, undefined, 'null severity is unset')
    t.equal(cfg.limits, undefined, 'null limits is unset')
    // A null verifier is an empty role, which needs a profile.
    rejects(t, '{"version": 1, "roles": {"verifier": null}}',
        'a null role is an empty role')
})

test('max_output_tokens: 0 defaults, -1 is rejected', t => {
    const cfg = accepts(t, `{"version": 1, "inference_profiles":
        {"p": {"model": "m", "max_output_tokens": 0}}}`, 'zero')
    t.equal(cfg.inference_profiles.p?.max_output_tokens, 32768,
        '0 becomes 32768')
    rejects(t, `{"version": 1, "inference_profiles":
        {"p": {"model": "m", "max_output_tokens": -1}}}`, 'negative')
})

test('author-route keys normalize and collide', t => {
    const base = `"version": 1, "inference_profiles":
        {"a": ${PROFILE}, "b": ${PROFILE}}`
    rejects(t, `{${base}, "roles": {"finder": {"profile": "a",
        "author_routes": {" Gemini ": "b", "google": "b"}}}}`,
    'gemini and google collide')
    const cfg = accepts(t, `{${base}, "roles": {"finder": {"profile": "a",
        "author_routes": {" Gemini ": "b"}}}}`, 'gemini alone')
    t.deepEqual(Object.keys(cfg.roles.finder?.author_routes ?? {}),
        ['google'], 'the key is normalized')
    rejects(t, `{${base}, "roles": {"finder": {"profile": "a",
        "author_routes": {" ": "b"}}}}`, 'empty family')
    rejects(t, `{${base}, "roles": {"finder": {"profile": "a",
        "author_routes": {"openai": "zzz"}}}}`, 'unknown route profile')
})

test('roles are checked', t => {
    const base = `"version": 1, "inference_profiles": {"a": ${PROFILE}}`
    rejects(t, `{${base}, "roles": {"finder": {}}}`, 'missing profile')
    rejects(t, `{${base}, "roles": {"finder": {"profile": ""}}}`,
        'empty profile')
    rejects(t, `{${base}, "roles": {"finder": {"profile": "zzz"}}}`,
        'unknown profile')
    rejects(t, `{${base}, "roles": {"author": {"profile": "a"}}}`,
        'not a role')
    rejects(t, `{"version": 1, "inference_profiles": {" ": ${PROFILE}}}`,
        'blank profile name')
})

test('profiles are checked', t => {
    const profile = (body:string):string =>
        `{"version": 1, "inference_profiles": {"p": ${body}}}`
    rejects(t, profile('{"api_key_env": "1BAD"}'), 'bad api_key_env')
    rejects(t, profile('{"protocol": "grpc"}'), 'bad protocol')
    rejects(t, profile('{"endpoint": "ftp://x.example"}'), 'ftp endpoint')
    rejects(t, profile('{"endpoint": "https://u:p@x.example"}'),
        'endpoint userinfo')
    rejects(t, profile('{"endpoint": "https://x.example/?q=1"}'),
        'endpoint query')
    rejects(t, profile('{"endpoint": "https://x.example/#f"}'),
        'endpoint fragment')
    rejects(t, profile('{"endpoint": "not a url"}'), 'not a URL')
    accepts(t, profile('{"api_key_env": "", "protocol": ""}'),
        'empty strings are unset')
})

test('integer fields reject non-integer lexemes', t => {
    const limit = (v:string):string =>
        `{"version": 1, "limits": {"max_attempts": ${v}}}`
    rejects(t, limit('1.0'), '1.0')
    rejects(t, limit('1e3'), '1e3')
    rejects(t, limit('1.5'), '1.5')
    rejects(t, limit('"1"'), 'a string')
    const cfg = accepts(t, limit('1'), '1')
    t.equal(cfg.limits?.max_attempts, 1, 'the value is kept')
    rejects(t, '{"version": 1.0}', 'version 1.0')
    rejects(t, '{"version": 1, "gate": {"timeout_seconds": 1e2}}',
        'gate timeout 1e2')
    accepts(t, '{"version": 1, "review": {"confidence_floor": 1.0}}',
        'a number field accepts 1.0')
})

test('confidence floors are 0..1', t => {
    for (const key of ['confidence_floor', 'quick_confidence_floor']) {
        for (const v of ['0', '0.5', '1']) {
            accepts(t, `{"version": 1, "review": {"${key}": ${v}}}`,
                `${key} ${v}`)
        }
        for (const v of ['1.5', '-0.1']) {
            rejects(t, `{"version": 1, "review": {"${key}": ${v}}}`,
                `${key} ${v}`)
        }
    }
    const cfg = accepts(t, '{"version": 1, "review": {}}', 'defaults')
    t.equal(cfg.review?.confidence_floor, 0.6, 'default floor')
    t.equal(cfg.review?.quick_confidence_floor, 0.8, 'default quick floor')
})

test('a lone surrogate is rejected', t => {
    rejects(t, String.raw`{"version": 1, "prompts":
        {"verifier": "a\ud800b"}}`, 'lone high surrogate in a value')
    rejects(t, String.raw`{"version": 1, "inference_profiles":
        {"\udc00": {"model": "m"}}}`, 'lone low surrogate in a key')
    accepts(t, String.raw`{"version": 1, "prompts":
        {"verifier": "\ud83d\ude00.md"}}`, 'a surrogate pair')
})

test('session header', t => {
    const profile = (header:string):string => `{"version": 1,
        "inference_profiles": {"p": {"model": "m",
        "session_header": ${JSON.stringify(header)}}}}`
    const cfg = accepts(t, profile('X-Gateway-Session'), 'valid')
    t.equal(cfg.inference_profiles.p?.session_header, 'X-Gateway-Session',
        'kept as written')
    rejects(t, profile('X'.repeat(65)), 'too long')
    accepts(t, profile('X'.repeat(64)), '64 characters')
    rejects(t, profile('X Session'), 'space')
    rejects(t, profile('X:Session'), 'colon')
    rejects(t, profile('X-Sess\u00e9ion'), 'non-ASCII')
    const reserved = [
        'Authorization', 'X-Api-Key', 'Proxy-Authorization', 'Cookie',
        'Host', 'Content-Type', 'Content-Length', 'Content-Encoding',
        'Transfer-Encoding', 'Connection', 'Keep-Alive',
        'Proxy-Connection', 'TE', 'Trailer', 'Upgrade', 'Expect',
        'Accept', 'Accept-Encoding', 'User-Agent', 'X-Agent-Session-Id',
        'Anthropic-Version', 'Anthropic-Beta', 'Anthropic-Workspace-Id',
        'OpenAI-Organization', 'OpenAI-Project', 'X-Stainless-Lang',
    ]
    for (const name of reserved) {
        for (const spelled of [name, name.toLowerCase(),
            name.toUpperCase()]) {
            rejects(t, profile(spelled), `reserved ${spelled}`)
        }
    }
})

test('limits are checked', t => {
    const limits = (body:string):string =>
        `{"version": 1, "limits": {${body}}}`
    rejects(t, limits('"max_diff_bytes": 0'), 'max_diff_bytes 0')
    rejects(t, limits('"max_attempts": 0'), 'max_attempts 0')
    rejects(t, limits('"max_total_tokens": -1'), 'max_total_tokens -1')
    rejects(t, limits('"request_timeout": "later"'), 'bad duration')
    rejects(t, limits('"request_timeout": 10'), 'numeric duration')
    rejects(t, limits('"deadline": "-1s"'), 'negative deadline')
    rejects(t, limits('"unknown_limit": 1'), 'unknown limit')
    const cfg = accepts(t, limits(
        '"deadline": "-0s", "request_timeout": "1m30s", ' +
        '"max_total_tokens": 0'), 'valid limits')
    t.equal(cfg.limits?.deadline, 0n, '-0s is zero')
    t.equal(cfg.limits?.request_timeout, 90_000_000_000n,
        'parsed to nanoseconds')
    t.equal(cfg.limits?.max_total_tokens, 0, 'explicit 0 kept')
})

test('gate settings are checked', t => {
    const gate = (body:string):string =>
        `{"version": 1, "gate": {${body}}}`
    rejects(t, gate('"severity": "SEVERE"'), 'severity SEVERE')
    rejects(t, gate('"timeout_seconds": -1'), 'negative timeout')
    rejects(t, gate('"offer": "no"'), 'offer "no"')
    rejects(t, gate('"unknown": 1'), 'unknown gate key')
    accepts(t, gate('"severity": "critical"'), 'lower-case severity')
})

test('interactive settings are checked', t => {
    rejects(t, '{"version": 1, "interactive": {"min_files": -1}}',
        'negative min_files')
})

test('promptPath resolves against the config directory', t => {
    const file = tempConfig(t, '{"version": 1}')
    const cfg = loadConfig(file)
    t.equal(promptPath(cfg, 'prompts/finder.md'),
        path.join(path.dirname(path.resolve(file)), 'prompts/finder.md'),
        'relative to the config directory')
    t.equal(promptPath(cfg, '/abs/finder.md'), '/abs/finder.md',
        'absolute unchanged')
    t.equal(promptPath(cfg, ''), '', 'empty stays empty')
})
