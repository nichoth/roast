import { request } from 'node:http'
import { CancelledError } from '../../src/cli/errors.js'
import { createConnection } from 'node:net'
import { loginTimeouts } from '../../src/cli/openrouter-login.js'
import { terminalHooks } from '../../src/cli/terminal.js'
import fs from 'node:fs'
import path from 'node:path'
import { loadCredentials } from '../../src/credentials/credentials.js'
import { createHash } from 'node:crypto'
import { startInferenceServer } from '../helpers/inference-server.js'
import { test } from '../helpers/test.js'
import { tempRepo } from '../helpers/repo.js'
import { providerServer } from '../helpers/provider-server.js'
import { runRoast } from '../helpers/run.js'
import { captureBrowser, simulateTerminals } from '../helpers/terminal.js'

async function awaitOpened (
    opened:Array<string>,
    result:ReturnType<typeof runRoast>
):Promise<URL> {
    return Promise.race([
        result.then(() => { throw new Error('login ended before opening') }),
        (async () => {
            const deadline = Date.now() + 2000
            while (!opened[0]) {
                if (Date.now() > deadline) throw new Error('no opened URL')
                await new Promise(resolve => setTimeout(resolve, 5))
            }
            return new URL(opened[0])
        })(),
    ])
}

async function callOpenRouterBack (url:URL, code:string):Promise<Response> {
    const callback = new URL(url.searchParams.get('callback_url') as string)
    callback.searchParams.set('state', url.searchParams.get('state') ?? '')
    callback.searchParams.set('code', code)
    return fetch(callback)
}

test('OpenRouter approval uses S256 and exchanges the callback code',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        const opened = captureBrowser(t)
        shortBrowserTimeout(t)
        const result = runRoast(['login', 'openrouter'], {
            cwd:repo.dir,
            env:{ ...repo.env, DISPLAY:':0' },
            redirectTo:server.url,
            signal:AbortSignal.timeout(3000),
        })
        const url = await awaitOpened(opened, result)
        t.equal(url.origin + url.pathname, 'https://openrouter.ai/auth')
        t.equal(url.searchParams.get('code_challenge_method'), 'S256')
        t.equal(url.searchParams.get('key_label'), 'roast')
        t.ok(url.searchParams.get('state'), 'random state supplied')
        const callback = new URL(url.searchParams.get('callback_url') ?? '')
        t.equal(callback.hostname, 'localhost')
        t.equal(callback.pathname, '/callback')
        t.ok(Number(callback.port) > 0, 'ephemeral port supplied')
        const response = await callOpenRouterBack(url, 'approved')
        t.equal(response.status, 200)
        await response.text()
        t.equal((await result).code, 0)
        await portClosed(t, url)
        const file = path.join(repo.dir, '.git', 'roast',
            'credentials.json')
        t.equal((await loadCredentials(file)).get('openrouter')?.key,
            'sk-or-minted-approved', 'minted key stored for project')
        t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME, 'roast')),
            'no user scope state')
        t.equal(server.requests[1]?.path, '/api/v1/key')
        t.equal(server.requests[1]?.headers.authorization,
            'Bearer sk-or-minted-approved')
        const body = server.requests[0]?.body as Record<string, string>
        t.equal(body.code, 'approved')
        t.equal(body.code_challenge_method, 'S256')
        t.equal(createHash('sha256').update(body.code_verifier)
            .digest('base64url'), url.searchParams.get('code_challenge'))
    })

function shortBrowserTimeout (t:{ cleanup (fn:() => void):void }):void {
    const saved = loginTimeouts.browser
    loginTimeouts.browser = 500
    t.cleanup(() => { loginTimeouts.browser = saved })
}

test('forged callback times out without exchanging a code', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    shortBrowserTimeout(t)
    const opened = captureBrowser(t)
    const guard = AbortSignal.timeout(2000)
    const result = runRoast(['login', 'openrouter'], {
        cwd:repo.dir,
        env:{ ...repo.env, DISPLAY:':0' },
        redirectTo:server.url,
        signal:guard,
    })
    const url = await awaitOpened(opened, result)
    url.searchParams.set('state', 'forged')
    const response = await callOpenRouterBack(url, 'forged')
    t.ok(response.status >= 400, 'forged state refused')
    await response.text()
    t.equal((await result).code, 4, 'approval never received')
    t.ok(!guard.aborted, 'browser timeout precedes guard')
    t.equal(server.requests.length, 0, 'no exchange')
})

test('only the first matching callback is accepted', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    shortBrowserTimeout(t)
    captureBrowser(t)
    const statuses:Array<number> = []
    terminalHooks.openBrowser = async value => {
        const url = new URL(value)
        for (const code of ['first', 'second']) {
            const response = await callOpenRouterBack(url, code)
            statuses.push(response.status)
            await response.text()
        }
        return undefined
    }
    const result = await runRoast(['login', 'openrouter'], {
        cwd:repo.dir,
        env:{ ...repo.env, DISPLAY:':0' },
        redirectTo:server.url,
        signal:AbortSignal.timeout(2000),
    })
    t.deepEqual(statuses, [200, 409])
    t.equal(result.code, 0)
    t.equal(server.requests.length, 2, 'one exchange and one key check')
    t.equal((server.requests[0]?.body as { code:string }).code, 'first')
})

function nothingStored (
    t:{ ok (value:unknown, message?:string):void },
    repo:ReturnType<typeof tempRepo>
):void {
    t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
        'no project state')
    t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME, 'roast')),
        'no user state')
}

test('OpenRouter without a callback times out and stores nothing', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    shortBrowserTimeout(t)
    const opened = captureBrowser(t)
    const guard = AbortSignal.timeout(2000)
    const result = runRoast(['login', 'openrouter'], {
        cwd:repo.dir,
        env:{ ...repo.env, DISPLAY:':0' },
        redirectTo:server.url,
        signal:guard,
    })
    const url = await awaitOpened(opened, result)
    t.equal((await result).code, 4)
    await portClosed(t, url)
    t.ok(!guard.aborted, 'short browser timeout wins')
    t.equal(server.requests.length, 0, 'no exchange')
    nothingStored(t, repo)
})

test('OpenRouter rejected keys and approval codes are auth failures',
    async t => {
        for (const failure of ['key', 'exchange']) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const provider = await providerServer()
            t.cleanup(() => provider.close())
            const rejected = await startInferenceServer(() => ({ status:401 }))
            t.cleanup(() => rejected.close())
            const server = failure === 'exchange' ? rejected : provider
            provider.hooks.answerKey = () => 401
            simulateTerminals(t, true)
            shortBrowserTimeout(t)
            const opened = captureBrowser(t)
            const result = runRoast(['login', 'openrouter'], {
                cwd:repo.dir,
                env:{ ...repo.env, DISPLAY:':0' },
                redirectTo:server.url,
                signal:AbortSignal.timeout(2000),
            })
            const url = await awaitOpened(opened, result)
            const response = await callOpenRouterBack(url, 'rejected')
            t.equal(response.status, 200, 'callback precedes provider error')
            await response.text()
            const done = await result
            await portClosed(t, url)
            t.equal(done.code, 3, failure + ' refusal is authentication')
            t.equal(server.requests.filter(r => r.method === 'POST').length,
                1, 'exactly one exchange')
            nothingStored(t, repo)
        }
    })

test('OpenRouter --no-browser exchanges a trimmed pasted code', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    shortBrowserTimeout(t)
    const opened = captureBrowser(t)
    const result = await runRoast(['login', 'openrouter', '--no-browser'], {
        cwd:repo.dir,
        env:{ ...repo.env, DISPLAY:':0' },
        redirectTo:server.url,
        stdin:'  pasted-code  \n',
        signal:AbortSignal.timeout(2000),
    })
    t.equal(result.code, 0)
    t.deepEqual(opened, [], 'browser never opened')
    const match = result.stderr.match(/https:\/\/openrouter.ai\/auth\?\S+/)
    t.ok(match, 'approval URL printed')
    const url = new URL(match?.[0] ?? 'https://invalid.example')
    t.ok(!url.searchParams.has('callback_url'), 'no callback in URL')
    t.equal((server.requests[0]?.body as { code?:string })?.code,
        'pasted-code')
    const file = path.join(repo.dir, '.git', 'roast', 'credentials.json')
    t.equal((await loadCredentials(file)).get('openrouter')?.key,
        'sk-or-minted-pasted-code')
})

test('Linux without a display uses pasted approval without a flag',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        shortBrowserTimeout(t)
        const opened = captureBrowser(t)
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
        t.cleanup(() => {
            if (descriptor) {
                Object.defineProperty(process, 'platform', descriptor)
            }
        })
        Object.defineProperty(process, 'platform', { value:'linux' })
        const result = await runRoast(['login', 'openrouter'], {
            cwd:repo.dir,
            env:{ ...repo.env, DISPLAY:'', WAYLAND_DISPLAY:'' },
            redirectTo:server.url,
            stdin:'linux-code\n',
            signal:AbortSignal.timeout(2000),
        })
        t.equal(result.code, 0)
        t.deepEqual(opened, [])
        t.ok(!result.stderr.includes('callback_url'), 'headless approval URL')
        t.equal((server.requests[0]?.body as { code?:string })?.code,
            'linux-code')
    })

async function portClosed (
    t:{ ok (value:unknown, message?:string):void },
    url:URL
):Promise<void> {
    const port = Number(new URL(url.searchParams.get('callback_url') ?? '')
        .port)
    for (const host of ['127.0.0.1', '::1']) {
        const connected = await new Promise<boolean>((resolve, reject) => {
            const socket = createConnection({ host, port })
            socket.once('connect', () => {
                socket.destroy()
                resolve(true)
            })
            socket.once('error', (err:NodeJS.ErrnoException) => {
                if (err.code === 'ECONNREFUSED' ||
                    err.code === 'EAFNOSUPPORT' ||
                    err.code === 'ENETUNREACH') resolve(false)
                else reject(err)
            })
        })
        t.ok(!connected, `${host} listener closed`)
    }
}

test('OpenRouter never follows redirects at exchange or key check',
    async t => {
        const target = await startInferenceServer(() => ({ status:200 }))
        t.cleanup(() => target.close())
        for (const step of ['exchange', 'key']) {
            for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
                const repo = tempRepo()
                t.cleanup(repo.remove)
                const provider = await providerServer()
                t.cleanup(() => provider.close())
                const redirect = {
                    status, headers:{ Location:target.url + '/stolen' },
                }
                provider.hooks.answerKey = () => redirect
                const exchange = await startInferenceServer(() => redirect)
                t.cleanup(() => exchange.close())
                const server = step === 'exchange' ? exchange : provider
                simulateTerminals(t, true)
                const opened = captureBrowser(t)
                const result = await runRoast(['login', 'openrouter',
                    '--no-browser', '--error-format', 'json'], {
                    cwd:repo.dir,
                    env:repo.env,
                    redirectTo:server.url,
                    stdin:'redirect-code\n',
                })
                t.equal(result.code, 4, `${step} ${status}: endpoint error`)
                t.ok(result.stderr.includes('"error_category":"endpoint"'))
                t.equal(server.requests.length, step === 'exchange' ? 1 : 2)
                t.deepEqual(opened, [])
                nothingStored(t, repo)
            }
        }
        t.equal(target.requests.length, 0, 'redirect target never contacted')
    })

test('OpenRouter exchange reads at most 32 KiB without waiting for EOF',
    async t => {
        for (const status of [200, 401, 503]) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await startInferenceServer(req => {
                if (req.path === '/api/v1/key') return { status:200 }
                return res => {
                    res.writeHead(status)
                    const json = '{"key":"sk-bounded-exchange"}'
                    res.write(json + ' '.repeat(32 * 1024 - json.length))
                    // Keep the response open: only the byte cap can finish.
                }
            })
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            const guard = AbortSignal.timeout(1000)
            const result = await runRoast(['login', 'openrouter',
                '--no-browser'], {
                cwd:repo.dir,
                env:repo.env,
                redirectTo:server.url,
                stdin:'bounded-code\n',
                signal:guard,
            })
            t.equal(result.code, status === 200 ? 0 : status === 401 ? 3 : 4)
            t.ok(!guard.aborted, 'byte cap finishes before guard')
            if (status !== 200) nothingStored(t, repo)
        }
    })

test('OpenRouter callback without a code fails without exchange', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    shortBrowserTimeout(t)
    const opened = captureBrowser(t)
    const result = runRoast(['login', 'openrouter'], {
        cwd:repo.dir,
        env:{ ...repo.env, DISPLAY:':0' },
        redirectTo:server.url,
        signal:AbortSignal.timeout(2000),
    })
    const url = await awaitOpened(opened, result)
    const response = await callOpenRouterBack(url, '')
    t.equal(response.status, 400)
    await response.text()
    t.equal((await result).code, 4)
    t.equal(server.requests.length, 0)
    await portClosed(t, url)
    nothingStored(t, repo)
})

test('cancelling browser approval closes both listeners', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, true)
    shortBrowserTimeout(t)
    const opened = captureBrowser(t)
    const controller = new AbortController()
    const result = runRoast(['login', 'openrouter'], {
        cwd:repo.dir,
        env:{ ...repo.env, DISPLAY:':0' },
        redirectTo:server.url,
        signal:controller.signal,
    })
    const url = await awaitOpened(opened, result)
    controller.abort(new CancelledError())
    t.equal((await result).code, 5)
    t.equal(server.requests.length, 0)
    await portClosed(t, url)
    nothingStored(t, repo)
})

test('OpenRouter decodes the first strict JSON value with exact key casing',
    async t => {
        for (const [body, expected] of [
            ['{"key":"sk-first-value"} {"ignored":true}', 0],
            ['{"Key":"sk-wrong-case"}', 4],
            ['{"key":null}', 4],
            ['{"key":42}', 4],
            ['{"key":""}', 4],
            ['null', 4],
            ['{"key":"sk-comment",}', 4],
            ['{"key":"sk-broken-private', 4],
        ] as const) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            const server = await startInferenceServer(req => ({
                status:200, body:req.method === 'POST' ? body : '{}',
            }))
            t.cleanup(() => server.close())
            simulateTerminals(t, true)
            captureBrowser(t)
            const result = await runRoast(['login', 'openrouter',
                '--no-browser'], {
                cwd:repo.dir,
                env:repo.env,
                redirectTo:server.url,
                stdin:'json-code\n',
            })
            t.equal(result.code, expected)
            t.ok(!result.stderr.includes('sk-broken-private'),
                'reply parse errors never quote key material')
            if (expected !== 0) nothingStored(t, repo)
        }
    })

test('callback listener rejects invalid routes and survives malformed URLs',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        shortBrowserTimeout(t)
        captureBrowser(t)
        const statuses:Array<number> = []
        terminalHooks.openBrowser = async value => {
            const url = new URL(value)
            const callback = new URL(
                url.searchParams.get('callback_url') ?? '')
            for (const [target, method] of [
                [new URL('/other', callback), 'GET'],
                [callback, 'POST'],
                [callback, 'GET'],
            ] as const) {
                const response = await fetch(target, { method })
                statuses.push(response.status)
                await response.text()
            }
            statuses.push(await new Promise<number>((resolve, reject) => {
                const req = request({
                    hostname:'127.0.0.1', port:callback.port, path:'http://[',
                }, res => {
                    res.resume()
                    resolve(res.statusCode ?? 0)
                })
                req.on('error', reject)
                req.end()
            }))
            const response = await callOpenRouterBack(url, 'after-invalid')
            statuses.push(response.status)
            await response.text()
            return new Error('opener failed after delivering approval')
        }
        const result = await runRoast(['login', 'openrouter'], {
            cwd:repo.dir,
            env:{ ...repo.env, DISPLAY:':0' },
            redirectTo:server.url,
            signal:AbortSignal.timeout(2000),
        })
        t.deepEqual(statuses, [404, 405, 400, 400, 200])
        t.equal(result.code, 0,
            'invalid requests and opener failure tolerated')
    })

test('browser timeout releases listeners even while opener is pending',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        simulateTerminals(t, true)
        shortBrowserTimeout(t)
        const opened = captureBrowser(t)
        let release:() => void = () => {}
        terminalHooks.openBrowser = async value => {
            opened.push(value)
            await new Promise<void>(resolve => { release = resolve })
            return undefined
        }
        const result = runRoast(['login', 'openrouter'], {
            cwd:repo.dir,
            env:{ ...repo.env, DISPLAY:':0' },
            redirectTo:server.url,
        })
        const url = await awaitOpened(opened, result)
        let timer:ReturnType<typeof setTimeout>|undefined
        try {
            const done = await Promise.race([
                result,
                new Promise<undefined>(resolve => {
                    timer = setTimeout(() => resolve(undefined), 1000)
                }),
            ])
            t.equal(done?.code, 4, 'browser timeout bounds opener too')
        } finally {
            clearTimeout(timer)
            release()
            await result
        }
        await portClosed(t, url)
        nothingStored(t, repo)
    })
