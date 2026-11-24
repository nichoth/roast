import { test } from '@substrate-system/tapzero'
import {
    encodeToolResult,
    decodeModelText,
    wellFormed,
} from '../../src/llm/json.js'

test('encodeToolResult sorts keys in code-unit order, nested too', t => {
    const got = encodeToolResult({
        b:1, a:{ z:true, Z:null, y:[{ d:1, c:2 }] }, B:'x',
    })
    t.equal(got,
        '{"B":"x","a":{"Z":null,"y":[{"c":2,"d":1}],"z":true},"b":1}')
})

test('encodeToolResult leaves <, >, &, U+2028, U+2029 unescaped', t => {
    const got = encodeToolResult({ s:'<a>&b\u2028c\u2029' })
    t.equal(got, '{"s":"<a>&b\u2028c\u2029"}')
})

test('encodeToolResult drops undefined members like JSON', t => {
    t.equal(encodeToolResult({ a:undefined, b:2 }), '{"b":2}')
})

test('decodeModelText turns lone surrogates into U+FFFD', t => {
    const parsed = JSON.parse('"a\\ud800b\\udc00c\\ud83d\\ude00"')
    t.equal(wellFormed(parsed), 'a\ufffdb\ufffdc\ud83d\ude00',
        'from JSON escapes')
    const bytes = new Uint8Array([0x61, 0xed, 0xa0, 0x80, 0x62])
    t.equal(decodeModelText(bytes), 'a\ufffd\ufffd\ufffdb',
        'from encoded surrogate bytes')
})
