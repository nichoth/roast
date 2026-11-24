// The `anthropic` protocol (native Messages API; DeepSeek's
// Anthropic-compatible endpoint): a pure request encoder and stream
// decoder (spec 06, 2.6.3 and 2.8.3).

import { trimSlashes, type EncodeConfig, type EncodeRequest } from './chat.js'
import {
    IncompleteStreamError,
    ProviderError,
    streamError,
} from './errors.js'
import { wellFormed } from './json.js'
import { anthropicDefaultThinking } from './models.js'
import type { SseEvent } from './sse.js'
import type {
    AssistantPart,
    ConversationItem,
    FinishReason,
    ModelTurn,
    ToolDefinition,
} from './types.js'
import { anthropicUsage, normalizeUsage } from './usage.js'

type Json = Record<string, unknown>

// `<base'>/v1/messages`, where base' drops trailing slashes and then one
// trailing `/v1`.
export function anthropicUrl (baseUrl:string):string {
    let base = trimSlashes(baseUrl)
    if (base.endsWith('/v1')) base = base.slice(0, -3)
    return `${base}/v1/messages`
}

function toolInput (raw:string):Json {
    try {
        const v:unknown = JSON.parse(raw)
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            return v as Json
        }
    } catch {
        // Blank or invalid input still pairs with its tool_result.
    }
    return {}
}

function assistantBlock (p:AssistantPart):Json|null {
    if (p.type === 'text') return { type:'text', text:p.text }
    if (p.type === 'tool-call') {
        return {
            type:'tool_use',
            id:p.id,
            name:p.name,
            input:toolInput(p.input)
        }
    }
    if (p.signature) {
        return { type:'thinking', thinking:p.text, signature:p.signature }
    }
    if (p.redactedData) return { type:'redacted_thinking', data:p.redactedData }
    return null
}

function userBlocks (item:ConversationItem):Json[] {
    if (item.role === 'user') return [{ type:'text', text:item.text }]
    if (item.role !== 'tool') return []
    return item.results.map(r => {
        const block:Json = {
            type:'tool_result',
            tool_use_id:r.callId,
            content:[{ type:'text', text:r.output }],
        }
        if (r.isError) block.is_error = true
        return block
    })
}

// Alternating role blocks: consecutive user texts and tool results merge
// into one user message; consecutive assistant turns into one assistant
// message, blocks in arrival order. A thinking-only assistant message is
// dropped.
function messages (items:readonly ConversationItem[]):Json[] {
    const out:{ role:'user'|'assistant', content:Json[] }[] = []
    for (const item of items) {
        const role = item.role === 'assistant' ? 'assistant' : 'user'
        let last = out[out.length - 1]
        if (!last || last.role !== role) {
            last = { role, content:[] }
            out.push(last)
        }
        if (item.role === 'assistant') {
            for (const p of item.parts) {
                const block = assistantBlock(p)
                if (block) last.content.push(block)
            }
        } else {
            last.content.push(...userBlocks(item))
        }
    }
    return out.filter(m => m.role === 'user' || m.content.some(b =>
        b.type === 'text' || b.type === 'tool_use'))
}

function inputSchema (tool:ToolDefinition):Json {
    const schema = structuredClone(tool.schema) as Json
    schema.type = 'object'
    if (!Array.isArray(schema.required)) schema.required = []
    return schema
}

// The request body. Tool choice is always automatic.
export function encodeAnthropic (
    config:EncodeConfig,
    req:EncodeRequest
):Json {
    const body:Json = {
        model:config.model,
        max_tokens:config.maxOutputTokens,
        system:[{ type:'text', text:req.system }],
        messages:messages(req.items),
        stream:true,
    }
    if (anthropicDefaultThinking(config.model)) {
        body.thinking = { type:'adaptive', display:'summarized' }
    }
    if (req.tools.length > 0) {
        body.tools = req.tools.map(tool => ({
            name:tool.name,
            description:tool.description ?? '',
            input_schema:inputSchema(tool),
        }))
        body.tool_choice = { type:'auto', disable_parallel_tool_use:false }
    }
    return body
}

function obj (v:unknown):Json {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ?
        v as Json :
        {}
}

function str (v:unknown):string {
    return typeof v === 'string' ? wellFormed(v) : ''
}

const FINISH:Record<string, FinishReason> = {
    end_turn:'stop',
    pause_turn:'stop',
    stop_sequence:'stop',
    max_tokens:'length',
    model_context_window_exceeded:'length',
    tool_use:'tool-calls',
    refusal:'content-filter',
    content_filtered:'content-filter',
    guardrail_intervened:'content-filter',
}

const RAW_EXPOSED = new Set<FinishReason>([
    'length',
    'content-filter',
    'unknown',
])

const USAGE_FIELDS = [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
] as const

interface OpenBlock {
    type:string;
    text:string;
    signature:string;
    data:string;
    id:string;
    name:string;
    input:string;
    startInput:unknown;
}

function closeBlock (b:OpenBlock):AssistantPart|null {
    switch (b.type) {
        case 'text':
            return { type:'text', text:b.text }
        case 'thinking':
            return { type:'reasoning', text:b.text, signature:b.signature }
        case 'redacted_thinking':
            return { type:'reasoning', text:'', redactedData:b.data }
        case 'tool_use': {
            let input = b.input
            if (input === '') {
                const start = obj(b.startInput)
                input = Object.keys(start).length > 0 ?
                    JSON.stringify(start) :
                    '{}'
            }
            return { type:'tool-call', id:b.id, name:b.name, input }
        }
        default:
            return null
    }
}

// Assembles one turn from Messages stream events (spec 06, 2.8.3).
// Throws the 2.10 error kinds.
export async function decodeAnthropic (
    events:AsyncIterable<SseEvent>
):Promise<ModelTurn> {
    const parts:AssistantPart[] = []
    const open = new Map<number, OpenBlock>()
    let usage:Json = {}
    let rawFinish = ''
    let stopped = false

    for await (const ev of events) {
        let e:Json
        try {
            e = obj(JSON.parse(ev.data))
        } catch (err) {
            throw new ProviderError('malformed anthropic stream event',
                { retryable:false, cause:err })
        }
        const index = typeof e.index === 'number' ? e.index : 0
        switch (e.type) {
            case 'message_start':
                usage = { ...obj(obj(e.message).usage) }
                break
            case 'content_block_start': {
                const cb = obj(e.content_block)
                open.set(index, {
                    type:str(cb.type),
                    text:'',
                    signature:'',
                    data:str(cb.data),
                    id:str(cb.id),
                    name:str(cb.name),
                    input:'',
                    startInput:cb.input,
                })
                break
            }
            case 'content_block_delta': {
                const b = open.get(index)
                const d = obj(e.delta)
                if (!b) break
                if (d.type === 'text_delta') b.text += str(d.text)
                else if (d.type === 'thinking_delta') b.text += str(d.thinking)
                else if (d.type === 'signature_delta') {
                    b.signature += str(d.signature)
                } else if (d.type === 'input_json_delta') {
                    b.input += str(d.partial_json)
                }
                break
            }
            case 'content_block_stop': {
                const b = open.get(index)
                if (!b) break
                open.delete(index)
                const part = closeBlock(b)
                if (part) parts.push(part)
                break
            }
            case 'message_delta': {
                rawFinish = str(obj(e.delta).stop_reason)
                const u = obj(e.usage)
                if (typeof u.output_tokens === 'number') {
                    usage.output_tokens = u.output_tokens
                }
                for (const k of USAGE_FIELDS) {
                    if (u[k] !== undefined && u[k] !== null) usage[k] = u[k]
                }
                break
            }
            case 'message_stop':
                stopped = true
                break
            case 'error': {
                const err = obj(e.error)
                throw streamError(str(err.type), '',
                    str(err.message) || JSON.stringify(e.error))
            }
            default:
                break
        }
        if (stopped) break
    }

    if (!stopped || rawFinish === '') throw new IncompleteStreamError()
    const finishReason = Object.hasOwn(FINISH, rawFinish) ?
        FINISH[rawFinish] :
        'unknown'
    const turn:ModelTurn = {
        parts,
        finishReason,
        usage:normalizeUsage(anthropicUsage(usage)),
    }
    if (RAW_EXPOSED.has(finishReason)) turn.rawFinishReason = rawFinish
    return turn
}
