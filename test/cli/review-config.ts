// Config discovery, roles, and prompt overrides through `roast review`
// (spec 01, 2.8 steps 2-4; section 5 "Config discovery", "Settings").
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { tempDir } from '../helpers/repo.js'
import { runRoast } from '../helpers/run.js'
import type { RecordedRequest } from '../helpers/inference-server.js'
import {
    approveProjectConfig,
    profileConfig,
    requestRecorder,
    reviewMeta,
    settingsRepo,
    writeConfig,
} from '../helpers/review.js'

type Chat = { model:string, messages:{ role:string, content:string }[] }

function chat (req:RecordedRequest):Chat {
    return req.body as Chat
}

function withModel (url:string, model:string, over:object = {}) {
    const cfg = profileConfig(url, over)
    cfg.inference_profiles.fake.model = model
    return cfg
}

const REVIEW = ['review', '--no-verify', '--format', 'json']

test('a JSONC config with comments is used', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    const json = JSON.stringify(withModel(r.server.url, 'jsonc-model'),
        null, 2)
    fs.writeFileSync(path.join(r.dir, '.roast.jsonc'),
        '// project config\n' + json.replace(/\n}$/, ',\n}') + '\n')
    await approveProjectConfig(r)
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    t.equal(chat(requests()[0]).model, 'jsonc-model', 'JSONC model used')
})

test('the nearest config below the toplevel wins; --config overrides',
    async t => {
        const r = await settingsRepo(t, undefined, { config:null })
        writeConfig(r.dir, withModel(r.server.url, 'top-model'))
        const sub = path.join(r.dir, 'sub', 'deeper')
        writeConfig(path.join(r.dir, 'sub'),
            withModel(r.server.url, 'sub-model'))
        fs.mkdirSync(sub, { recursive:true })
        await approveProjectConfig(r, [], sub)
        const requests = requestRecorder(r)
        const res = await r.roast(REVIEW, { cwd:sub })
        t.equal(res.code, 0, res.stderr)
        t.equal(chat(requests()[0]).model, 'sub-model', 'nearest config')
        writeConfig(r.dir, withModel(r.server.url, 'alt-model'), 'alt.json')
        await approveProjectConfig(r, ['--config', 'alt.json'])
        const alt = await r.roast([...REVIEW, '--config', 'alt.json'])
        t.equal(alt.code, 0, alt.stderr)
        t.equal(chat(requests()[1]).model, 'alt-model', '--config wins')
    })

test('invalid and missing configs are usage errors', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    const requests = requestRecorder(r)
    const missing = await r.roast(REVIEW)
    t.equal(missing.code, 2, 'missing config exits 2')
    t.ok(missing.stderr.includes('npx roast init'), 'names npx roast init')
    fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), '{')
    t.equal((await r.roast(REVIEW)).code, 2, 'invalid config exits 2')
    fs.writeFileSync(path.join(r.dir, '.roast.jsonc'),
        JSON.stringify({ version:1, bogus:true }))
    t.equal((await r.roast(REVIEW)).code, 2, 'unknown key exits 2')
    t.equal(requests().length, 0, 'no request')
})

test('the user config directory is never read', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    const cfg = JSON.stringify(profileConfig(r.server.url))
    for (const dir of [
        path.join(r.env.XDG_CONFIG_HOME, 'roast'),
        r.env.HOME,
        path.join(r.env.HOME, '.roast'),
    ]) {
        fs.mkdirSync(dir, { recursive:true })
        fs.writeFileSync(path.join(dir, '.roast.jsonc'), cfg)
        fs.writeFileSync(path.join(dir, 'config.json'), cfg)
    }
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 2, 'no project config exits 2')
    t.equal(requests().length, 0, 'no request')
})

test('prompt overrides resolve against the config directory', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    const cfgDir = path.join(r.dir, 'tools')
    fs.mkdirSync(path.join(cfgDir, 'prompts'), { recursive:true })
    fs.writeFileSync(path.join(cfgDir, 'prompts', 'finder.md'),
        'CUSTOM-FINDER-MARKER\n')
    writeConfig(cfgDir, profileConfig(r.server.url, {
        prompts:{ finder_code:'prompts/finder.md' },
    }))
    const work = path.join(cfgDir, 'nested')
    fs.mkdirSync(work)
    await approveProjectConfig(r, [], work)
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW, { cwd:work })
    t.equal(res.code, 0, res.stderr)
    const system = chat(requests()[0]).messages[0].content
    t.ok(system.startsWith('CUSTOM-FINDER-MARKER'), 'override used')
    t.ok(!fs.existsSync(path.join(work, 'prompts')), 'no local copy')
})

test('review outside Git: explicit fails, bare shows help', async t => {
    const d = tempDir()
    t.cleanup(d.remove)
    fs.writeFileSync(path.join(d.dir, 'cfg.json'),
        JSON.stringify(profileConfig('http://127.0.0.1:9')))
    const env = { ...d.env, ROAST_FINDER_API_KEY:'k' }
    const explicit = await runRoast(['review', '--config', 'cfg.json',
        '--no-verify'], { cwd:d.dir, env })
    t.equal(explicit.code, 2, 'review --config outside Git exits 2')
    const bare = await runRoast([], { cwd:d.dir, env })
    t.equal(bare.code, 0, 'bare roast exits 0')
    t.ok(bare.stdout.length > 0, 'help on stdout')
})

test('--author-model flips the finder per author routes', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    const cfg = profileConfig(r.server.url) as Record<string, any>
    cfg.inference_profiles.fake.model = 'claude-finder'
    cfg.inference_profiles.alt = {
        ...cfg.inference_profiles.fake, model:'gpt-5-mini',
    }
    cfg.roles.finder.author_routes = { anthropic:'alt' }
    writeConfig(r.dir, cfg)
    await approveProjectConfig(r)
    const requests = requestRecorder(r)
    const flipped = await r.roast([...REVIEW, '--author-model',
        'claude-sonnet-4'])
    t.equal(flipped.code, 0, flipped.stderr)
    t.equal(chat(requests()[0]).model, 'gpt-5-mini', 'finder flipped')
    t.equal(reviewMeta(r).roles.finder.profile, 'alt', 'meta profile')
    r.env.ROAST_AUTHOR_MODEL = 'claude-sonnet-4'
    const env = await r.roast(REVIEW)
    t.equal(env.code, 0, env.stderr)
    t.equal(chat(requests()[1]).model, 'claude-finder',
        'ROAST_AUTHOR_MODEL changes nothing')
})

test('removed environment variables change nothing', async t => {
    const r = await settingsRepo(t)
    Object.assign(r.env, {
        ROAST_FINDER_MODEL:'env-model',
        ROAST_DEADLINE:'1s',
        ROAST_MAX_TOKENS_TOTAL:'5',
        ROAST_MAX_ATTEMPTS:'9',
        ROAST_REQUEST_TIMEOUT:'1s',
        ROAST_FINDER_BASE_URL:'http://env-host.example/v1',
        OPENAI_BASE_URL:'http://env-host.example/v1',
        ANTHROPIC_BASE_URL:'http://env-host.example',
        ROAST_SNAPSHOT:'1',
        ROAST_NO_HOOK:'1',
    })
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    t.deepEqual(res.hosts, [new URL(r.server.url).host],
        'only the configured endpoint')
    t.equal(chat(requests()[0]).model, 'finder-model', 'model unchanged')
    const meta = reviewMeta(r)
    t.equal(meta.budgets.deadline_duration, '10m0s', 'deadline default')
    t.equal(meta.budgets.request_timeout, '10m0s', 'timeout default')
    t.equal(meta.budgets.max_total_tokens, 3_000_000, 'tokens default')
    t.equal(meta.budgets.max_attempts, 4, 'attempts default')
    t.equal(meta.snapshot.captured, false, 'snapshot still disabled')
})

