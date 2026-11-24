// Review flag syntax and raw validation (spec 01, 2.6, 2.7, 2.11).
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import {
    approveProjectConfig,
    finderScript,
    gitIn,
    finding,
    profileConfig,
    requestRecorder,
    reviewMeta,
    runDirs,
    settingsRepo,
    writeConfig,
} from '../helpers/review.js'
import { describeReviewFlags } from '../../src/cli/review-flags.js'

const LIMITS = {
    max_attempts:3,
    request_timeout:'1m',
    max_total_tokens:1000,
    max_verified:2,
    deadline:'1m',
}

test('raw flag validation fails before config and requests', async t => {
    const r = await settingsRepo(t)
    writeConfig(r.dir, profileConfig(r.server.url, { limits:LIMITS }))
    await approveProjectConfig(r)
    const requests = requestRecorder(r)
    const cases = [
        ['--staged', '--uncommitted-only'],
        ['--format', 'bogus'],
        ['--max-turns', '0'],
        ['--max-attempts=0'],
        ['--request-timeout=-1s'],
        ['--deadline=-1s'],
        ['--max-tokens-total=-1'],
        ['--max-verified=-1'],
        ['--scope', 'bogus'],
        ['--scope', 'repo', '--quick'],
        ['--scope', 'repo', '--staged'],
        ['--scope', 'repo', '--base', 'HEAD'],
        ['--max-severity', 'bogus'],
        ['--max-attempts', '0x10'],
        ['--max-turns', '1.5'],
        ['--deadline', '10'],
        ['--quick', '--uncommitted-only', '--finder-max-output-tokens=0'],
    ]
    for (const args of cases) {
        const res = await r.roast(['review', '--no-verify',
            '--error-format', 'json', ...args])
        t.equal(res.code, 2, `${args.join(' ')} exits 2`)
        const err = JSON.parse(res.stderr.trim().split('\n').pop() ?? '{}')
        t.equal(err.error_category, 'usage', `${args.join(' ')} is usage`)
    }
    t.equal(requests().length, 0, 'no request sent')
    t.equal(runDirs(r).length, 0, 'no run directory')
})

test('json error output for an invalid --format', async t => {
    const r = await settingsRepo(t)
    const res = await r.roast(['review', '--error-format', 'json',
        '--format', 'invalid'])
    t.equal(res.code, 2, 'exit 2')
    const err = JSON.parse(res.stderr)
    t.equal(err.error_category, 'usage', 'category')
    t.equal(err.exit_code, 2, 'exit code field')
    t.ok(typeof err.message === 'string' && err.message, 'message')
})

test('list flags append across occurrences', async t => {
    const r = await settingsRepo(t)
    const res = await r.roast(['review', '--no-verify', '--format', 'json',
        '--paths', 'a,b', '--paths', 'c', '--exclude', 'x,y'])
    t.equal(res.code, 0, res.stderr)
    // Pathspecs that match nothing give an empty diff: no run record, so
    // check the parse through a review that matches.
    const ok = await r.roast(['review', '--no-verify', '--format', 'json',
        '--paths', 'a,main.go', '--paths', 'c'])
    t.equal(ok.code, 0, ok.stderr)
    const meta = reviewMeta(r)
    t.deepEqual(meta.scope.paths, ['a', 'main.go', 'c'], 'three pathspecs')
    t.deepEqual(meta.scope.files, ['main.go'], 'pathspec reached scope')
})

test('--quick false is read as false', async t => {
    const r = await settingsRepo(t)
    const res = await r.roast(['review', '--no-verify', '--format', 'json',
        '--quick', 'false'])
    t.equal(res.code, 0, res.stderr)
    const derived = reviewMeta(r).derived
    t.ok(derived.quick !== true, 'not quick')
    t.equal(derived.max_diff_bytes, 1_000_000, 'full-review diff budget')
})

test('empty diff exits 0 with NO_DIFF and no run', async t => {
    const r = await settingsRepo(t)
    fs.writeFileSync(path.join(r.dir, '.gitignore'), '.roast.json\n')
    gitIn(r, ['add', '-A'])
    gitIn(r, ['commit', '-q', '-m', 'all'])
    const requests = requestRecorder(r)
    for (const extra of [[], ['--mode', 'bogus'], ['--lang', 'cobol'],
        ['--lang', 'none,go'], ['--max-severity', 'INFO']]) {
        const res = await r.roast(['review', '--no-verify', '--format',
            'json', ...extra])
        t.equal(res.code, 0, `${extra.join(' ')} exits 0`)
        t.equal(JSON.parse(res.stdout).assessment, 'NO_DIFF', 'NO_DIFF')
    }
    t.equal(requests().length, 0, 'no request')
    t.equal(runDirs(r).length, 0, 'no run directory')
})

test('invalid --mode or --lang on a real diff exits 2', async t => {
    const r = await settingsRepo(t, finderScript([finding()]))
    const requests = requestRecorder(r)
    for (const extra of [['--mode', 'bogus'], ['--lang', 'cobol'],
        ['--lang', 'none', '--lang', 'go']]) {
        const res = await r.roast(['review', '--no-verify', '--format',
            'json', ...extra])
        t.equal(res.code, 2, `${extra.join(' ')} exits 2`)
    }
    t.equal(requests().length, 0, 'no request')
})

test('flag help shows the defaults it is given', t => {
    const help = describeReviewFlags({
        limits:{
            deadline:'7m',
            request_timeout:'3m',
            max_total_tokens:123456,
            max_verified:9,
            max_attempts:6,
        },
        maxTurns:11,
        surveyMaxTurns:33,
        surveyDeadline:'21m',
    })
    const cases:[string, string[]][] = [
        ['deadline', ['7m', '21m']],
        ['request-timeout', ['3m']],
        ['max-tokens-total', ['123456']],
        ['max-verified', ['9']],
        ['max-attempts', ['6']],
        ['max-turns', ['11', '33']],
    ]
    for (const [flag, values] of cases) {
        for (const v of values) {
            t.ok(new RegExp(`\\b${v}\\b`).test(help[flag] ?? ''),
                `${flag} help shows ${v}`)
        }
    }
})
