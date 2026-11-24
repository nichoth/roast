// Budgets, limits, run-record placement, and output discipline through
// `roast review` (spec 01, 2.8 steps 6-21, 2.12-2.14).
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import type { RecordedRequest, Script } from '../helpers/inference-server.js'
import {
    approveProjectConfig,
    chatCalls,
    finderScript,
    finding,
    findingsReply,
    gitIn,
    profileConfig,
    readGz,
    requestRecorder,
    reviewMeta,
    runDirs,
    runsDir,
    settingsRepo,
    toolNames,
    writeConfig,
    type ReviewRepo,
} from '../helpers/review.js'

const REVIEW = ['review', '--no-verify', '--format', 'json']

type Chat = { model:string, messages:{ role:string, content:string }[] }

function userMessage (req:RecordedRequest):string {
    return (req.body as Chat).messages[1].content
}

function clearRuns (r:ReviewRepo):void {
    fs.rmSync(runsDir(r), { recursive:true, force:true })
}

async function configure (r:ReviewRepo, over:object):Promise<void> {
    writeConfig(r.dir, profileConfig(r.server.url, over))
    await approveProjectConfig(r)
}

test('meta budgets with every budget flag at 0', async t => {
    const r = await settingsRepo(t)
    const res = await r.roast([...REVIEW, '--deadline', '0',
        '--request-timeout', '0', '--max-tokens-total', '0',
        '--max-verified', '0', '--max-attempts=1'])
    t.equal(res.code, 0, res.stderr)
    const { budgets } = reviewMeta(r)
    t.equal(budgets.deadline_duration, '0s', 'deadline')
    t.equal(budgets.request_timeout, '0s', 'request timeout')
    t.equal(budgets.max_total_tokens, 0, 'tokens')
    t.equal(budgets.verifier_cap, 0, 'verifier cap')
    t.equal(budgets.max_attempts, 1, 'attempts')
    t.equal(budgets.max_turns, 16, 'turns')
    t.equal(budgets.max_prompt_bytes, 8_000_000, 'prompt ceiling')
    t.ok(!('ledger_committed_tokens' in budgets), 'no ledger')
    clearRuns(r)
    t.equal((await r.roast(REVIEW)).code, 0, 'default run')
    const defaults = reviewMeta(r).budgets
    t.equal(defaults.deadline_duration, '10m0s', 'default deadline')
    t.equal(typeof defaults.ledger_committed_tokens, 'number',
        'ledger committed tokens recorded')
})

test('config limits apply; flags override for one invocation', async t => {
    const r = await settingsRepo(t)
    await configure(r, {
        limits:{
            deadline:'2m',
            request_timeout:'90s',
            max_total_tokens:2_000_000,
            max_verified:3,
            max_attempts:2,
            max_diff_bytes:500_000,
            max_file_ctx_bytes:300_000,
            max_prompt_bytes:7_000_000,
        },
    })
    const requests = requestRecorder(r)
    t.equal((await r.roast(REVIEW)).code, 0, 'config run')
    let meta = reviewMeta(r)
    t.deepEqual([meta.budgets.deadline_duration, meta.budgets.request_timeout,
        meta.budgets.max_total_tokens, meta.budgets.verifier_cap,
        meta.budgets.max_attempts, meta.budgets.max_prompt_bytes], [
        '2m0s', '1m30s', 2_000_000, 3, 2, 7_000_000,
    ], 'budgets from limits')
    t.equal(meta.derived.max_diff_bytes, 500_000, 'diff bytes')
    t.equal(meta.derived.max_file_ctx_bytes, 300_000, 'file ctx bytes')
    clearRuns(r)
    const flagged = await r.roast([...REVIEW, '--max-attempts', '5',
        '--deadline', '30s', '--finder-model', 'flag-model'])
    t.equal(flagged.code, 0, flagged.stderr)
    meta = reviewMeta(r)
    t.equal(meta.budgets.max_attempts, 5, 'flag attempts')
    t.equal(meta.budgets.deadline_duration, '30s', 'flag deadline')
    t.equal(meta.roles.finder.model, 'flag-model', 'flag model in meta')
    clearRuns(r)
    t.equal((await r.roast(REVIEW)).code, 0, 'next run')
    meta = reviewMeta(r)
    t.equal(meta.budgets.max_attempts, 2, 'flags did not persist')
    t.equal(meta.roles.finder.model, 'finder-model', 'model restored')
    t.deepEqual(requests().map(q => (q.body as Chat).model),
        ['finder-model', 'flag-model', 'finder-model'], 'models sent')
})

test('the session header is sent only by its profile', async t => {
    const r = await settingsRepo(t)
    const cfg = profileConfig(r.server.url) as Record<string, any>
    cfg.inference_profiles.fake.session_header = 'X-Finder-Session'
    cfg.inference_profiles.plain = {
        ...cfg.inference_profiles.fake, session_header:undefined,
    }
    cfg.roles.verifier.profile = 'plain'
    writeConfig(r.dir, cfg)
    await approveProjectConfig(r)
    const requests = requestRecorder(r)
    t.equal((await r.roast(REVIEW)).code, 0, 'finder session run')
    const meta = reviewMeta(r)
    t.equal(meta.roles.finder.session_header, 'X-Finder-Session',
        'finder meta header')
    t.ok(!meta.roles.verifier.session_header, 'verifier meta has none')
    t.ok(requests()[0].headers['x-finder-session'], 'header sent')
    cfg.roles.finder.profile = 'plain'
    writeConfig(r.dir, cfg)
    await approveProjectConfig(r)
    t.equal((await r.roast(REVIEW)).code, 0, 'plain run')
    t.ok(!requests()[1].headers['x-finder-session'], 'not sent by plain')
})

test('records land under the toplevel from a subdirectory', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    const sub = path.join(r.dir, 'sub')
    writeConfig(sub, profileConfig(r.server.url))
    const deeper = path.join(sub, 'deeper')
    fs.mkdirSync(deeper)
    await approveProjectConfig(r, [], deeper)
    const res = await r.roast(REVIEW, { cwd:deeper })
    t.equal(res.code, 0, res.stderr)
    t.equal(runDirs(r).length, 1, 'run under the toplevel')
    t.ok(!fs.existsSync(path.join(sub, '.roast')), 'nothing in sub')
    t.ok(!fs.existsSync(path.join(deeper, '.roast')), 'nothing in cwd')
    t.equal(reviewMeta(r).repo, r.dir, 'meta repo is the toplevel')
})

test('limits.max_diff_bytes truncates the diff sent', async t => {
    const r = await settingsRepo(t)
    const big = Array.from({ length:400 }, (_, i) =>
        `line ${i} of a large change`).join('\n')
    fs.writeFileSync(path.join(r.dir, 'big.txt'), 'start\n')
    gitIn(r, ['add', 'big.txt'])
    gitIn(r, ['commit', '-q', '-m', 'big'])
    fs.writeFileSync(path.join(r.dir, 'big.txt'),
        `start\n${big}\nMARKER-TAIL\n`)
    await configure(r, {
        limits:{ max_diff_bytes:2000, max_file_ctx_bytes:1 },
    })
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    t.equal(JSON.parse(res.stdout).diff_truncated, true, 'diff_truncated')
    t.ok(!userMessage(requests()[0]).includes('MARKER-TAIL'),
        'truncated diff sent')
})

test('limits.max_prompt_bytes too small exits 2 before sending', async t => {
    const r = await settingsRepo(t)
    await configure(r, { limits:{ max_prompt_bytes:100 } })
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 2, 'exit 2')
    t.equal(requests().length, 0, 'no request')
    t.equal(runDirs(r).length, 0, 'no run directory')
})

test('a small diff downgrades --interactive; zero thresholds keep it',
    async t => {
        const submit:Script = req => toolNames(req).includes(
            'submit_findings') ?
            {
                stream:chatCalls([{
                    name:'submit_findings',
                    args:{ assessment:'NO_FINDINGS', findings:[] },
                }]),
            } :
            findingsReply()
        const r = await settingsRepo(t, submit)
        const requests = requestRecorder(r)
        t.equal((await r.roast([...REVIEW, '--interactive'])).code, 0,
            'downgraded run')
        const first = toolNames(requests()[0])
        t.ok(first.includes('findings') && !first.includes('read_file'),
            'one structured call')
        t.equal(requests().length, 1, 'single request')
        t.equal(reviewMeta(r).derived.interactive, false, 'meta')
        clearRuns(r)
        await configure(r, { interactive:{ min_diff_lines:0, min_files:0 } })
        t.equal((await r.roast([...REVIEW, '--interactive'])).code, 0,
            'interactive run')
        const names = toolNames(requests()[1])
        t.ok(names.includes('read_file'), 'exploration tools offered')
        t.ok(names.includes('submit_findings'), 'submit tool offered')
        t.equal(reviewMeta(r).derived.interactive, true, 'meta')
    })

test('review.snapshot false records the disabled snapshot', async t => {
    const r = await settingsRepo(t)
    t.equal((await r.roast(REVIEW)).code, 0, 'review')
    const meta = reviewMeta(r)
    t.equal(meta.snapshot.captured, false, 'not captured')
    t.equal(meta.snapshot.reason, 'disabled by review.snapshot', 'reason')
    t.equal(meta.caveats.length, 1, 'one caveat')
    t.equal(gitIn(r, ['for-each-ref', 'refs/roast/']), '', 'no refs')
})

test('format destinations', async t => {
    const r = await settingsRepo(t, finderScript([finding()]))
    const md = await r.roast(['review', '--no-verify', '--format',
        'markdown'])
    t.equal(md.code, 0, md.stderr)
    t.equal(md.stdout, '', 'markdown writes nothing to stdout')
    const json = await r.roast(REVIEW)
    t.equal(json.code, 0, json.stderr)
    t.ok(json.stderr.split('\n').filter(Boolean)
        .every(l => l.startsWith('roast: ')), 'only log lines on stderr')
    t.ok(md.stderr.split('\n').some(l =>
        l !== '' && !l.startsWith('roast: ')), 'markdown on stderr')
})

test('an incomplete finder result exits 4 after recording', async t => {
    const script:Script = (_req, n) => n === 0 ?
        { stream:chatCalls([{ name:'report_finding', args:finding() }]) } :
        { stream:chatCalls([]) }
    const r = await settingsRepo(t, script)
    await configure(r, { interactive:{ min_diff_lines:0, min_files:0 } })
    const res = await r.roast([...REVIEW, '--interactive'])
    t.equal(res.code, 4, res.stderr)
    const report = JSON.parse(res.stdout)
    t.equal(report.findings.length, 1, 'reported finding kept')
    const run = runDirs(r)[0]
    t.ok(fs.existsSync(path.join(run, 'result.json.gz')), 'result written')
    t.ok(fs.existsSync(path.join(run, 'bundle.tar.zst')), 'bundle written')
    t.equal(JSON.parse(readGz(path.join(run, 'result.json.gz')))
        .findings.length, 1, 'result artifact')
    t.ok(fs.readFileSync(path.join(run, 'findings.jsonl'), 'utf8')
        .trim().length > 0, 'finding spilled')
})
