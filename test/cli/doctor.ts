import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { tempDir, tempRepo, type TempDir } from '../helpers/repo.js'
import { runRoast } from '../helpers/run.js'
import { saveCredential, projectCredentialsPath, userCredentialsPath }
    from '../../src/credentials/credentials.js'
import { installationTargets, install, skillHooks }
    from '../../src/skill/skill.js'
import { git } from '../../src/git/git.js'
import { startInferenceServer } from '../helpers/inference-server.js'
import { doctorProbe, probeCall } from '../helpers/doctor-probe.js'
import { providerServer } from '../helpers/provider-server.js'
import { doctorHooks } from '../../src/cli/doctor.js'
import { CancelledError } from '../../src/cli/errors.js'

const BUILTIN = {
    version:1,
    inference_profiles:{ o:{ protocol:'chat', model:'m' } },
    roles:{ finder:{ profile:'o' }, verifier:{ profile:'o' } },
}

function doctorRepo (t:CleanupTest):TempDir {
    const r = tempRepo()
    t.cleanup(r.remove)
    const cwd = process.cwd()
    process.chdir(r.dir)
    t.cleanup(() => process.chdir(cwd))
    delete r.env.HTTPS_PROXY
    delete r.env.https_proxy
    delete r.env.NODE_USE_ENV_PROXY
    r.env.ROAST_FINDER_API_KEY = 'finder-test-key'
    r.env.ROAST_VERIFIER_API_KEY = 'verifier-test-key'
    fs.writeFileSync(path.join(r.dir, '.roast.jsonc'),
        JSON.stringify(BUILTIN))
    return r
}

interface Row {
    name:string;
    status:string;
    detail:string;
}

async function doctor (
    r:TempDir,
    args:string[] = [],
    redirectTo?:string
) {
    const server = redirectTo ? undefined : await providerServer(doctorProbe())
    try {
        const res = await runRoast(['doctor', '--json', ...args],
            { cwd:r.dir, env:r.env, redirectTo:redirectTo ?? server?.url })
        const rows:Row[] = res.stdout.startsWith('[') ?
            JSON.parse(res.stdout) : []
        return { ...res, rows }
    } finally {
        await server?.close()
    }
}

test('doctor keeps all local checks after missing or invalid config',
    async t => {
        const r = doctorRepo(t)
        const original = skillHooks.lookPath
        skillHooks.lookPath = async () => false
        t.cleanup(() => { skillHooks.lookPath = original })
        const project = await projectCredentialsPath(r.dir, { env:r.env })
        await saveCredential(project, 'openai', 'secret', new Date())
        fs.unlinkSync(path.join(r.dir, '.roast.jsonc'))
        const missing = await doctor(r)
        t.equal(missing.code, 4, 'missing config fails')
        t.deepEqual(missing.rows.map(x => x.name), [
            'build', 'config-file', 'git', 'git-gate',
            'project-credentials', 'proxy-env', 'agents-skill', 'claude-skill',
        ], 'local checks remain in order')
        t.equal(missing.rows[1].status, 'fail', 'config-file failure')
        fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), '{')
        const invalid = await doctor(r)
        t.equal(invalid.code, 4, 'invalid config fails')
        t.equal(invalid.rows.find(x => x.name === 'config')?.status,
            'fail', 'config failure')
        t.ok(invalid.rows.some(x => x.name === 'agents-skill'),
            'skills still checked')
        const explicit = await doctor(r, ['--config', 'missing.json'])
        t.equal(explicit.rows.find(x => x.name === 'config-file')?.status,
            'pass', 'explicit missing path accepted')
        t.equal(explicit.rows.find(x => x.name === 'config')?.status,
            'fail', 'explicit missing file fails loading')
        fs.writeFileSync(path.join(r.dir, 'custom.json'),
            JSON.stringify(BUILTIN))
        const relative = await doctor(r, ['--config', 'custom.json'])
        t.equal(relative.code, 0, 'relative config uses invocation cwd')
    })

test('doctor checks gate health and only user-level skill installations',
    async t => {
        const r = doctorRepo(t)
        const original = skillHooks.lookPath
        skillHooks.lookPath = async () => false
        t.cleanup(() => { skillHooks.lookPath = original })
        const targets = await installationTargets('', '', { env:r.env })
        await install(targets[0].path, false)
        await git(r.dir, ['config', '--local', 'roast.gate', 'enabled'],
            { env:r.env })
        const res = await doctor(r)
        t.equal(res.code, 0, 'warnings do not fail')
        t.equal(res.rows.find(x => x.name === 'git-gate')?.status,
            'warn', 'enabled but absent gate warns')
        t.equal(res.rows.find(x => x.name === 'agents-skill')?.status,
            'pass', 'user install found')
        fs.writeFileSync(path.join(targets[0].path, 'SKILL.md'), 'stale')
        t.equal((await doctor(r)).rows.find(x =>
            x.name === 'agents-skill')?.status, 'warn', 'stale warns')
        fs.rmSync(targets[0].path, { recursive:true })
        fs.symlinkSync(r.dir, targets[0].path)
        t.equal((await doctor(r)).rows.find(x =>
            x.name === 'agents-skill')?.status, 'pass', 'symlink passes')
        const outside = tempDir()
        t.cleanup(outside.remove)
        outside.env.ROAST_FINDER_API_KEY = 'finder-test-key'
        outside.env.ROAST_VERIFIER_API_KEY = 'verifier-test-key'
        fs.writeFileSync(path.join(outside.dir, '.roast.jsonc'),
            JSON.stringify(BUILTIN))
        const out = await doctor(outside)
        t.equal(out.code, 0, 'outside repository only warns')
        t.equal(out.rows.find(x => x.name === 'git')?.status,
            'warn', 'git warns')
        t.ok(!out.rows.some(x => x.name === 'git-gate'), 'gate omitted')
        const server = await providerServer(doctorProbe())
        t.cleanup(server.close)
        const text = await runRoast(['doctor'], {
            cwd:r.dir, env:r.env, redirectTo:server.url,
        })
        t.equal(text.code, 0, 'text mode')
        t.equal(text.stdout.split('\n').filter(Boolean).length,
            res.rows.length, 'one text line per result')
        t.equal((await doctor(r, ['extra'])).code, 2, 'rejects positional')
    })

export async function approveDoctorConfig (r:TempDir):Promise<void> {
    const res = await runRoast(['trust', '--yes'],
        { cwd:r.dir, env:r.env })
    if (res.code !== 0) throw new Error(res.stderr)
}

test('doctor inspects both stored scopes even with an environment key',
    async t => {
        const r = doctorRepo(t)
        r.env.OPENAI_API_KEY = 'environment-secret'
        const project = await projectCredentialsPath(r.dir, { env:r.env })
        const user = userCredentialsPath(r.env)
        const secret = 'stored-secret-do-not-print'
        for (const file of [project, user]) {
            await saveCredential(file, 'openai', secret, new Date())
        }
        const usable = await doctor(r)
        t.equal(usable.code, 0, usable.stderr)
        for (const scope of ['project', 'user']) {
            const row = usable.rows.find(x => x.name ===
                `${scope}-credentials`)
            t.equal(row?.status, 'pass', `${scope} reported`)
            t.ok(row?.detail.includes('(openai)'), 'provider reported')
        }
        t.ok(!usable.stdout.includes(secret), 'stored key omitted')
        for (const [scope, file] of [['project', project], ['user', user]]) {
            fs.writeFileSync(file, JSON.stringify({
                version:1, providers:{ openai:{ key:secret } }, bogus:true,
            }))
            const broken = await doctor(r)
            t.equal(broken.code, 4, `${scope} broken fails`)
            t.equal(broken.rows.find(x => x.name ===
                `${scope}-credentials`)?.status, 'fail', 'failure row')
            t.ok(broken.rows.some(x => x.name === 'proxy-env'),
                'later checks run')
            t.ok(!(broken.stdout + broken.stderr).includes(secret),
                'no key in error output')
            fs.unlinkSync(file)
        }
        const absent = await doctor(r)
        t.equal(absent.code, 0, 'absent files pass')
        t.ok(!absent.rows.some(x => x.name.endsWith('-credentials')),
            'absent files omitted')
    })

test('doctor never echoes malformed credential JSON', async t => {
    const r = doctorRepo(t)
    const file = userCredentialsPath(r.env)
    const secret = 'leak-key'
    await saveCredential(file, 'openai', secret, new Date())
    fs.writeFileSync(file, `{"key":${secret}}`)
    const res = await doctor(r)
    t.equal(res.code, 4, 'malformed file fails')
    t.equal(res.rows.find(x => x.name === 'user-credentials')?.status,
        'fail', 'scope reports failure')
    t.ok(!(res.stdout + res.stderr).includes(secret),
        'JSON parser context must not expose a key')
})

test('doctor requires clone approval for custom endpoints', async t => {
    const r = doctorRepo(t)
    t.equal((await doctor(r)).rows.find(x =>
        x.name === 'config-trust')?.status, 'pass', 'built-in needs none')
    fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), JSON.stringify({
        ...BUILTIN,
        inference_profiles:{
            o:{
                protocol:'chat',
                model:'m',
                endpoint:'https://gateway.example/v1',
            },
        },
    }))
    const unapproved = await doctor(r)
    t.equal(unapproved.code, 4, 'unapproved fails')
    t.equal(unapproved.rows.find(x => x.name === 'config-trust')?.status,
        'fail', 'trust fails')
    await approveDoctorConfig(r)
    t.equal((await doctor(r)).code, 0, 'v2 approval passes')
    const file = path.join(r.dir, '.git', 'roast', 'trust.json')
    fs.writeFileSync(file, JSON.stringify({ version:1, approved:['old'] }))
    const legacy = await doctor(r)
    t.equal(legacy.code, 4, 'legacy fails')
    const detail = legacy.rows.find(x => x.name === 'config-trust')?.detail
    t.ok(detail?.includes('older Roast'), 'explains legacy approval')
    t.ok(detail?.includes('npx roast trust'), 'names approval command')
    fs.writeFileSync(file, '{')
    t.equal((await doctor(r)).code, 4, 'malformed approval fails')
})

test('doctor diagnoses proxy variables without exposing the URL', async t => {
    const r = doctorRepo(t)
    const secret = 'https://user:proxy-secret@example.com:8080'
    for (const variable of ['HTTPS_PROXY', 'https_proxy']) {
        r.env[variable] = secret
        const res = await doctor(r)
        t.equal(res.code, 0, res.stderr)
        t.equal(res.rows.find(row => row.name === 'proxy-env')?.status,
            'warn', variable)
        t.ok(!res.stdout.includes(secret), 'proxy URL omitted')
        r.env.NODE_USE_ENV_PROXY = '1'
        const honored = await doctor(r)
        t.equal(honored.code, 0, honored.stderr)
        t.equal(honored.rows.find(row => row.name === 'proxy-env')?.status,
            'pass', 'proxy enabled')
        delete r.env[variable]
        delete r.env.NODE_USE_ENV_PROXY
    }
    const res = await doctor(r)
    t.equal(res.code, 0, res.stderr)
    t.equal(res.rows.find(row => row.name === 'proxy-env')?.status,
        'pass', 'no proxy')
})

test('doctor probes models with each role protocol and no key in output',
    async t => {
        const r = doctorRepo(t)
        const probe = doctorProbe()
        const server = await startInferenceServer((req, n) =>
            req.method === 'POST' ? probe(req, n) : { status:204 })
        t.cleanup(server.close)
        r.env.ROAST_FINDER_API_KEY = 'finder-private-key'
        r.env.ROAST_VERIFIER_API_KEY = 'verifier-private-key'
        for (const protocol of ['chat', 'responses', 'anthropic']) {
            fs.writeFileSync(path.join(r.dir, '.roast.jsonc'),
                JSON.stringify({
                    ...BUILTIN,
                    inference_profiles:{
                        o:{
                            model:'m',
                            protocol,
                            endpoint:server.url + '/custom/v1///',
                            session_header:'X-Session',
                        },
                    },
                }))
            await approveDoctorConfig(r)
            const res = await doctor(r, [], server.url)
            t.equal(res.code, 0, `${protocol} adapter is available`)
            t.deepEqual(res.rows.filter(x => !x.name.endsWith('-roundtrip'))
                .slice(4, 10).map(x => [x.name, x.status]), [
                ['finder-credential', 'pass'],
                ['finder-profile', 'pass'],
                ['finder-endpoint', 'pass'],
                ['verifier-credential', 'pass'],
                ['verifier-profile', 'pass'],
                ['verifier-endpoint', 'pass'],
            ], 'endpoint checks retain role order')
            const roundtrips = res.rows.filter(x =>
                x.name.endsWith('-roundtrip'))
            t.deepEqual(roundtrips.map(x => x.status), ['pass', 'pass'],
                'both roundtrips pass')
            const requests = server.requests.splice(0)
                .filter(x => x.method === 'GET')
            t.equal(requests.length, 2, 'one models probe per role')
            for (const [i, req] of requests.entries()) {
                const key = i === 0 ? 'finder-private-key' :
                    'verifier-private-key'
                t.equal(req.method, 'GET', 'models uses GET')
                t.equal(req.path, '/custom/v1/models', 'base slashes removed')
                t.equal(req.rawBody.length, 0, 'no request body')
                t.equal(req.headers['x-session'], undefined,
                    'session header is only for inference')
                t.equal(req.headers.authorization,
                    protocol === 'anthropic' ? undefined : `Bearer ${key}`,
                    'bearer authentication for OpenAI protocols')
                t.equal(req.headers['x-api-key'],
                    protocol === 'anthropic' ? key : undefined,
                    'Anthropic authentication')
                t.equal(req.headers['anthropic-version'],
                    protocol === 'anthropic' ? '2023-06-01' : undefined,
                    'Anthropic version')
            }
            t.ok(!(res.stdout + res.stderr).includes('finder-private-key'),
                'finder key omitted from output')
            t.ok(!(res.stdout + res.stderr).includes('verifier-private-key'),
                'verifier key omitted from output')
        }
    })

test('doctor classifies models status without disclosing response bodies',
    async t => {
        const r = doctorRepo(t)
        let status = 200
        const probe = doctorProbe()
        const server = await startInferenceServer((req, n) =>
            req.method === 'POST' ? probe(req, n) : {
                status, body:r.env.ROAST_FINDER_API_KEY,
            })
        t.cleanup(server.close)
        for (const [code, expected] of [
            [200, 'pass'], [299, 'pass'],
            [401, 'fail'], [403, 'fail'], [500, 'fail'], [503, 'fail'],
            [404, 'warn'], [429, 'warn'],
        ] as const) {
            status = code
            const res = await doctor(r, [], server.url)
            t.equal(res.code, expected === 'fail' ? 4 : 0,
                `HTTP ${code} exit code`)
            const endpoints = res.rows.filter(x =>
                x.name.endsWith('-endpoint'))
            t.deepEqual(endpoints.map(x => x.status), [expected, expected],
                `HTTP ${code} status for both roles`)
            t.ok(endpoints.every(x => x.detail.includes(String(code))),
                'status code in diagnostics')
            t.ok(!(res.stdout + res.stderr).includes(
                r.env.ROAST_FINDER_API_KEY), 'body and key omitted')
        }
    })

test('doctor refuses redirects without sending the key to their target',
    async t => {
        const r = doctorRepo(t)
        const target = await startInferenceServer(() => ({ status:200 }))
        t.cleanup(target.close)
        let status = 301
        const source = await startInferenceServer(() => ({
            status, headers:{ location:target.url + '/stolen' },
        }))
        t.cleanup(source.close)
        for (const code of [301, 302, 303, 307, 308]) {
            status = code
            const res = await doctor(r, [], source.url)
            t.equal(res.code, 4, `HTTP ${code} is an endpoint error`)
            t.deepEqual(res.rows.filter(x =>
                x.name.endsWith('-endpoint')).map(x => x.status),
            ['fail', 'fail'], 'both redirects fail')
        }
        t.equal(target.requests.length, 0, 'redirect target never contacted')
    })

test('doctor times out a models request and continues',
    async t => {
        const r = doctorRepo(t)
        const probe = doctorProbe()
        const deadline = new AbortController()
        const original = doctorHooks.timeout
        let first = true
        doctorHooks.timeout = ms => {
            if (ms !== 5000 || !first) return original(ms)
            first = false
            return deadline.signal
        }
        t.cleanup(() => { doctorHooks.timeout = original })
        const server = await startInferenceServer((req, n) => {
            if (req.method === 'POST') return probe(req, n)
            if (n > 0) return { status:200 }
            return () => {
                deadline.abort(new DOMException('deadline', 'TimeoutError'))
            }
        })
        t.cleanup(server.close)
        const res = await doctor(r, [], server.url)
        t.equal(res.code, 4, 'timeout fails doctor')
        t.equal(res.rows.find(x => x.name === 'finder-endpoint')?.status,
            'fail', 'finder request times out')
        t.ok(res.rows.find(x => x.name === 'finder-endpoint')?.detail
            .includes('deadline'), 'timeout appears in the diagnostic')
        t.equal(res.rows.find(x => x.name === 'verifier-endpoint')?.status,
            'pass', 'verifier still runs')
    })

test('doctor preserves probe deadlines for both roles', async t => {
    const r = doctorRepo(t)
    const deadlines:number[] = []
    const original = doctorHooks.timeout
    doctorHooks.timeout = ms => {
        deadlines.push(ms)
        return original(ms)
    }
    t.cleanup(() => { doctorHooks.timeout = original })
    const res = await doctor(r)
    t.equal(res.code, 0, 'both roles complete their probes')
    t.deepEqual(deadlines, [5000, 35000, 5000, 35000],
        'models and roundtrip deadlines remain unchanged')
})

test('doctor cancellation closes the pending models request', async t => {
    const r = doctorRepo(t)
    const controller = new AbortController()
    let closed!:() => void
    const connectionClosed = new Promise<void>(resolve => { closed = resolve })
    const server = await startInferenceServer(() => res => {
        res.on('close', closed)
        controller.abort(new CancelledError())
    })
    t.cleanup(server.close)
    const res = await runRoast(['doctor', '--json'], {
        cwd:r.dir,
        env:r.env,
        redirectTo:server.url,
        signal:controller.signal,
    })
    await connectionClosed
    t.equal(res.code, 5, 'cancellation exits 5')
    t.ok(res.stderr.includes('cancelled'), 'cancellation is reported')
    t.equal(res.stdout, '', 'no partial doctor results are emitted')
    t.equal(server.requests.length, 1, 'no further probes are sent')
})

test('doctor withholds ambient keys from a custom finder independently',
    async t => {
        const r = doctorRepo(t)
        const server = await providerServer(doctorProbe())
        t.cleanup(server.close)
        delete r.env.ROAST_FINDER_API_KEY
        r.env.OPENAI_API_KEY = 'ambient-key-must-stay-home'
        fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), JSON.stringify({
            ...BUILTIN,
            inference_profiles:{
                custom:{ model:'m', endpoint:'https://gateway.example/v1' },
                direct:{ model:'m', protocol:'anthropic' },
            },
            roles:{
                finder:{ profile:'custom' }, verifier:{ profile:'direct' },
            },
        }))
        await approveDoctorConfig(r)
        const res = await doctor(r, [], server.url)
        t.equal(res.code, 4, 'missing finder key fails doctor')
        t.deepEqual(res.rows.slice(4, 9).map(x => [x.name, x.status]), [
            ['finder-credential', 'fail'],
            ['finder-profile', 'fail'],
            ['verifier-credential', 'pass'],
            ['verifier-profile', 'pass'],
            ['verifier-endpoint', 'pass'],
        ], 'verifier remains independent of finder failure')
        t.ok(res.rows.find(x => x.name === 'finder-credential')?.detail
            .includes('OPENAI_API_KEY'), 'names withheld variable')
        t.ok(!res.rows.some(x => x.name === 'finder-endpoint'),
            'invalid finder is not probed')
        t.ok(res.hosts.length > 0 &&
            res.hosts.every(h => h === 'api.anthropic.com'),
        'only verifier endpoint contacted')
        t.ok(server.credentials.length > 0 && server.credentials.every(k =>
            k === r.env.ROAST_VERIFIER_API_KEY), 'only verifier key sent')
        t.ok(!(res.stdout + res.stderr).includes(r.env.OPENAI_API_KEY),
            'withheld key omitted from output')
    })

test('doctor reports stored credential scopes through role resolution',
    async t => {
        const r = doctorRepo(t)
        const server = await providerServer(doctorProbe())
        t.cleanup(server.close)
        delete r.env.ROAST_FINDER_API_KEY
        delete r.env.ROAST_VERIFIER_API_KEY
        const project = await projectCredentialsPath(r.dir, { env:r.env })
        const user = userCredentialsPath(r.env)
        for (const [scope, file] of [['project', project], ['user', user]]) {
            const key = `${scope}-private-key`
            await saveCredential(file, 'openai', key, new Date())
            const res = await doctor(r, [], server.url)
            t.equal(res.code, 0, `${scope} stored key works`)
            const sources = res.rows.filter(x =>
                x.name.endsWith('-credential'))
            t.deepEqual(sources.map(x => x.status), ['pass', 'pass'],
                'both roles find stored credential')
            t.ok(sources.every(x => x.detail.includes(scope) &&
                x.detail.includes('openai')), 'scope and provider reported')
            t.deepEqual(server.requests.splice(0)
                .filter(x => x.method === 'GET')
                .map(x => x.headers.authorization),
            [`Bearer ${key}`, `Bearer ${key}`], 'stored key sent')
            t.ok(!(res.stdout + res.stderr).includes(key),
                'stored key omitted from output')
            fs.unlinkSync(file)
        }
    })

test('doctor skips invalid profiles while retaining later diagnostics',
    async t => {
        const r = doctorRepo(t)
        const server = await providerServer(doctorProbe())
        t.cleanup(server.close)
        for (const model of ['', '<finder-model>']) {
            fs.writeFileSync(path.join(r.dir, '.roast.jsonc'),
                JSON.stringify({
                    ...BUILTIN, inference_profiles:{ o:{ model } },
                }))
            const res = await doctor(r, [], server.url)
            t.equal(res.code, 4, 'unusable model fails')
            t.deepEqual(res.rows.slice(4, 8).map(x => [x.name, x.status]), [
                ['finder-credential', 'pass'], ['finder-profile', 'fail'],
                ['verifier-credential', 'pass'], ['verifier-profile', 'fail'],
            ], 'validation failure skips endpoint checks')
        }
        fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), JSON.stringify({
            ...BUILTIN, roles:{},
        }))
        const res = await doctor(r, [], server.url)
        t.deepEqual(res.rows.slice(4, 6).map(x => [x.name, x.status]), [
            ['finder-profile', 'fail'], ['verifier-profile', 'fail'],
        ], 'unconfigured roles produce only failed profiles')
        t.ok(res.rows.some(x => x.name === 'proxy-env'), 'local checks run')
        t.equal(server.requests.length, 0, 'no invalid profile is probed')
    })

test('doctor makes no requests until custom endpoint trust is current',
    async t => {
        const r = doctorRepo(t)
        const probe = doctorProbe()
        const server = await startInferenceServer((req, n) =>
            req.method === 'POST' ? probe(req, n) : { status:200 })
        t.cleanup(server.close)
        fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), JSON.stringify({
            ...BUILTIN,
            inference_profiles:{
                o:{ protocol:'chat', model:'m', endpoint:server.url + '/v1' },
            },
        }))
        const unapproved = await doctor(r, [], server.url)
        t.equal(unapproved.code, 4, 'unapproved config fails')
        t.equal(server.requests.length, 0, 'no unapproved requests')
        t.deepEqual(unapproved.rows.slice(4, 8).map(x => [x.name, x.status]), [
            ['finder-credential', 'pass'], ['finder-profile', 'pass'],
            ['verifier-credential', 'pass'], ['verifier-profile', 'pass'],
        ], 'local role checks still run')
        t.ok(!unapproved.rows.some(x => x.name.endsWith('-endpoint')),
            'no endpoint rows for untrusted config')
        const file = path.join(r.dir, '.git', 'roast', 'trust.json')
        fs.mkdirSync(path.dirname(file), { recursive:true })
        for (const record of [
            JSON.stringify({ version:1, approved:['Go-era-approval'] }), '{',
        ]) {
            fs.writeFileSync(file, record)
            const res = await doctor(r, [], server.url)
            t.equal(res.code, 4, 'unusable trust record fails')
            t.equal(server.requests.length, 0, 'no requests with bad trust')
            t.ok(!res.rows.some(x => x.name.endsWith('-endpoint')),
                'no probes with bad trust')
        }
        fs.writeFileSync(file, JSON.stringify({ version:1, approved:[] }))
        await approveDoctorConfig(r)
        const approved = await doctor(r, [], server.url)
        t.equal(approved.code, 0, 'trust --yes permits probes')
        t.deepEqual(server.requests.filter(x => x.method === 'GET')
            .map(x => [x.method, x.path]), [
            ['GET', '/v1/models'], ['GET', '/v1/models'],
        ], 'approved endpoint probed once per role')
        t.deepEqual(server.requests.filter(x => x.method === 'GET')
            .map(x => x.headers.authorization), [
            'Bearer finder-test-key', 'Bearer verifier-test-key',
        ], 'approved probes use explicit role credentials')
    })

test('doctor bounds models body reads and hides reflected credentials',
    async t => {
        const r = doctorRepo(t)
        const probe = doctorProbe()
        const server = await startInferenceServer((req, n) => {
            if (req.method === 'POST') return probe(req, n)
            return res => {
                const key = String(req.headers.authorization).slice(7)
                res.writeHead(200, key)
                // The probe must finish after 32 KiB even without an EOF.
                res.write(Buffer.alloc(32 * 1024, 'x'))
            }
        })
        t.cleanup(server.close)
        const res = await doctor(r, [], server.url)
        t.equal(res.code, 0, 'large unterminated body does not time out')
        t.deepEqual(res.rows.filter(x =>
            x.name.endsWith('-endpoint')).map(x => x.status),
        ['pass', 'pass'], 'both models requests succeed at the body limit')
        t.ok(!(res.stdout + res.stderr).includes(r.env.ROAST_FINDER_API_KEY),
            'key reflected in status text is redacted')
        t.ok(!(res.stdout + res.stderr).includes(r.env.ROAST_VERIFIER_API_KEY),
            'verifier key reflected in status text is redacted')
    })

test('doctor chat roundtrip uses two turns with a stable prefix', async t => {
    const r = doctorRepo(t)
    const server = await providerServer(doctorProbe())
    t.cleanup(server.close)
    const res = await doctor(r, [], server.url)
    t.equal(res.code, 0, res.stderr)
    t.deepEqual(res.rows.filter(x => x.name.endsWith('-roundtrip'))
        .map(x => [x.name, x.status]), [
        ['finder-roundtrip', 'pass'], ['verifier-roundtrip', 'pass'],
    ], 'both roles complete the tool loop')
    t.deepEqual(server.requests.map(x => [x.method, x.path]), [
        ['GET', '/v1/models'],
        ['POST', '/v1/chat/completions'],
        ['POST', '/v1/chat/completions'],
        ['GET', '/v1/models'],
        ['POST', '/v1/chat/completions'],
        ['POST', '/v1/chat/completions'],
    ], 'each endpoint probe is followed by exactly two inference requests')
})

test('doctor rejects a guessed token without doctor_lookup', async t => {
    const r = doctorRepo(t)
    const server = await providerServer(() =>
        probeCall('doctor_probe', { ok:true, token:'roast-doctor-guess' }))
    t.cleanup(server.close)
    const res = await doctor(r, [], server.url)
    t.equal(res.code, 4, 'guessing does not pass doctor')
    const rows = res.rows.filter(x => x.name.endsWith('-roundtrip'))
    t.deepEqual(rows.map(x => x.status), ['fail', 'fail'],
        'both roles must roundtrip the lookup token')
    t.ok(rows.every(x => x.detail.includes('doctor_lookup')),
        'diagnostic identifies the skipped lookup')
    t.equal(server.requests.filter(x => x.method === 'POST').length, 2,
        'one rejected final answer per role')
})

test('doctor rejects a changed lookup token on the final turn', async t => {
    const r = doctorRepo(t)
    const server = await providerServer(req => {
        const body = req.body as { messages:{ role:string }[] }
        return body.messages.some(x => x.role === 'tool') ?
            probeCall('doctor_probe', { ok:true, token:'changed-token' }) :
            probeCall('doctor_lookup', {})
    })
    t.cleanup(server.close)
    const res = await doctor(r, [], server.url)
    t.equal(res.code, 4, 'lookup alone does not prove a roundtrip')
    t.deepEqual(res.rows.filter(x => x.name.endsWith('-roundtrip'))
        .map(x => x.status), ['fail', 'fail'], 'changed token fails')
    t.equal(server.requests.filter(x => x.method === 'POST').length, 4,
        'both roles reached the second turn')
})

test('doctor sends the configured session header on both chat turns',
    async t => {
        const r = doctorRepo(t)
        fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), JSON.stringify({
            ...BUILTIN,
            inference_profiles:{
                o:{
                    protocol:'chat',
                    model:'m',
                    session_header:'X-Doctor-Session',
                },
            },
        }))
        const server = await providerServer(doctorProbe())
        t.cleanup(server.close)
        const res = await doctor(r, [], server.url)
        t.equal(res.code, 0, res.stderr)
        const requests = server.requests.filter(x => x.method === 'POST')
        t.equal(requests.length, 4, 'two turns per role')
        const sessions = requests.map(x => x.headers['x-doctor-session'])
        t.ok(sessions.every(x => typeof x === 'string' &&
            /^roast-[A-Z2-7]{26}$/.test(x)), 'session IDs sent')
        t.equal(sessions[0], sessions[1], 'finder session survives replay')
        t.equal(sessions[2], sessions[3], 'verifier session survives replay')
        t.ok(sessions[0] !== sessions[2], 'roles use separate sessions')
        t.ok(server.requests.filter(x => x.method === 'GET').every(x =>
            x.headers['x-doctor-session'] === undefined),
        'session header remains absent from models checks')
    })

test('doctor emits approved chat diagnostics for an explicit config',
    async t => {
        const r = doctorRepo(t)
        delete r.env.ROAST_FINDER_API_KEY
        delete r.env.ROAST_VERIFIER_API_KEY
        const secret = 'doctor-key-never-print'
        r.env.DOCTOR_KEY = secret
        const file = path.join(r.dir, 'diagnostic.json')
        fs.writeFileSync(file, JSON.stringify({
            ...BUILTIN,
            inference_profiles:{
                o:{ protocol:'chat', model:'m', api_key_env:'DOCTOR_KEY' },
            },
        }))
        const server = await providerServer(doctorProbe())
        t.cleanup(server.close)
        const approved = await runRoast([
            'trust', '--yes', '--config', file,
        ], { cwd:r.dir, env:r.env })
        t.equal(approved.code, 0, approved.stderr)
        const res = await doctor(r, ['--config', file], server.url)
        t.equal(res.code, 0, res.stderr)
        t.ok(Array.isArray(JSON.parse(res.stdout)) && res.rows.length >= 8,
            'stdout is a complete JSON result array')
        t.equal(res.rows.find(x => x.name === 'finder-credential')?.detail,
            'DOCTOR_KEY (profile api_key_env)', 'names credential source')
        t.deepEqual(res.rows.slice(4, 12).map(x => [x.name, x.status]), [
            ['finder-credential', 'pass'], ['finder-profile', 'pass'],
            ['finder-endpoint', 'pass'], ['finder-roundtrip', 'pass'],
            ['verifier-credential', 'pass'], ['verifier-profile', 'pass'],
            ['verifier-endpoint', 'pass'], ['verifier-roundtrip', 'pass'],
        ], 'role checks and probes remain in specified order')
        t.ok(!(res.stdout + res.stderr).includes(secret),
            'secret absent from output')
        t.ok(server.requests.every(x =>
            x.headers.authorization === `Bearer ${secret}`),
        'profile credential reaches both kinds of request')
    })

for (const [protocol, endpoint] of [
    ['responses', '/v1/responses'],
    ['anthropic', '/v1/messages'],
] as const) {
    test(`doctor ${protocol} roundtrip uses two turns with a stable prefix`,
        async t => {
            const r = doctorRepo(t)
            fs.writeFileSync(path.join(r.dir, '.roast.jsonc'),
                JSON.stringify({
                    ...BUILTIN,
                    inference_profiles:{ o:{ protocol, model:'m' } },
                }))
            const server = await providerServer(doctorProbe())
            t.cleanup(server.close)
            const res = await doctor(r, [], server.url)
            t.equal(res.code, 0, res.stderr)
            t.deepEqual(res.rows.filter(x => x.name.endsWith('-roundtrip'))
                .map(x => [x.name, x.status]), [
                ['finder-roundtrip', 'pass'],
                ['verifier-roundtrip', 'pass'],
            ], 'both roles complete the tool loop')
            t.deepEqual(server.requests.map(x => [x.method, x.path]), [
                ['GET', '/v1/models'],
                ['POST', endpoint],
                ['POST', endpoint],
                ['GET', '/v1/models'],
                ['POST', endpoint],
                ['POST', endpoint],
            ], 'each role makes exactly two inference requests')
        })
}
