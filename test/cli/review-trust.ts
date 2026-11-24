// Trust and stored credentials through `roast review` (spec 03, 2.8,
// 5.4 and 5.6 review rows): nothing is sent before trust passes, and a
// stored key reaches only the provider it belongs to.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from '../helpers/test.js'
import { simulateTerminals } from '../helpers/terminal.js'
import type { RecordedRequest } from '../helpers/inference-server.js'
import {
    approveProjectConfig,
    profileConfig,
    requestRecorder,
    settingsRepo,
    writeConfig,
    type ReviewRepo,
} from '../helpers/review.js'
import {
    projectCredentialsPath,
    saveCredential,
    userCredentialsPath,
} from '../../src/credentials/credentials.js'

const REVIEW = ['review', '--no-verify', '--format', 'json']

function trustFile (r:ReviewRepo):string {
    return path.join(r.dir, '.git', 'roast', 'trust.json')
}

function bearer (req:RecordedRequest):string {
    return String(req.headers.authorization ?? '')
}

test('an untrusted config fails closed before any request', async t => {
    const r = await settingsRepo(t, undefined, { approve:false })
    const requests = requestRecorder(r)
    const res = await r.roast(REVIEW)
    t.equal(res.code, 2, 'exit 2')
    t.equal(requests().length, 0, 'no request')
    t.ok(!fs.existsSync(trustFile(r)), 'no trust record')
})

test('legacy and malformed trust records send nothing', async t => {
    const r = await settingsRepo(t, undefined, { approve:false })
    const requests = requestRecorder(r)
    fs.mkdirSync(path.dirname(trustFile(r)), { recursive:true })
    fs.writeFileSync(trustFile(r),
        JSON.stringify({ version:1, approved:['old'] }))
    t.equal((await r.roast(REVIEW)).code, 2, 'legacy record exits 2')
    fs.writeFileSync(trustFile(r), '{')
    t.equal((await r.roast(REVIEW)).code, 4, 'malformed record exits 4')
    t.equal(requests().length, 0, 'no request')
})

test('a built-in-only config reviews without trust state', async t => {
    const r = await settingsRepo(t, undefined, { config:null })
    writeConfig(r.dir, {
        version:1,
        inference_profiles:{ o:{ protocol:'chat', model:'gpt-5-mini' } },
        roles:{ finder:{ profile:'o' }, verifier:{ profile:'o' } },
        review:{ snapshot:false },
    })
    r.env.OPENAI_API_KEY = 'ambient-openai-key'
    delete r.env.ROAST_FINDER_API_KEY
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    t.deepEqual(res.hosts, ['api.openai.com'], 'built-in endpoint')
    t.ok(!fs.existsSync(trustFile(r)), 'no trust record written')
})

test('the inline trust prompt approves on y and declines otherwise',
    async t => {
        simulateTerminals(t, true)
        const r = await settingsRepo(t, undefined, { approve:false })
        const requests = requestRecorder(r)
        for (const answer of ['', 'n\n', 'no\n', 'yy\n']) {
            const res = await r.roast(REVIEW, { stdin:answer })
            t.equal(res.code, 2, `${JSON.stringify(answer)} declines`)
            t.ok(!fs.existsSync(trustFile(r)), 'no record')
        }
        t.equal(requests().length, 0, 'declined reviews send nothing')
        const yes = await r.roast(REVIEW, { stdin:'y\n' })
        t.equal(yes.code, 0, yes.stderr)
        t.ok(fs.existsSync(trustFile(r)), 'approval recorded')
        t.equal(requests().length, 1, 'review proceeds')
        t.equal((await r.roast(REVIEW)).code, 0, 'approval persists')
    })

test('without terminals the review never reads stdin', async t => {
    simulateTerminals(t, false)
    const r = await settingsRepo(t, undefined, { approve:false })
    let reads = 0
    const stdin = new Readable({
        read () {
            reads++
            this.push('y\n')
            this.push(null)
        },
    })
    const res = await r.roast(REVIEW, { stdin })
    t.equal(res.code, 2, 'fails closed')
    t.equal(reads, 0, 'stdin never read')
})

// A repo whose finder is on the OpenAI built-in endpoint with chat.
async function storedRepo (t:Parameters<typeof settingsRepo>[0]) {
    const r = await settingsRepo(t, undefined, { config:null })
    writeConfig(r.dir, {
        version:1,
        inference_profiles:{ o:{ protocol:'chat', model:'gpt-5-mini' } },
        roles:{ finder:{ profile:'o' }, verifier:{ profile:'o' } },
        review:{ snapshot:false },
    })
    delete r.env.ROAST_FINDER_API_KEY
    delete r.env.ROAST_VERIFIER_API_KEY
    const project = await projectCredentialsPath(r.dir, { env:r.env })
    const user = userCredentialsPath(r.env)
    return { r, project, user }
}

test('stored keys: env beats project beats user', async t => {
    const { r, project, user } = await storedRepo(t)
    const requests = requestRecorder(r)
    await saveCredential(user, 'openai', 'user-stored-key', new Date())
    t.equal((await r.roast(REVIEW)).code, 0, 'user key works')
    await saveCredential(project, 'openai', 'project-stored-key',
        new Date())
    const res = await r.roast(REVIEW)
    t.equal(res.code, 0, res.stderr)
    t.deepEqual(res.hosts, ['api.openai.com'], 'built-in host')
    r.env.OPENAI_API_KEY = 'env-key'
    t.equal((await r.roast(REVIEW)).code, 0, 'env key works')
    t.deepEqual(requests().map(bearer), [
        'Bearer user-stored-key',
        'Bearer project-stored-key',
        'Bearer env-key',
    ], 'precedence env > project > user')
    for (const out of [res.stdout, res.stderr]) {
        t.ok(!out.includes('project-stored-key'), 'key not printed')
    }
})

test('a stored key never reaches a custom endpoint', async t => {
    const { r, project } = await storedRepo(t)
    await saveCredential(project, 'openai', 'project-stored-key',
        new Date())
    const requests = requestRecorder(r)
    const moved = await r.roast([...REVIEW, '--finder-base-url',
        `${r.server.url}/v1`])
    t.ok(moved.code !== 0, 'no key for the moved finder')
    const custom = profileConfig(r.server.url)
    custom.inference_profiles.fake.api_key_env = 'GATEWAY_KEY'
    writeConfig(r.dir, custom)
    await approveProjectConfig(r)
    const res = await r.roast(REVIEW)
    t.ok(res.code !== 0, 'custom endpoint without its variable fails')
    t.ok(requests().every(req =>
        !bearer(req).includes('project-stored-key')), 'key never sent')
})

test('a changed --finder-base-url withholds the ambient key', async t => {
    const { r } = await storedRepo(t)
    r.env.OPENAI_API_KEY = 'ambient-openai-key'
    const requests = requestRecorder(r)
    await r.roast([...REVIEW, '--finder-base-url', `${r.server.url}/v1`])
    t.ok(requests().every(req =>
        !bearer(req).includes('ambient-openai-key')), 'ambient key withheld')
})

test('a readable credentials file fails the review', async t => {
    for (const scope of ['project', 'user'] as const) {
        const { r, project, user } = await storedRepo(t)
        const file = scope === 'project' ? project : user
        await saveCredential(file, 'openai', 'stored-key', new Date())
        fs.chmodSync(file, 0o644)
        const requests = requestRecorder(r)
        const res = await r.roast(REVIEW)
        t.ok(res.code !== 0, `${scope} file readable by others fails`)
        t.equal(requests().length, 0, 'no request')
    }
})
