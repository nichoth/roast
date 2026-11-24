// `roast review` verification (step 17) end to end on a fake `chat`
// server (spec 09, 2.2 and section 5 "CLI seam").
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import type {
    RecordedRequest, Script,
} from '../helpers/inference-server.js'
import {
    chatCalls,
    finding,
    findingsReply,
    profileConfig,
    readGz,
    requestRecorder,
    runDirs,
    settingsRepo,
    toolNames,
    type Wire,
} from '../helpers/review.js'

const VERIFIER_MODEL = 'verifier-model'

// The finder on profile `fake`, the verifier on its own profile and
// model on the same custom endpoint.
function verifyConfig (url:string, verifier:object = {}) {
    const base = profileConfig(url)
    return {
        ...base,
        inference_profiles:{
            ...base.inference_profiles,
            vfake:{
                model:VERIFIER_MODEL,
                endpoint:`${url}/v1`,
                protocol:'chat',
                api_key_env:'ROAST_VERIFIER_API_KEY',
                max_output_tokens:4096,
                ...verifier,
            },
        },
        roles:{ finder:{ profile:'fake' }, verifier:{ profile:'vfake' } },
    }
}

function isVerifier (req:RecordedRequest):boolean {
    return toolNames(req).includes('submit_verdict')
}

function verdictReply (over:Record<string, unknown> = {}) {
    return {
        stream:chatCalls([{
            name:'submit_verdict',
            args:{
                reasoning:'checked the guard',
                status:'confirmed',
                confidence:0.9,
                grounding:'line 4 returns value unchecked',
                ...over,
            },
        }], VERIFIER_MODEL),
    }
}

// Finder answers with `findings`; the verifier with `verifier(req)`.
function script (
    findings:Wire[],
    verifier:(req:RecordedRequest) => ReturnType<Script> =
        () => verdictReply()
):Script {
    return req => isVerifier(req) ? verifier(req) : findingsReply(findings)
}

async function verifyRepo (
    t:Parameters<Parameters<typeof test>[1]>[0],
    s:Script,
    verifier:object = {}
) {
    const r = await settingsRepo(t, s, { config:null })
    fs.writeFileSync(path.join(r.dir, '.roast.json'),
        JSON.stringify(verifyConfig(r.server.url, verifier), null, 2))
    const trust = await r.roast(['trust', '--yes'])
    if (trust.code !== 0) throw new Error(`trust failed: ${trust.stderr}`)
    return r
}

test('finder plus verifier confirms a finding and gates', async t => {
    const r = await verifyRepo(t, script([finding()]))
    const requests = requestRecorder(r)
    const res = await r.roast(['review', '--format', 'json',
        '--max-severity', 'HIGH', '--deadline', '0',
        '--max-tokens-total', '0', '--max-verified', '0',
        '--request-timeout', '0', '--max-attempts=1'])
    t.equal(res.code, 1, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.findings.length, 1)
    t.equal(report.findings[0].verdict.status, 'confirmed')
    t.equal(report.findings[0].verdict.verifier, VERIFIER_MODEL)
    t.equal(report.verified, true)
    t.equal(report.budgets.verifier_cap, 0)
    t.deepEqual(Object.keys(report.usage).sort(), ['finder', 'verifier'])
    t.equal(report.usage.verifier.calls, 1)

    const sent = requests()
    t.equal(sent.filter(isVerifier).length, 1, 'one verifier call')
    const dirs = runDirs(r)
    t.equal(dirs.length, 1)
    const responses = fs.readFileSync(
        path.join(dirs[0], 'provider-responses.jsonl'), 'utf8')
        .trimEnd().split('\n').map(l => JSON.parse(l))
    t.equal(responses.length, sent.length, 'one line per model call')
    t.deepEqual([...new Set(responses.map(x => x.role))].sort(),
        ['finder', 'verifier'])
    const meta = JSON.parse(fs.readFileSync(
        path.join(dirs[0], 'meta.json'), 'utf8'))
    t.equal(meta.budgets.verifier_cap, 0)
    t.ok(meta.usage.verifier, 'meta records verifier usage')
})

test('the verifier request ends its tools with submit_verdict',
    async t => {
        const r = await verifyRepo(t, script([finding()]))
        const requests = requestRecorder(r)
        const res = await r.roast(['review', '--format', 'json'])
        t.equal(res.code, 0, res.stderr)
        const req = requests().find(isVerifier)
        t.ok(req, 'verifier request sent')
        const names = toolNames(req!)
            .filter(n => n !== '__roast_continue')
        t.equal(names[names.length - 1], 'submit_verdict')
        for (const tool of ['read_file', 'list_files', 'grep_repo']) {
            t.ok(names.indexOf(tool) >= 0 &&
                names.indexOf(tool) < names.length - 1,
            `${tool} before submit_verdict`)
        }
    })

test('a verifier that never submits leaves the run partial', async t => {
    const r = await verifyRepo(t, script([finding()],
        () => ({ stream:chatCalls([], VERIFIER_MODEL) })))
    const res = await r.roast(['review', '--format', 'json'])
    t.equal(res.code, 4, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.findings.length, 1, 'finding kept')
    t.equal(report.findings[0].verdict.undecided, true)
    t.equal(report.findings[0].verdict.status, 'insufficient_context')
})

test('a refuted finding is dropped and the review exits 0', async t => {
    const r = await verifyRepo(t, script([finding()], () => verdictReply({
        status:'refuted', grounding:'value is never negative here',
    })))
    const res = await r.roast(['review', '--format', 'json',
        '--max-severity', 'HIGH'])
    t.equal(res.code, 0, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.findings.length, 0)
    t.equal(report.dropped_findings.length, 1)
    t.equal(report.dropped_findings[0]._drop_reason, 'refuted_by_verifier')
    t.equal(report.assessment, 'NO_FINDINGS')
})

test('--quick and --no-verify make no verifier request', async t => {
    const r = await verifyRepo(t, script([finding()]))
    for (const flag of ['--quick', '--no-verify']) {
        const requests = requestRecorder(r)
        const res = await r.roast(['review', flag, '--format', 'json'])
        t.equal(res.code, 0, res.stderr)
        t.equal(requests().filter(isVerifier).length, 0,
            `${flag}: no verifier request`)
        const report = JSON.parse(res.stdout)
        t.equal(report.verified, false, `${flag}: verified false`)
        t.deepEqual(Object.keys(report.usage), ['finder'])
    }
})

test('zero findings skip the verifier yet report verified', async t => {
    const r = await verifyRepo(t, script([]))
    const requests = requestRecorder(r)
    const res = await r.roast(['review', '--format', 'json'])
    t.equal(res.code, 0, res.stderr)
    t.equal(requests().filter(isVerifier).length, 0)
    const report = JSON.parse(res.stdout)
    t.equal(report.verified, true)
    t.deepEqual(Object.keys(report.usage), ['finder'])
})

test('an invalid verifier role exits 2 unless --no-verify', async t => {
    const r = await verifyRepo(t, script([]),
        { api_key_env:'ROAST_UNSET_VERIFIER_KEY' })
    delete r.env.ROAST_VERIFIER_API_KEY
    const requests = requestRecorder(r)
    const res = await r.roast(['review', '--format', 'json'])
    t.equal(res.code, 2, res.stderr)
    t.equal(requests().length, 0, 'no requests')
    const skipped = await r.roast(['review', '--no-verify',
        '--format', 'json'])
    t.equal(skipped.code, 0, skipped.stderr)
})

test('--max-verified 1 verifies only the first finding', async t => {
    const r = await verifyRepo(t, script([
        finding(),
        finding({ description:'Second', code_quote:'func f(value int)' }),
    ]))
    const requests = requestRecorder(r)
    const res = await r.roast(['review', '--format', 'json',
        '--max-verified', '1'])
    t.equal(res.code, 4, res.stderr)
    t.equal(requests().filter(isVerifier).length, 1,
        'one verifier conversation')
    const report = JSON.parse(res.stdout)
    t.equal(report.findings.length, 2)
    t.ok(!report.findings[0].verdict.undecided, 'first decided')
    t.equal(report.findings[1].verdict.undecided, true, 'second undecided')
    t.equal(report.budgets.verifier_cap, 1)
})

test('aborting during verification still writes the report', async t => {
    const pending = new Set<() => void>()
    t.cleanup(() => { for (const f of pending) f() })
    const controller = new AbortController()
    const r = await verifyRepo(t, script([finding()], () => res => {
        controller.abort()
        return new Promise<void>(resolve => {
            pending.add(() => {
                res.destroy()
                resolve()
            })
        })
    }))
    const res = await r.roast(['review', '--format', 'json'],
        { signal:controller.signal })
    t.equal(res.code, 4, res.stderr)
    const dirs = runDirs(r)
    t.equal(dirs.length, 1)
    t.ok(fs.existsSync(path.join(dirs[0], 'report.md')), 'report.md')
    const result = JSON.parse(readGz(path.join(dirs[0], 'result.json.gz')))
    t.equal(result.findings.length, 1)
    t.equal(result.findings[0].verdict.undecided, true)
})
