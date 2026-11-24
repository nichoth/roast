// The `responses` protocol (OpenAI Responses API; OpenRouter): a pure
// request encoder and stream decoder (spec 06, 2.6.2 and 2.8.2).

import {
    IncompleteStreamError,
    ProviderError,
} from './errors.js'
import { wellFormed } from './json.js'
import { responsesSystemMode } from './models.js'
import type { SseEvent } from './sse.js'
import { trimSlashes, type EncodeConfig, type EncodeRequest } from './chat.js'
import type {
    AssistantPart,
    FinishReason,
    ModelTurn,
} from './types.js'
import { normalizeUsage, responsesUsage } from './usage.js'

export function responsesUrl (baseUrl:string):string {
    return `${trimSlashes(baseUrl)}/responses`
}

function input (model:string, req:EncodeRequest):unknown[] {
    const out:unknown[] = []
    const mode = responsesSystemMode(model)
    if (req.system !== '' && mode !== 'remove') {
        out.push({ role:mode, content:req.system })
    }
    for (const item of req.items) {
        if (item.role === 'user') {
            out.push({
                role:'user',
                content:[{ type:'input_text', text:item.text }],
            })
        } else if (item.role === 'assistant') {
            for (const p of item.parts) {
                if (p.type === 'text') {
                    out.push({ role:'assistant', content:p.text })
                } else if (p.type === 'tool-call') {
                    out.push({
                        type:'function_call',
                        call_id:p.id,
                        name:p.name,
                        arguments:p.input,
                    })
                }
                // Reasoning is never replayed.
            }
        } else {
            for (const r of item.results) {
                out.push({
                    type:'function_call_output',
                    call_id:r.callId,
                    output:r.output,
                })
            }
        }
    }
    return out
}

// The request body. `store` is always false and the whole conversation is
// replayed: no `previous_response_id`, `include`, or `reasoning`.
export function encodeResponses (
    config:EncodeConfig,
    req:EncodeRequest
):Record<string, unknown> {
    const body:Record<string, unknown> = {
        model:config.model,
        input:input(config.model, req),
        max_output_tokens:config.maxOutputTokens,
        store:false,
        stream:true,
    }
    if (req.tools.length > 0) {
        body.tools = req.tools.map(tool => ({
            type:'function',
            name:tool.name,
            description:tool.description ?? '',
            parameters:structuredClone(tool.schema),
            strict:false,
        }))
        body.tool_choice = 'auto'
    }
    return body
}

type Json = Record<string, unknown>

function obj (v:unknown):Json {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ?
        v as Json :
        {}
}

function str (v:unknown):string {
    return typeof v === 'string' ? wellFormed(v) : ''
}

function codeOf (v:unknown):string {
    return typeof v === 'number' ? String(v) : str(v)
}

function failed (prefix:string, message:string, code:string):ProviderError {
    const suffix = code !== '' ? ` (code: ${code})` : ''
    return new ProviderError(`${prefix}: ${message}${suffix}`, {
        providerCode:code || undefined,
        providerMessage:message,
        retryable:false,
    })
}

function finishFor (reason:string, hasCall:boolean):FinishReason {
    if (reason === '') return hasCall ? 'tool-calls' : 'stop'
    if (reason === 'max_tokens' || reason === 'max_output_tokens') {
        return 'length'
    }
    if (reason === 'content_filter') return 'content-filter'
    return hasCall ? 'tool-calls' : 'other'
}

// Assembles one turn from Responses API events (spec 06, 2.8.2). Reads
// the stream to its end so capture sees every byte; events after the
// terminal one are ignored.
export async function decodeResponses (
    events:AsyncIterable<SseEvent>
):Promise<ModelTurn> {
    const parts:AssistantPart[] = []
    const open = new Set<number>()
    let last:AssistantPart|null = null
    let hasCall = false
    let terminal:Json|null = null

    function append (type:'text'|'reasoning', delta:string):void {
        if (last && last.type !== 'tool-call' && last.type === type) {
            last.text += delta
            return
        }
        const part = { type, text:delta }
        last = part
        parts.push(part)
    }

    for await (const ev of events) {
        if (terminal) continue
        let data:Json
        try {
            data = obj(JSON.parse(ev.data))
        } catch (err) {
            throw new ProviderError('malformed responses stream event',
                { retryable:false, cause:err })
        }
        const type = str(data.type) || ev.event
        const index = typeof data.output_index === 'number' ?
            data.output_index :
            0
        const item = obj(data.item)
        switch (type) {
            case 'response.output_item.added':
                if (item.type === 'function_call') open.add(index)
                break
            case 'response.output_item.done':
                if (item.type === 'function_call' && open.has(index)) {
                    open.delete(index)
                    last = {
                        type:'tool-call',
                        id:str(item.call_id),
                        name:str(item.name),
                        input:str(item.arguments),
                    }
                    parts.push(last)
                    hasCall = true
                }
                break
            case 'response.output_text.delta':
                append('text', str(data.delta))
                break
            case 'response.reasoning_summary_text.delta':
                append('reasoning', str(data.delta))
                break
            case 'response.completed':
            case 'response.incomplete':
                terminal = obj(data.response)
                break
            case 'response.failed': {
                const e = obj(obj(data.response).error)
                throw failed('response failed', str(e.message),
                    codeOf(e.code))
            }
            case 'error':
                throw failed('response error', str(data.message),
                    codeOf(data.code))
            default:
                break
        }
    }
    if (!terminal) throw new IncompleteStreamError()

    const reason = str(obj(terminal.incomplete_details).reason)
    const turn:ModelTurn = {
        parts,
        finishReason:finishFor(reason, hasCall),
        usage:normalizeUsage(responsesUsage(terminal.usage)),
    }
    if (reason !== '') turn.rawFinishReason = reason
    return turn
}
