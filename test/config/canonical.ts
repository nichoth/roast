// Trust hash v2 (spec 03, 2.4, 5.2): canonical JSON and known answers.
import { test } from '@substrate-system/tapzero'
import { canonicalJson } from '../../src/config/canonical.js'
import {
    type TrustProjection,
    trustHash,
    trustHashDocument,
} from '../../src/config/trust.js'

function projection (
    destinations:[string, string, string][],
    prompts:[string, string][] = []
):TrustProjection {
    return {
        profiles:destinations.map(([endpoint, protocol, credentialEnv], i) =>
            ({
                selector:`roles.r${i}`,
                profile:`p${i}`,
                endpoint,
                protocol,
                credentialEnv
            })),
        promptOverrides:prompts.map(([name, path]) => ({ name, path })),
    }
}

test('known-answer vector 1', t => {
    const p = projection(
        [['https://gateway.example/v1', 'chat', 'GATEWAY_KEY']],
        [['prompts.finder_code', 'finder-prompt.md']])
    t.equal(canonicalJson(trustHashDocument(p)),
        '{"destinations":[{"credential_env":"GATEWAY_KEY","endpoint":' +
        '"https://gateway.example/v1","protocol":"chat"}],"prompts":' +
        '[{"name":"prompts.finder_code","path":"finder-prompt.md"}]}',
        'canonical text')
    t.equal(trustHash(p), 'sha256:2b18773b1f654fbbd02019247674005c4035f397' +
        '2cfc8552655a09bb2ac57d27', 'hash')
})

test('known-answer vector 2', t => {
    const p = projection([
        ['https://gw.example/v1', 'chat', ''],
        ['https://api.openai.com/v1', 'responses', 'OPENAI_API_KEY'],
    ])
    t.equal(canonicalJson(trustHashDocument(p)),
        '{"destinations":[{"credential_env":"OPENAI_API_KEY","endpoint":' +
        '"https://api.openai.com/v1","protocol":"responses"},' +
        '{"credential_env":"","endpoint":"https://gw.example/v1",' +
        '"protocol":"chat"}],"prompts":[]}', 'canonical text')
    t.equal(trustHash(p), 'sha256:7ac3826edbb00b7b8294e6117b0fa3c70fd4e994' +
        'de107bf41a23324761252d5c', 'hash')
})

const GW:[string, string, string] = ['https://gw.example/v1', 'chat', 'K']
const OAI:[string, string, string] =
    ['https://api.openai.com/v1', 'responses', 'OPENAI_API_KEY']

test('duplicate destinations collapse', t => {
    t.equal(trustHash(projection([GW, GW, OAI])),
        trustHash(projection([GW, OAI])), 'same hash')
    t.equal(trustHashDocument(projection([GW, GW])).destinations.length, 1,
        'one destination')
})

test('hash ignores role order, selectors, and profile names', t => {
    const base = projection([GW, OAI], [['prompts.verifier', 'v.md']])
    t.equal(trustHash(projection([OAI, GW], [['prompts.verifier', 'v.md']])),
        trustHash(base), 'role order')
    const renamed:TrustProjection = {
        ...base,
        profiles:base.profiles.map(p => ({
            ...p,
            profile:`renamed-${p.profile}`,
            selector:'roles.verifier',
        })),
    }
    t.equal(trustHash(renamed), trustHash(base), 'names and selectors')
    t.equal(trustHash(projection([GW, OAI, GW], [['prompts.verifier',
        'v.md']])), trustHash(base),
    'another role on an already-listed destination')
})

test('security-relevant edits change the hash', t => {
    const base = trustHash(projection([GW], [['prompts.verifier', 'v.md']]))
    const edits:[string, TrustProjection][] = [
        ['endpoint', projection([['https://gw2.example/v1', 'chat', 'K']],
            [['prompts.verifier', 'v.md']])],
        ['protocol', projection([['https://gw.example/v1', 'responses',
            'K']], [['prompts.verifier', 'v.md']])],
        ['credential variable', projection([['https://gw.example/v1',
            'chat', 'K2']], [['prompts.verifier', 'v.md']])],
        ['prompt path', projection([GW], [['prompts.verifier', 'w.md']])],
        ['prompt name', projection([GW], [['prompts.finder_code', 'v.md']])],
        ['no prompt', projection([GW])],
    ]
    for (const [name, p] of edits) t.ok(trustHash(p) !== base, name)
})

const eAcute = '\u00e9'

test('canonicalJson sorts keys and escapes strings per RFC 8785', t => {
    t.equal(canonicalJson({ b:'1', a:['x', { d:'', c:'' }] }),
        '{"a":["x",{"c":"","d":""}],"b":"1"}', 'nested keys sorted')
    t.equal(canonicalJson({ [eAcute]:'1', z:'2', '\u20ac':'3' }),
        '{"z":"2","\u00e9":"1","\u20ac":"3"}', 'non-ASCII key sorts after')
    t.equal(canonicalJson('a"b\\c\u0001\b\t\n\f\r\u001f/\u00e9\u2028'),
        '"a\\"b\\\\c\\u0001\\b\\t\\n\\f\\r\\u001f/\u00e9\u2028"',
        'control characters escaped, the rest literal')
    t.equal(canonicalJson({ '\n':'x' }), '{"\\n":"x"}', 'key escaped')
})

test('destinations sort by UTF-16 code units', t => {
    // U+1F600 is a surrogate pair (0xD83D...), so it sorts before U+E000
    // by code units though its code point is larger.
    const astral = 'https://\u{1F600}.example/v1'
    const bmp = 'https://\ue000.example/v1'
    const doc = trustHashDocument(projection([[bmp, 'chat', ''],
        [astral, 'chat', '']]))
    t.deepEqual(doc.destinations.map(d => d.endpoint), [astral, bmp],
        'astral first')
    const fields = trustHashDocument(projection([
        ['e', 'p', 'b'], ['e', 'p', 'a'], ['e', 'o', 'z'], ['d', 'z', 'z'],
    ]))
    t.deepEqual(fields.destinations.map(d => d.endpoint + d.protocol +
        d.credential_env), ['dzz', 'eoz', 'epa', 'epb'], 'field by field')
})

test('empty lists hash as []', t => {
    t.equal(canonicalJson(trustHashDocument(projection([]))),
        '{"destinations":[],"prompts":[]}', 'empty arrays')
})

test('canonicalJson throws on a lone surrogate', t => {
    for (const s of ['\uD800', 'a\uDC00', '\uDBFFx']) {
        let threw = false
        try {
            canonicalJson({ k:s })
        } catch {
            threw = true
        }
        t.ok(threw, `value ${JSON.stringify(s)}`)
    }
    let threw = false
    try {
        canonicalJson({ '\uD800':'' })
    } catch {
        threw = true
    }
    t.ok(threw, 'key')
    t.equal(canonicalJson('\u{1F600}'), '"\u{1F600}"', 'a pair is fine')
})
