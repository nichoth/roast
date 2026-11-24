import { test } from '@substrate-system/tapzero'
import { encodeChat, chatUrl } from '../../src/llm/chat.js'
import type {
    ConversationItem,
    ToolDefinition,
} from '../../src/llm/types.js'

const schema = {
    type:'object',
    properties:{
        path:{ type:'string' },
        range:{
            type:'object',
            properties:{ start:{ type:'integer' }, end:{ type:'integer' } },
            required:['start', 'end'],
            additionalProperties:false,
        },
    },
    required:['path'],
    additionalProperties:false,
}

const tools:ToolDefinition[] = [
    { name:'read', description:'Read a file', schema },
    { name:'done', description:'', schema:{ type:'object' } },
]

function body (model:string, items:ConversationItem[] = [], t = tools) {
    return encodeChat({ model, maxOutputTokens:4096 }, {
        system:'sys', items, tools:t,
    })
}

test('chat url trims trailing slashes', t => {
    t.equal(chatUrl('https://x.example/v1//'),
        'https://x.example/v1/chat/completions')
})

test('chat output limit field by model ID', t => {
    const reasoning = body('openai/gpt-5')
    t.equal(reasoning.max_completion_tokens, 4096, 'reasoning model')
    t.ok(!('max_tokens' in reasoning), 'no max_tokens for reasoning')
    const plain = body('deepseek-chat')
    t.equal(plain.max_tokens, 4096, 'max_tokens otherwise')
    t.ok(!('max_completion_tokens' in plain), 'no max_completion_tokens')
})

test('chat request shape: streaming, auto tool choice, full schemas', t => {
    const b = body('m')
    t.equal(b.model, 'm', 'model verbatim')
    t.equal(b.stream, true, 'stream')
    t.deepEqual(b.stream_options, { include_usage:true }, 'usage option')
    t.equal(b.tool_choice, 'auto', 'tool choice auto')
    t.deepEqual(b.tools, [
        {
            type:'function',
            function:{
                name:'read',
                description:'Read a file',
                parameters:schema,
                strict:false,
            }
        },
        {
            type:'function',
            function:{
                name:'done',
                description:'',
                parameters:{ type:'object' },
                strict:false,
            }
        },
    ], 'tools carry the full schema and an empty description')
    const params = (b.tools as { function:{ parameters:unknown } }[])[0]
        .function.parameters
    t.ok(params !== schema, 'schema is a copy')
    const none = body('m', [], [])
    t.ok(!('tools' in none) && !('tool_choice' in none),
        'no tools, no tool_choice')
})

test('chat never sends a forced tool choice', t => {
    for (const model of ['deepseek-reasoner', 'gpt-5', 'm']) {
        const b = body(model, [{ role:'user', text:'u' }])
        t.equal(b.tool_choice, 'auto', model)
    }
})

test('chat message encoding', t => {
    const items:ConversationItem[] = [
        { role:'user', text:'hello' },
        {
            role:'assistant',
            parts:[
                { type:'reasoning', text:'' },
                { type:'text', text:'a' },
                { type:'text', text:'b' },
                {
                    type:'tool-call',
                    id:'c1',
                    name:'read',
                    input:'{"path":"x"}',
                },
            ]
        },
        {
            role:'tool',
            results:[
                {
                    callId:'c1',
                    name:'read',
                    output:'contents',
                    isError:false,
                },
                { callId:'c2', name:'read', output:'boom', isError:true },
            ]
        },
        { role:'assistant', parts:[{ type:'reasoning', text:'only' }] },
        { role:'assistant', parts:[{ type:'text', text:'final' }] },
    ]
    t.deepEqual(body('m', items).messages, [
        { role:'system', content:'sys' },
        { role:'user', content:'hello' },
        {
            role:'assistant',
            content:'a\nb',
            tool_calls:[{
                id:'c1',
                type:'function',
                function:{
                    name:'read', arguments:'{"path":"x"}',
                }
            }],
            reasoning_content:'',
        },
        { role:'tool', tool_call_id:'c1', content:'contents' },
        { role:'tool', tool_call_id:'c2', content:'boom' },
        { role:'assistant', content:'final' },
    ])
})
