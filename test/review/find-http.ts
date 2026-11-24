import { test } from '../helpers/test.js'
import { startInferenceServer } from '../helpers/inference-server.js'
import { createClient, createModelClient } from '../../src/llm/client.js'
import { find } from '../../src/review/find.js'
import { wire } from './fixtures.js'
import { signal } from '../llm/agent-helpers.js'

type Call = { name:string, args:unknown }

function stream (calls:Call[]) {
    return {
        id:'c1',
        model:'finder-test',
        choices:[{
            index:0,
            finish_reason:calls.length ? 'tool_calls' : 'stop',
            message:{
                role:'assistant',
                content:calls.length ? '' : 'finished',
                tool_calls:calls.map((c, i) => ({
                    id:`call-${i}`,
                    type:'function',
                    function:{ name:c.name, arguments:JSON.stringify(c.args) },
                })),
            },
        }],
        usage:{ prompt_tokens:10, completion_tokens:5, total_tokens:15 },
    }
}

const report:Call = { name:'report_finding', args:wire() }
const submit:Call = {
    name:'submit_findings',
    args:{
        assessment:'FINDINGS_PRESENT', findings:[wire({ file:'b.ts' })],
    }
}
const explore:Call = { name:'read_file', args:{ path:'a.ts' } }

const cases = [
    {
        name:'report then submit',
        turns:[[report], [submit]],
        files:['a.ts', 'b.ts'],
        incomplete:false
    },
    {
        name:'report and submit together',
        turns:[[report, submit]],
        files:['a.ts', 'b.ts'],
        incomplete:false
    },
    {
        name:'report only',
        turns:[[report], []],
        files:['a.ts'],
        incomplete:true
    },
    {
        name:'report beside refused exploration',
        turns:[[explore, report]],
        files:['a.ts'],
        incomplete:true
    },
]

for (const c of cases) {
    test(`finder HTTP wrap-up: ${c.name}`, async t => {
        const s = await startInferenceServer((_req, n) => {
            const calls = c.turns[n]
            if (!calls) return { status:400, body:'script exhausted' }
            return { stream:stream(calls) }
        })
        t.cleanup(() => s.close())
        const client = createClient(createModelClient({
            role:'finder',
            baseUrl:s.url + '/v1',
            apiKey:'test-key',
            model:'finder-test',
            protocol:'chat',
            maxOutputTokens:1024,
            maxAttempts:1,
            requestTimeoutMs:0,
        }))
        let explorations = 0
        const captured:string[] = []
        const r = await find(client, {
            system:'sys',
            user:'user',
            confidenceFloor:0.6,
            interactive:true,
            maxTurns:1,
            capture:w => captured.push(w.file),
            tools:[{
                name:'read_file',
                description:'Read a file.',
                schema:{ type:'object' },
                run () { explorations++; return {} },
            }],
        }, signal())
        t.deepEqual(r.findings.map(f => f.file), c.files)
        t.equal(r.incomplete ?? false, c.incomplete)
        t.equal(r.assessment, 'FINDINGS_PRESENT')
        t.equal(explorations, 0)
        t.equal(s.requests.length, c.turns.length)
        t.ok(captured.includes('a.ts'), 'early report captured')
        if (c.incomplete) t.equal(r.stopReason, 'budget_exhausted')
    })
}
