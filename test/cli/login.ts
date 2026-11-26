import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from '../helpers/test.js'
import { tempDir, tempRepo } from '../helpers/repo.js'
import { runRoast } from '../helpers/run.js'
import { providerServer } from '../helpers/provider-server.js'
import {
    captureBrowser,
    simulateTerminals,
} from '../helpers/terminal.js'
import {
    loadCredentials,
    saveCredential,
} from '../../src/credentials/credentials.js'
import { loadProjectConfig } from '../../src/cli/config.js'
import { resolveRole } from '../../src/config/role.js'

test('no-argument login deduplicates providers and ignores custom endpoints',
    async t => {
        for (const custom of [false, true]) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await providerServer()
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'),
                JSON.stringify({
                    version:1,
                    inference_profiles:{
                        a:{ protocol:'anthropic', model:'claude-x' },
                        b:{
                            protocol:'anthropic',
                            model:'claude-y',
                            ...(custom ? {
                                endpoint:'https://custom.example/v1',
                            } : {})
                        },
                    },
                    roles:{
                        finder:{ profile:'a' },
                        verifier:{ profile:'b' }
                    },
                }))
            const result = await runRoast(['login', '--no-browser'], {
                cwd:repo.dir,
                env:repo.env,
                stdin:'sk-only-answer\n',
                redirectTo:server.url,
            })
            t.equal(result.code, 0, 'one answer is sufficient')
            t.deepEqual(server.credentials, ['sk-only-answer'],
                'only the missing built-in provider is checked once')
        }
    })

test('no-argument login stops on failure while keeping earlier keys',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        const opened = captureBrowser(t)
        fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'), JSON.stringify({
            version:1,
            inference_profiles:{
                a:{ protocol:'anthropic', model:'claude-x' },
                o:{ protocol:'chat', model:'gpt-x' },
            },
            roles:{ finder:{ profile:'a' }, verifier:{ profile:'o' } },
        }))
        const file = path.join(repo.dir, '.env.roast')
        simulateTerminals(t, false)
        const noninteractive = await runRoast(['login'], {
            cwd:repo.dir, env:repo.env, redirectTo:server.url,
        })
        t.equal(noninteractive.code, 2, 'missing key needs a terminal')
        t.equal(opened.length, 0, 'no browser before terminal check')
        t.ok(!fs.existsSync(file), 'no file before terminal check')
        simulateTerminals(t, true)
        server.hooks.answerModels = key => key.startsWith('Bearer ') ?
            503 : 200
        const failed = await runRoast(['login', '--no-browser'], {
            cwd:repo.dir,
            env:repo.env,
            stdin:'sk-first-saved\nsk-second-fails\n',
            redirectTo:server.url,
        })
        t.equal(failed.code, 4, 'second provider failure is returned')
        const entries = await loadCredentials(file)
        t.equal(entries.get('anthropic')?.key, 'sk-first-saved',
            'successful earlier login stays stored')
        t.equal(entries.has('openai'), false, 'failed login is not stored')
        t.equal(server.requests.length, 2, 'first failure stops loop')
    })

test('no-argument login rejects broken stored files before opening browser',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        const opened = captureBrowser(t)
        fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'), JSON.stringify({
            version:1,
            inference_profiles:{ a:{ protocol:'anthropic', model:'claude' } },
            roles:{ finder:{ profile:'a' } },
        }))
        const file = path.join(repo.dir, '.env.roast')
        fs.mkdirSync(path.dirname(file), { recursive:true })
        fs.writeFileSync(file, '{"key":"private-broken-key"', { mode:0o600 })
        const before = fs.readFileSync(file, 'utf8')
        const result = await runRoast(['login'], {
            cwd:repo.dir, env:repo.env, redirectTo:server.url,
        })
        t.equal(result.code, 2, 'credential resolution error is usage error')
        t.equal(fs.readFileSync(file, 'utf8'), before, 'bad file unchanged')
        t.deepEqual(opened, [], 'no browser')
        t.deepEqual(server.requests, [], 'no validation')
        t.ok(!result.stderr.includes('private-broken-key'), 'value-free error')
    })

test('no-argument login without config has no side effects', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    const opened = captureBrowser(t)
    for (const flags of [[], ['--global']]) {
        const result = await runRoast(['login', ...flags], {
            cwd:repo.dir,
            env:repo.env,
            redirectTo:server.url,
            stdin:'unused-key\n',
        })
        t.equal(result.code, 2, 'missing config is a usage error')
    }
    t.deepEqual(server.requests, [], 'no requests')
    t.deepEqual(opened, [], 'no browser opens')
    t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
        'no project state')
    t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME, 'roast')),
        'no user state')
})

test('no-argument login skips every credential source before terminal check',
    async t => {
        for (const source of ['provider', 'role', 'profile', 'project',
            'user']) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await providerServer()
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            const opened = captureBrowser(t)
            const env = { ...repo.env }
            const project = path.join(repo.dir, '.env.roast')
            const user = path.join(env.XDG_CONFIG_HOME, 'roast',
                'credentials.json')
            if (source === 'project' || source === 'user') {
                await saveCredential(source === 'project' ? project : user,
                    'anthropic', 'existing-key', new Date())
            } else {
                const variable = source === 'provider' ?
                    'ANTHROPIC_API_KEY' : source === 'role' ?
                        'ROAST_FINDER_API_KEY' : 'PROFILE_KEY'
                env[variable] = 'existing-key'
            }
            fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'),
                JSON.stringify({
                    version:1,
                    inference_profiles:{
                        a:{
                            protocol:'anthropic',
                            model:'claude-x',
                            api_key_env:'PROFILE_KEY'
                        },
                        o:{ protocol:'chat', model:'gpt-x' },
                    },
                    roles:{
                        finder:{ profile:'a' },
                        verifier:{ profile:'o' }
                    },
                }))
            const result = await runRoast(['login', '--global'], {
                cwd:repo.dir,
                env,
                redirectTo:server.url,
                stdin:'sk-openai-new\n',
            })
            t.equal(result.code, 0, `${source}: other provider logged in`)
            t.deepEqual(server.credentials, ['Bearer sk-openai-new'],
                'covered provider is never validated')
            t.deepEqual(opened, ['https://platform.openai.com/api-keys'],
                'only missing provider opens')
            const before = fs.readFileSync(user, 'utf8')
            simulateTerminals(t, false)
            const covered = await runRoast(['login'], {
                cwd:repo.dir, env, redirectTo:server.url,
            })
            t.equal(covered.code, 0, 'all covered needs no terminal')
            t.equal(server.requests.length, 1, 'no further requests')
            t.equal(opened.length, 1, 'no further browser opens')
            t.equal(fs.readFileSync(user, 'utf8'), before,
                'stored keys unchanged')
        }
    })

test('no-argument login reads both providers from one stdin in role order',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        const opened = captureBrowser(t)
        fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'), JSON.stringify({
            version:1,
            inference_profiles:{
                a:{ protocol:'anthropic', model:'claude-x' },
                o:{ protocol:'chat', model:'gpt-x' },
            },
            roles:{ verifier:{ profile:'o' }, finder:{ profile:'a' } },
        }))
        const result = await runRoast(['login'], {
            cwd:repo.dir,
            env:repo.env,
            redirectTo:server.url,
            stdin:'sk-anthropic-first\nsk-openai-second\n',
        })
        t.equal(result.code, 0, 'both logins succeed')
        t.deepEqual(server.credentials,
            ['sk-anthropic-first', 'Bearer sk-openai-second'],
            'finder precedes verifier regardless of config order')
        const entries = await loadCredentials(path.join(repo.dir,
            '.env.roast'))
        t.equal(entries.get('anthropic')?.key, 'sk-anthropic-first',
            'first answer saved for finder')
        t.equal(entries.get('openai')?.key, 'sk-openai-second',
            'buffered second answer saved for verifier')
        t.equal(opened.length, 2, 'each provider opened once')
    })

test('Ctrl-C at a raw-mode login prompt cancels without storing a key',
    async t => {
        for (const provider of ['openai', 'anthropic']) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await providerServer()
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            const rawCalls:Array<boolean> = []
            const stdin = Object.assign(new PassThrough(), {
                isTTY:true,
                setRawMode:(on:boolean) => { rawCalls.push(on) },
            })
            t.cleanup(() => { stdin.destroy() })
            stdin.end('sk-partial-A1B2\x03sk-unused-C3D4\r')
            const result = await runRoast(['login', provider], {
                cwd:repo.dir,
                env:repo.env,
                stdin,
                redirectTo:server.url,
            })
            t.equal(result.code, 5, 'raw Ctrl-C is cancellation')
            t.deepEqual(rawCalls, [true, false], 'raw mode restored')
            t.equal(server.requests.length, 0, 'partial key is never sent')
            t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                'no project state written')
            t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
                'roast')), 'no user state written')
            t.equal(result.stdout, '', 'no success output')
            t.ok(!result.stderr.includes('sk-partial-A1B2'),
                'partial key is not echoed')
        }
    })

test('stdin EOF before a pasted key exits 4 and writes nothing', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    captureBrowser(t)
    const result = await runRoast(['login', 'anthropic'], {
        cwd:repo.dir,
        env:repo.env,
        stdin:'',
        redirectTo:server.url,
    })
    t.equal(result.code, 4, 'EOF is a read failure')
    t.equal(server.requests.length, 0, 'no key validation')
    t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
        'no project state written')
    t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
        'roast')), 'no user state written')
})

test('login refuses every redirect without forwarding either auth header',
    async t => {
        const target = await providerServer()
        t.cleanup(() => target.close())
        for (const provider of ['openai', 'anthropic']) {
            for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
                const repo = tempRepo()
                t.cleanup(repo.remove)
                const server = await providerServer()
                t.cleanup(() => server.close())
                simulateTerminals(t, true)
                captureBrowser(t)
                server.hooks.answerModels = () => ({
                    status,
                    headers:{ Location:target.url + '/v1/models' },
                })
                const result = await runRoast(['login', provider], {
                    cwd:repo.dir,
                    env:repo.env,
                    stdin:'sk-redirect-A1B2\nsk-unused-C3D4\n',
                    redirectTo:server.url,
                })
                t.equal(result.code, 4, `${provider} ${status}: exit 4`)
                t.equal(server.requests.length, 1, 'no retry')
                t.deepEqual(server.credentials, [provider === 'anthropic' ?
                    'sk-redirect-A1B2' : 'Bearer sk-redirect-A1B2'],
                'the original endpoint received the validation credential')
                t.equal(target.requests.length, 0,
                    'redirect target never receives a request or headers')
                t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                    'no project state written')
                t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
                    'roast')), 'no user state written')
            }
        }
    })

test('login stops draining validation bodies after 32 KiB', async t => {
    for (const status of [200, 401, 503]) {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        captureBrowser(t)
        server.hooks.answerModels = () => res => {
            res.writeHead(status)
            // Leave the body open: a read beyond this limit must wait
            // for the deadline and fail the test.
            res.write(Buffer.alloc(32 * 1024, 'x'))
        }
        const signal = AbortSignal.timeout(2000)
        const result = await runRoast(['login', 'anthropic'], {
            cwd:repo.dir,
            env:repo.env,
            stdin:'sk-body-A1B2\nsk-body-C3D4\nsk-body-E5F6\n',
            redirectTo:server.url,
            signal,
        })
        t.equal(signal.aborted, false, 'finishes without reading past cap')
        t.equal(result.code, status === 200 ? 0 : status === 401 ? 3 : 4,
            'body cap preserves status handling')
        t.equal(server.requests.length, status === 401 ? 3 : 1,
            'only rejected keys are retried')
        if (status !== 200) {
            t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                'no project state written on failure')
        }
        t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
            'roast')), 'no user state written')
    }
})

test('login stores nothing when the provider cannot check the key',
    async t => {
        for (const status of [400, 429, 500, 503, 'network']) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await providerServer()
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            if (status === 'network') await server.close()
            else server.hooks.answerModels = () => Number(status)
            const result = await runRoast(['login', 'openai', '--global'], {
                cwd:repo.dir,
                env:repo.env,
                stdin:'sk-check-A1B2\nsk-unused-C3D4\n',
                redirectTo:server.url,
            })
            t.equal(result.code, 4, `${status}: endpoint failure`)
            t.equal(server.requests.length, status === 'network' ? 0 : 1,
                'endpoint failures are not retried')
            t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                'no project state written')
            t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
                'roast')), 'no user state written')
        }
    })

test('login stops after three rejected keys without writing either scope',
    async t => {
        for (const provider of ['openai', 'anthropic']) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await providerServer()
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            server.hooks.answerModels = () =>
                server.requests.length % 2 === 0 ? 403 : 401
            const keys = ['bad-A1B2', 'bad-C3D4', 'bad-E5F6']
            const result = await runRoast(['login', provider], {
                cwd:repo.dir,
                env:repo.env,
                stdin:[...keys, 'unused-G7H8', ''].join('\n'),
                redirectTo:server.url,
            })
            t.equal(result.code, 3, 'three rejections are auth failure')
            t.deepEqual(server.credentials, provider === 'anthropic' ?
                keys : keys.map(key => `Bearer ${key}`),
            'exactly three keys checked, in order')
            t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                'no project state written')
            t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
                'roast')), 'no user state written')
            t.equal(result.stdout, '', 'no success output')
            for (const key of keys) {
                t.ok(!result.stderr.includes(key),
                    'rejected keys stay out of diagnostics')
            }
        }
    })

test('empty pasted lines consume attempts without validation requests',
    async t => {
        for (const input of ['\n \t\n\naccepted\n',
            '\nrejected\n \t\naccepted\n']) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await providerServer()
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            server.hooks.answerModels = () => 403
            const result = await runRoast(['login', 'anthropic'], {
                cwd:repo.dir,
                env:repo.env,
                stdin:input,
                redirectTo:server.url,
            })
            t.equal(result.code, 3, 'empty lines count toward three tries')
            t.deepEqual(server.credentials,
                input.includes('rejected') ? ['rejected'] : [],
                'only nonempty attempts reach the provider')
            t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                'no project state written')
            t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
                'roast')), 'no user state written')
        }
    })

test('login retries rejected keys and stores only the accepted key',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        captureBrowser(t)
        server.hooks.answerModels = key => key === 'accepted' ? 200 : 401
        const result = await runRoast(['login', 'anthropic'], {
            cwd:repo.dir,
            env:repo.env,
            stdin:'rejected\naccepted\nunused\n',
            redirectTo:server.url,
        })
        t.equal(result.code, 0, 'login succeeds on the second attempt')
        t.deepEqual(server.credentials, ['rejected', 'accepted'],
            'checks stop after the accepted key')
        const file = path.join(repo.dir, '.env.roast')
        t.equal((await loadCredentials(file)).get('anthropic')?.key,
            'accepted', 'only the accepted key is stored')
    })

test('login openai --global validates Bearer auth and stores user scope',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        captureBrowser(t)
        const key = 'sk-openai-A1B2C3D4E5'
        const result = await runRoast(['login', 'openai', '--global'], {
            cwd:repo.dir,
            env:repo.env,
            stdin:key + '\n',
            redirectTo:server.url,
        })
        t.equal(result.code, 0, 'login succeeds')
        const user = path.join(repo.env.XDG_CONFIG_HOME, 'roast',
            'credentials.json')
        t.equal((await loadCredentials(user)).get('openai')?.key, key,
            'user file contains the key')
        t.ok(!fs.existsSync(path.join(repo.dir, '.env.roast')),
            'no project file')
        t.deepEqual(server.credentials, [`Bearer ${key}`],
            'validation uses Bearer authorization')
        t.equal(server.requests[0]?.method, 'GET', 'GET check')
        t.equal(server.requests[0]?.path, '/v1/models', 'models check')
    })

test('login anthropic stores a trimmed project key privately', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    captureBrowser(t)
    const key = 'sk-ant-Q7W8E9R0T1Y2'
    const result = await runRoast(['login', 'anthropic'], {
        cwd:repo.dir,
        env:repo.env,
        stdin:`  ${key}  \n`,
        redirectTo:server.url,
    })
    t.equal(result.code, 0, 'login succeeds')
    const file = path.join(repo.dir, '.env.roast')
    t.equal((await loadCredentials(file)).get('anthropic')?.key, key,
        'trimmed key is stored')
    t.equal(fs.statSync(file).mode & 0o777, 0o600, 'private file')
    t.equal(fs.readFileSync(file, 'utf8'),
        'ANTHROPIC_API_KEY=' + key + '\n', 'dotenv assignment')
    t.deepEqual(server.credentials, [key], 'validation carries the key')
    t.deepEqual(result.hosts, ['api.anthropic.com'], 'built-in endpoint')
})

test('login opens the key page, tolerates opener failure, or skips it',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        const opened = captureBrowser(t, new Error('no browser available'))
        for (const noBrowser of [false, true]) {
            const result = await runRoast([
                'login', 'openai', ...(noBrowser ? ['--no-browser'] : []),
            ], {
                cwd:repo.dir,
                env:repo.env,
                stdin:'sk-browser-U9I8O7P6\n',
                redirectTo:server.url,
            })
            t.equal(result.code, 0, 'login succeeds despite opener failure')
        }
        t.deepEqual(opened, ['https://platform.openai.com/api-keys'],
            'only the browser-enabled login opens the exact key page')
    })

test('logging in again replaces the key resolved by project config',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        captureBrowser(t)
        fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'), JSON.stringify({
            version:1,
            inference_profiles:{
                claude:{ protocol:'anthropic', model:'claude-x' },
            },
            roles:{ finder:{ profile:'claude' } },
        }))
        const keys = ['sk-ant-first-A1B2', 'sk-ant-second-C3D4']
        for (const key of keys) {
            const result = await runRoast(['login', 'anthropic'], {
                cwd:repo.dir,
                env:repo.env,
                stdin:key + '\n',
                redirectTo:server.url,
            })
            t.equal(result.code, 0, 'login succeeds')
        }
        const file = path.join(repo.dir, '.env.roast')
        const entries = await loadCredentials(file)
        t.equal(entries.get('anthropic')?.key, keys[1], 'new key replaces old')
        t.equal(entries.size, 1, 'one provider entry')
        const cfg = await loadProjectConfig('', {
            cwd:repo.dir,
            env:repo.env,
            signal:new AbortController().signal,
        })
        t.equal(resolveRole(cfg, 'finder', repo.env).apiKey, keys[1],
            'later config resolution uses the replacement')
    })

test('paste login prints a result without any four-character key fragment',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        captureBrowser(t)
        for (const provider of ['openai', 'anthropic']) {
            const key = 'Z9x8C7v6B5n4M3q2L1'
            const result = await runRoast(['login', provider], {
                cwd:repo.dir,
                env:repo.env,
                stdin:key,
                redirectTo:server.url,
            })
            t.equal(result.code, 0, 'a final line without newline is accepted')
            t.ok(result.stdout.length > 0, 'stdout contains a result')
            for (let i = 0; i <= key.length - 4; i++) {
                t.ok(!result.stdout.includes(key.slice(i, i + 4)),
                    'stdout contains no four-character key fragment')
            }
            t.ok(!result.stderr.includes(key), 'prompts do not echo the key')
        }
    })

test('login scope rules reject project storage outside Git', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    const opened = captureBrowser(t)
    const options = {
        cwd:dir.dir,
        env:dir.env,
        stdin:'sk-scope-987654\n',
        redirectTo:server.url,
    }
    const project = await runRoast(['login', 'openai'], options)
    t.equal(project.code, 2, 'project login outside Git is usage error')
    t.equal(server.requests.length, 0, 'no validation before scope check')
    t.deepEqual(opened, [], 'no browser before scope check')
    t.ok(!fs.existsSync(path.join(dir.dir, '.git')),
        'project usage error creates no Git state')
    t.ok(!fs.existsSync(path.join(dir.env.XDG_CONFIG_HOME, 'roast')),
        'project usage error creates no user state')
    const user = await runRoast(['login', 'openai', '--global'], options)
    t.equal(user.code, 0, 'global login works outside Git')
    const file = path.join(dir.env.XDG_CONFIG_HOME, 'roast',
        'credentials.json')
    t.equal((await loadCredentials(file)).get('openai')?.key,
        'sk-scope-987654', 'user key saved')
})

test('login rejects unknown providers and noninteractive input', async t => {
    const server = await providerServer()
    t.cleanup(() => server.close())
    const opened = captureBrowser(t)
    for (const { args, interactive } of [
        { args:['login', 'unknown'], interactive:true },
        { args:['login', 'OpenAI'], interactive:true },
        { args:['login', 'openai'], interactive:false },
        { args:['login', 'openai', '--global'], interactive:false },
        { args:['login', 'openai', 'anthropic'], interactive:true },
    ]) {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, interactive)
        const result = await runRoast(args, {
            cwd:repo.dir,
            env:repo.env,
            stdin:'sk-unused-A1B2\n',
            redirectTo:server.url,
        })
        t.equal(result.code, 2, 'invalid invocation is usage error')
        t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
            'no project state written')
        t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
            'roast')), 'no user state written')
    }
    t.equal(server.requests.length, 0, 'no requests')
    t.deepEqual(opened, [], 'no browser')
})
