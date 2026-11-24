// `createModelClient` and `send` (spec 06, 3.2): one model turn becomes
// exactly one HTTP request in the profile's protocol. Never retries.

import { goTrimSpace } from '../gocompat/strings.js'
import {
    anthropicUrl,
    decodeAnthropic,
    encodeAnthropic,
} from './anthropic.js'
import { abortable, CaptureGate, openCapturedBody } from './capture.js'
import { chatUrl, decodeChat, encodeChat } from './chat.js'
import {
    CaptureError,
    EndpointError,
    ProviderError,
    SENTINEL_MESSAGE,
} from './errors.js'
import { currentFetch, requestHeaders } from './http.js'
import {
    decodeResponses,
    encodeResponses,
    responsesUrl,
} from './responses.js'
import { parseSse, type SseEvent } from './sse.js'
import {
    DEFAULT_MAX_ATTEMPTS,
    runConversation,
    type LoopDeps,
} from './agent.js'
import type { Ledger } from './ledger.js'
import type { Sleep } from './retry.js'
import type {
    Client,
    ClientConfig,
    ModelRequest,
    ModelTurn,
    Protocol,
    RecordUsage,
    Usage,
} from './types.js'
import { UsageAccumulator } from './usage.js'

export { DEFAULT_MAX_ATTEMPTS }

// Error bodies are read at most this far (deliberate change 9).
export const MAX_ERROR_BODY = 32 * 1024

export interface ModelClient {
    readonly config:Readonly<ClientConfig>;
    // '' normalized to 'chat'.
    readonly protocol:Protocol;
    // <= 0 normalized to DEFAULT_MAX_ATTEMPTS.
    readonly maxAttempts:number;
    // One HTTP attempt. Resolves only after capture succeeded.
    send (request:ModelRequest):Promise<ModelTurn>;
    // Exact byte length of the request body `send` would post.
    requestBytes (request:ModelRequest):number;
    // Accumulated usage across all calls on this client.
    usage ():Usage;
}

interface Adapter {
    url (baseUrl:string):string;
    encode (config:ClientConfig, request:ModelRequest):unknown;
    decode (events:AsyncIterable<SseEvent>):Promise<ModelTurn>;
}

const ADAPTERS:Partial<Record<Protocol, Adapter>> = {
    chat:{
        url:chatUrl,
        encode:(config, request) => encodeChat(config, request),
        decode:decodeChat,
    },
    responses:{
        url:responsesUrl,
        encode:(config, request) => encodeResponses(config, request),
        decode:decodeResponses,
    },
    anthropic:{
        url:anthropicUrl,
        encode:(config, request) => encodeAnthropic(config, request),
        decode:decodeAnthropic,
    },
}

function adapterFor (protocol:string):Adapter {
    const known = protocol === 'chat' || protocol === 'responses' ||
        protocol === 'anthropic'
    const adapter = known ? ADAPTERS[protocol as Protocol] : undefined
    if (!adapter) {
        throw new Error(`unsupported inference protocol "${protocol}"`)
    }
    return adapter
}

// Best-effort provider error fields from an OpenAI-style
// `{"error":{...}}` or Anthropic `{"type":"error","error":{...}}` body.
function providerFields (text:string):{
    type?:string;
    code?:string;
    message?:string;
} {
    try {
        const parsed:unknown = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object') return {}
        const e = (parsed as { error?:unknown }).error
        if (e === null || typeof e !== 'object') return {}
        const { type, code, message } = e as Record<string, unknown>
        return {
            type:typeof type === 'string' ? type : undefined,
            code:typeof code === 'string' ?
                code :
                typeof code === 'number' ? String(code) : undefined,
            message:typeof message === 'string' ? message : undefined,
        }
    } catch {
        return {}
    }
}

async function readCapped (
    body:ReadableStream<Uint8Array>|null,
    limit:number,
    signal:AbortSignal
):Promise<Uint8Array> {
    if (!body) return new Uint8Array(0)
    const reader = body.getReader()
    const parts:Uint8Array[] = []
    let size = 0
    let eof = false
    try {
        while (size < limit) {
            const r = await abortable(reader.read(), signal)
            if (r.done) {
                eof = true
                break
            }
            const take = r.value.subarray(0, limit - size)
            parts.push(take)
            size += take.length
        }
    } finally {
        if (!eof) await reader.cancel().catch(() => {})
    }
    const out = new Uint8Array(size)
    let off = 0
    for (const p of parts) {
        out.set(p, off)
        off += p.length
    }
    return out
}

async function httpError (
    response:Response,
    url:string,
    model:string,
    signal:AbortSignal
):Promise<Error> {
    const bytes = await readCapped(response.body, MAX_ERROR_BODY, signal)
    const text = new TextDecoder().decode(bytes)
    const fields = providerFields(text)
    const headers:Record<string, string> = {}
    response.headers.forEach((value, name) => { headers[name] = value })
    const detail = fields.message ?? text.slice(0, 512).trim()
    const status = `${response.status} ${response.statusText}`.trim()
    const err = new ProviderError(
        `POST "${url}": ${status}${detail ? `: ${detail}` : ''}`,
        {
            status:response.status,
            headers,
            providerType:fields.type,
            providerCode:fields.code,
            providerMessage:fields.message,
        })
    if (response.status >= 300 && response.status < 400) {
        return new EndpointError(
            `${SENTINEL_MESSAGE.endpoint}: ${model}: redirect refused: ` +
                err.message,
            { cause:err, details:{ model } })
    }
    return err
}

export function createModelClient (config:ClientConfig):ModelClient {
    if (!(config.maxOutputTokens > 0)) {
        throw new Error(`${config.model}: max output tokens must be positive`)
    }
    if (goTrimSpace(config.apiKey) === '') {
        throw new Error(`${config.model}: API key is not configured`)
    }
    const protocol = (config.protocol === '' ?
        'chat' :
        config.protocol) as Protocol
    const adapter = adapterFor(protocol)
    const maxAttempts = config.maxAttempts > 0 ?
        config.maxAttempts :
        DEFAULT_MAX_ATTEMPTS
    const gate = new CaptureGate()
    const total = new UsageAccumulator()
    const url = adapter.url(config.baseUrl)

    function encodeBody (request:ModelRequest):Uint8Array {
        const body = adapter.encode(config, request)
        return new TextEncoder().encode(JSON.stringify(body))
    }

    async function attempt (
        request:ModelRequest,
        signal:AbortSignal
    ):Promise<ModelTurn> {
        const fetchFn = config.fetch ?? currentFetch()
        const response = await fetchFn(url, {
            method:'POST',
            headers:requestHeaders(protocol, config.apiKey,
                request.sessionId, config.sessionHeader),
            body:encodeBody(request),
            redirect:'manual',
            signal,
        })
        if (response.status < 200 || response.status >= 300) {
            throw await httpError(response, url, config.model, signal)
        }
        const body = await openCapturedBody(response, {
            role:config.role,
            protocol,
            model:config.model,
            captureResponse:config.captureResponse,
        }, gate, signal)
        let turn:ModelTurn|undefined
        let failure:unknown
        try {
            turn = await adapter.decode(parseSse(body.chunks))
        } catch (err) {
            failure = err
        }
        if (turn) {
            total.add(turn.usage)
            request.onUsage?.(turn.usage)
        }
        // A capture failure here replaces any turn or error.
        await body.release()
        if (!turn) throw failure
        signal.throwIfAborted()
        return turn
    }

    return {
        config,
        protocol,
        maxAttempts,
        requestBytes (request:ModelRequest):number {
            return encodeBody(request).length
        },
        usage ():Usage {
            return total.total()
        },
        async send (request:ModelRequest):Promise<ModelTurn> {
            if (gate.failure) throw gate.failure
            request.signal.throwIfAborted()
            const timeout = config.requestTimeoutMs > 0 ?
                AbortSignal.timeout(config.requestTimeoutMs) :
                undefined
            const signal = timeout ?
                AbortSignal.any([request.signal, timeout]) :
                request.signal
            try {
                return await attempt(request, signal)
            } catch (err) {
                if (err instanceof CaptureError) throw err
                if (request.signal.aborted) throw request.signal.reason
                if (timeout?.aborted) {
                    throw new EndpointError(
                        `${SENTINEL_MESSAGE.endpoint}: ${config.model}: ` +
                            'request timed out after ' +
                            `${config.requestTimeoutMs}ms`,
                        {
                            cause:timeout.reason,
                            details:{ model:config.model },
                        })
                }
                throw err
            }
        },
    }
}

export interface CreateClientOptions {
    // The run's shared ledger; none means unlimited.
    ledger?:Ledger|null;
    now?:() => number;
    sleep?:Sleep;
    sessionId?:() => string;
}

function recordUsage (u:Usage):RecordUsage {
    return {
        uncached_input_tokens:u.uncachedInputTokens,
        cached_input_tokens:u.cachedInputTokens,
        cache_write_tokens:u.cacheWriteTokens,
        output_tokens:u.outputTokens,
        calls:u.calls,
    }
}

// The `Client` the finder and verifier call (spec 07, 3.3): both entry
// points run the agent loop over `model`; usage accumulates across all
// of this client's conversations.
export function createClient (
    model:ModelClient,
    opts:CreateClientOptions = {}
):Client {
    const total = new UsageAccumulator()
    const deps:LoopDeps = {
        client:model,
        model:model.config.model,
        maxOutputTokens:model.config.maxOutputTokens,
        maxAttempts:model.maxAttempts > 0 ?
            model.maxAttempts :
            DEFAULT_MAX_ATTEMPTS,
        ledger:opts.ledger ?? null,
        addUsage:u => total.add(u),
        now:opts.now,
        sleep:opts.sleep,
        sessionId:opts.sessionId,
    }
    return {
        name:model.config.model,
        converse (system, user, converseOpts, signal) {
            return runConversation(deps, system, user, converseOpts, false,
                signal)
        },
        completeStructured (system, user, schemaName, result, signal) {
            return runConversation(deps, system, user, {
                tools:[{
                    name:schemaName,
                    description:'Return the requested structured result.',
                    schema:result.schema,
                }],
                finalTool:schemaName,
                final:{ decode:result.decode },
                maxTurns:1,
            }, true, signal)
        },
        usage () {
            return recordUsage(total.total())
        },
    }
}
