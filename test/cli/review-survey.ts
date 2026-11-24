// `roast review --scope repo` end to end on a fake `chat` server (spec
// 01, 2.8 steps 9-18; spec 04, 2.12).
import path from 'node:path'
import { test } from '../helpers/test.js'
import type { RecordedRequest, Script } from '../helpers/inference-server.js'
import {
    chatCalls,
    gitIn,
    readGz,
    requestRecorder,
    reviewMeta,
    runDirs,
    settingsRepo,
    toolNames,
} from '../helpers/review.js'

const SURVEY = ['review', '--scope', 'repo', '--no-verify', '--format',
    'json']

type Chat = { messages:{ role:string, content:string }[] }

function userMessage (req:RecordedRequest):string {
    return (req.body as Chat).messages[1].content
}

// Reads main.go on the first call, then submits a clean result.
const readThenSubmit:Script = (_req, n) => n === 0 ?
    {
        stream:chatCalls([{ name:'read_file', args:{ path:'main.go' } }]),
    } :
    {
        stream:chatCalls([{
            name:'submit_findings',
            args:{ assessment:'NO_FINDINGS', findings:[] },
        }]),
    }

test('survey sends the manifest with exploration tools', async t => {
    const r = await settingsRepo(t, readThenSubmit)
    const requests = requestRecorder(r)
    const res = await r.roast(SURVEY)
    t.equal(res.code, 0, res.stderr)
    const reqs = requests()
    t.equal(reqs.length, 2, 'two finder requests')
    const user = userMessage(reqs[0])
    t.ok(user.includes('### Tracked files ###\nmain.go\n'),
        'manifest in the finder user prompt')
    t.ok(!user.includes('diff --git'), 'no diff sent')
    const names = toolNames(reqs[0])
    t.ok(names.includes('read_file'), 'exploration tools offered')
    t.ok(names.includes('submit_findings'), 'submit tool offered')
    const meta = reviewMeta(r)
    t.equal(meta.scope.survey, true, 'scope.survey')
    t.equal(meta.digests.input_kind, 'manifest', 'input kind')
    t.equal(meta.budgets.max_turns, 40, 'survey max_turns default')
    t.equal(meta.derived.interactive, true, 'interactive')
    t.deepEqual(meta.scope.files, ['main.go'], 'files')
    const input = readGz(path.join(runDirs(r)[0], 'input.gz'))
    t.ok(input.startsWith('### Repository snapshot ###\n'),
        'input.gz holds the manifest')
})

test('survey honors --max-turns', async t => {
    const r = await settingsRepo(t, readThenSubmit)
    const res = await r.roast([...SURVEY, '--max-turns', '5'])
    t.equal(res.code, 0, res.stderr)
    t.equal(reviewMeta(r).budgets.max_turns, 5, 'max_turns')
})

test('a converged clean survey is complete', async t => {
    const r = await settingsRepo(t, readThenSubmit)
    const res = await r.roast(SURVEY)
    t.equal(res.code, 0, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.review_kind, 'survey_triage', 'review_kind')
    t.equal(report.completion, 'complete', 'completion')
    t.equal(report.stop_reason, 'converged', 'stop_reason')
    t.equal(report.assessment, 'NO_FINDINGS_IN_SAMPLED_AREAS', 'assessment')
    t.equal(report.manifest_file_count, 1, 'manifest file count')
})

test('a survey cut off by the token budget is partial', async t => {
    const r = await settingsRepo(t, readThenSubmit)
    const res = await r.roast([...SURVEY, '--max-tokens-total', '150'])
    t.equal(res.code, 4, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.review_kind, 'survey_triage', 'review_kind')
    t.equal(report.completion, 'partial', 'completion')
    t.equal(report.stop_reason, 'token_budget', 'stop_reason')
})

test('a diff review carries no survey fields', async t => {
    const r = await settingsRepo(t)
    const res = await r.roast(['review', '--no-verify', '--format', 'json'])
    t.equal(res.code, 0, res.stderr)
    const report = JSON.parse(res.stdout)
    for (const key of ['review_kind', 'completion', 'stop_reason',
        'manifest_file_count']) {
        t.ok(!(key in report), `no ${key}`)
    }
    t.ok(!reviewMeta(r).scope.survey, 'meta scope.survey unset')
})

test('survey of a repository with no commits is NO_DIFF', async t => {
    const r = await settingsRepo(t, readThenSubmit)
    gitIn(r, ['update-ref', '-d', 'HEAD'])
    const requests = requestRecorder(r)
    const res = await r.roast(SURVEY)
    t.equal(res.code, 0, res.stderr)
    t.equal(JSON.parse(res.stdout).assessment, 'NO_DIFF', 'NO_DIFF')
    t.equal(requests().length, 0, 'no finder request')
    t.equal(runDirs(r).length, 0, 'no run directory')
})
