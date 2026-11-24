// pattern: Imperative Shell
// PKCE coordinates loopback HTTP, browser approval and provider requests.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Env } from '../config/credential.js'
import type { BuiltinProvider } from '../config/provider.js'
import { formatGoDuration } from '../gocompat/duration.js'
import { exchangeKey } from './openrouter-reply.js'
import { goTrimSpace } from '../gocompat/strings.js'
import { abortable } from '../llm/capture.js'
import { AuthError, EndpointError } from '../llm/errors.js'
import type { LoginContext, LoginFlags } from './login.js'
import { openBrowser } from './terminal.js'

export const loginTimeouts = { browser:5 * 60_000 }

function randomToken (bytes:number):string {
    return randomBytes(bytes).toString('base64url')
}

async function listen (
    handler:RequestListener,
    host:string,
    port:number
):Promise<Server> {
    const server = createServer({ headersTimeout:10_000 }, handler)
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port, host, ipv6Only:host === '::1' }, () => {
            server.removeListener('error', reject)
            resolve()
        })
    })
    return server
}

async function close (server:Server):Promise<void> {
    const done = new Promise<void>(resolve => server.close(() => resolve()))
    server.closeAllConnections()
    await done
}

async function listenLoopback (handler:RequestListener):Promise<{
    port:number;
    servers:Array<Server>;
}> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const ipv4 = await listen(handler, '127.0.0.1', 0)
        const { port } = ipv4.address() as AddressInfo
        try {
            const ipv6 = await listen(handler, '::1', port)
            return { port, servers:[ipv4, ipv6] }
        } catch (err) {
            let probe:Server
            try {
                probe = await listen(handler, '::1', 0)
            } catch {
                return { port, servers:[ipv4] }
            }
            await close(probe)
            await close(ipv4)
            if (attempt === 9) throw err
        }
    }
    throw new Error('no available loopback port')
}

async function callbackCode (
    url:URL,
    state:string,
    ctx:LoginContext
):Promise<string> {
    let received = false
    let accept:(code:string) => void = () => {}
    const code = new Promise<string>(resolve => { accept = resolve })
    const listener = await listenLoopback((req, res) => {
        let callback:URL
        try {
            callback = new URL(req.url ?? '/', 'http://localhost')
        } catch {
            res.writeHead(400).end()
            return
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        if (callback.pathname !== '/callback') {
            res.writeHead(404).end()
        } else if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow:'GET, HEAD' }).end()
        } else if (callback.searchParams.get('state') !== state) {
            res.writeHead(400).end('This login link does not match ' +
                'the one Roast started.\n')
        } else if (received) {
            res.writeHead(409).end('Roast already received a response.\n')
        } else {
            received = true
            const value = callback.searchParams.get('code') ?? ''
            res.writeHead(value ? 200 : 400).end(value ?
                'Roast received the key. You can close this tab.\n' :
                'Login failed. Return to your terminal.\n',
            () => { accept(value) })
        }
    }).catch((err:unknown) => {
        throw new Error('listen for the browser callback failed', {
            cause:err,
        })
    })
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error(
        'no approval from the browser within ' +
        formatGoDuration(BigInt(loginTimeouts.browser) * 1_000_000n) +
        '; nothing stored'
    )), loginTimeouts.browser)
    const signal = AbortSignal.any([ctx.signal, timeout.signal])
    try {
        url.searchParams.set('callback_url',
            `http://localhost:${listener.port}/callback`)
        url.searchParams.sort()
        ctx.stderr.write(`Approve Roast in your browser:\n  ${url}\n`)
        const err = await abortable(openBrowser(url.toString(), signal),
            signal)
        if (err) {
            ctx.stderr.write(`could not open a browser (${err.message}); ` +
            'open the URL above\n')
        }
        return await abortable(code, signal)
    } finally {
        clearTimeout(timer)
        await Promise.all(listener.servers.map(close))
    }
}

async function readExchangeBody (
    response:Response,
    signal:AbortSignal
):Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const parts:Array<Buffer> = []
    let remaining = 32 * 1024
    try {
        while (remaining > 0) {
            const chunk = await abortable(reader.read(), signal)
            if (chunk.done) break
            const value = chunk.value.subarray(0, remaining)
            parts.push(Buffer.from(value))
            remaining -= value.byteLength
        }
    } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
    return Buffer.concat(parts).toString('utf8')
}

async function exchangeCode (
    provider:BuiltinProvider,
    code:string,
    verifier:string,
    ctx:LoginContext
):Promise<string> {
    const url = provider.endpoint.replace(/\/+$/, '') + '/auth/keys'
    const prefix = 'llm: inference endpoint failure: exchange code at ' + url
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
    try {
        const response = await ctx.fetch(url, {
            method:'POST',
            redirect:'manual',
            signal,
            headers:{ 'Content-Type':'application/json' },
            body:JSON.stringify({
                code, code_challenge_method:'S256', code_verifier:verifier,
            }),
        })
        const body = await readExchangeBody(response, signal)
        if (response.status >= 300 && response.status < 400) {
            throw new EndpointError(prefix + ': redirect refused')
        }
        if (response.status === 401 || response.status === 403) {
            throw new AuthError('llm: authentication failed: openrouter ' +
                'refused the approval code; nothing stored')
        }
        if (!response.ok) {
            throw new EndpointError(prefix +
            `: HTTP ${response.status} ${response.statusText}`)
        }
        const key = exchangeKey(body)
        if (key === null) {
            throw new EndpointError(prefix + ': no key in reply')
        }
        return key
    } catch (err) {
        if (err instanceof EndpointError || err instanceof AuthError) throw err
        throw new EndpointError(prefix + ': exchange failed', { cause:err })
    }
}

export async function browserLogin (
    provider:BuiltinProvider,
    flags:LoginFlags,
    ctx:LoginContext
):Promise<string> {
    const verifier = randomToken(32)
    const state = randomToken(16)
    const url = new URL('https://openrouter.ai/auth')
    url.searchParams.set('code_challenge', createHash('sha256')
        .update(verifier).digest('base64url'))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('key_label', 'roast')
    url.searchParams.set('state', state)
    url.searchParams.sort()
    const headless = flags.noBrowser || !hasDisplay(ctx.env)
    const code = headless ? await headlessCode(url, ctx) :
        await callbackCode(url, state, ctx)
    if (code === '') {
        throw new Error('OpenRouter returned no code; nothing stored')
    }
    return exchangeCode(provider, code, verifier, ctx)
}

async function headlessCode (url:URL, ctx:LoginContext):Promise<string> {
    ctx.stderr.write('Open this URL in a browser and approve Roast:\n' +
        `  ${url}\nPaste the code the page shows: `)
    let answer:string|null
    try {
        answer = await abortable(ctx.lines.readLine(), ctx.signal)
    } catch (err) {
        throw new Error('read code failed', { cause:err })
    }
    if (answer === null) throw new Error('read code: EOF')
    const code = goTrimSpace(answer)
    if (code === '') throw new Error('no code entered; nothing stored')
    return code
}

function hasDisplay (env:Env):boolean {
    return process.platform !== 'linux' ||
        Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY)
}
