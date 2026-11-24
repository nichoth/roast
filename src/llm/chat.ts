// The `chat` protocol (OpenAI Chat Completions; OpenRouter, DeepSeek,
// others): a pure request encoder and stream decoder (spec 06, 2.6.1 and
// 2.8.1).

import {
    IncompleteStreamError,
    ProviderError,
    streamError,
} from './errors.js'
import { wellFormed } from './json.js'
import { isChatReasoningModel } from './models.js'
import type { SseEvent } from './sse.js'
import type {
    AssistantPart,
    ConversationItem,
    FinishReason,
    ModelTurn,
    ToolDefinition,
} from './types.js'
import { chatUsage, normalizeUsage } from './usage.js'

export interface EncodeConfig {
    model:string;
    maxOutputTokens:number;
}

export interface EncodeRequest {
    system:string;
    items:readonly ConversationItem[];
    tools:readonly ToolDefinition[];
}

export function trimSlashes (url:string):string {
    let end = url.length
    while (end > 0 && url.charCodeAt(end - 1) === 47) end--
    return url.slice(0, end)
}

export function chatUrl (baseUrl:string):string {
    return `${trimSlashes(baseUrl)}/chat/completions`
}

function assistantMessage (
    parts:readonly AssistantPart[]
):Record<string, unknown>|null {
    const texts:string[] = []
    const reasoning:string[] = []
    const calls:unknown[] = []
    for (const p of parts) {
        if (p.type === 'text') texts.push(p.text)
        else if (p.type === 'reasoning') reasoning.push(p.text)
        else {
            calls.push({
                id:p.id,
                type:'function',
                function:{ name:p.name, arguments:p.input },
            })
        }
    }
    if (texts.length === 0 && calls.length === 0) return null
    const msg:Record<string, unknown> = { role:'assistant' }
    if (texts.length > 0) msg.content = texts.join('\n')
    if (calls.length > 0) msg.tool_calls = calls
    if (reasoning.length > 0) msg.reasoning_content = reasoning.join('\n')
    return msg
}

function messages (req:EncodeRequest):unknown[] {
    const out:unknown[] = []
    if (req.system !== '') out.push({ role:'system', content:req.system })
    for (const item of req.items) {
        if (item.role === 'user') {
            out.push({ role:'user', content:item.text })
        } else if (item.role === 'assistant') {
            const msg = assistantMessage(item.parts)
            if (msg) out.push(msg)
        } else {
            for (const r of item.results) {
                out.push({
                    role:'tool',
                    tool_call_id:r.callId,
                    content:r.output,
                })
            }
        }
    }
    return out
}

// The request body. Tool choice is always automatic.
export function encodeChat (
    config:EncodeConfig,
    req:EncodeRequest
):Record<string, unknown> {
    const body:Record<string, unknown> = {
        model:config.model,
        messages:messages(req),
    }
    if (isChatReasoningModel(config.model)) {
        body.max_completion_tokens = config.maxOutputTokens
    } else {
        body.max_tokens = config.maxOutputTokens
    }
    body.stream = true
    body.stream_options = { include_usage:true }
    if (req.tools.length > 0) {
        body.tools = req.tools.map(tool => ({
            type:'function',
            function:{
                name:tool.name,
                description:tool.description ?? '',
                parameters:structuredClone(tool.schema),
                strict:false,
            },
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

function protocolError (message:string, cause?:unknown):ProviderError {
    return new ProviderError(message, { retryable:false, cause })
}

interface OpenCall {
    index:number;
    id:string;
    name:string;
    args:string;
}

const FINISH:Record<string, FinishReason> = {
    stop:'stop',
    length:'length',
    content_filter:'content-filter',
    tool_calls:'tool-calls',
    function_call:'tool-calls',
    insufficient_system_resource:'error',
}

const RAW_EXPOSED = new Set<FinishReason>([
    'length',
    'content-filter',
    'error',
    'unknown',
])

const SUPPRESS_CALLS = new Set<FinishReason>([
    'length',
    'content-filter',
    'error',
])

function validJson (s:string):boolean {
    try {
        JSON.parse(s)
        return true
    } catch {
        return false
    }
}

// The provider error carried by a chunk's top-level `error` member.
function chunkError (value:unknown):ProviderError {
    const e = obj(value)
    const code = typeof e.code === 'number' ? String(e.code) : str(e.code)
    const message = str(e.message) ||
        (typeof value === 'string' ? value : JSON.stringify(value))
    return streamError(str(e.type), code, message)
}

// Assembles one turn from chat.completion.chunk events (spec 06, 2.8.1).
// Stops reading at `[DONE]`; throws the 2.10 error kinds.
export async function decodeChat (
    events:AsyncIterable<SseEvent>
):Promise<ModelTurn> {
    const parts:AssistantPart[] = []
    let text:{ type:'text', text:string }|null = null
    let reasoning:{ type:'reasoning', text:string }|null = null
    let reasoningEnded = false
    const calls = new Map<number, OpenCall>()
    let rawFinish = ''
    let usage:unknown

    function openReasoning ():{ type:'reasoning', text:string } {
        if (!reasoning) {
            reasoning = { type:'reasoning', text:'' }
            parts.push(reasoning)
            text = null
        }
        return reasoning
    }

    function onDelta (delta:Json, finish:string):void {
        const content = str(delta.content)
        const toolCalls = Array.isArray(delta.tool_calls) ?
            delta.tool_calls :
            []
        const boundary = content !== '' ||
            Array.isArray(delta.tool_calls) || finish !== ''
        const field = delta.reasoning_content ?? delta.reasoning
        const thought = str(field)
        if (thought !== '') {
            openReasoning().text += thought
        } else if (typeof field === 'string' && !boundary &&
            !reasoningEnded) {
            openReasoning()
        }
        if (boundary && reasoning) {
            reasoning = null
            reasoningEnded = true
        }
        if (content !== '') {
            if (!text) {
                text = { type:'text', text:'' }
                parts.push(text)
            }
            text.text += content
        }
        for (const raw of toolCalls) onToolCall(obj(raw))
    }

    function onToolCall (tc:Json):void {
        const index = typeof tc.index === 'number' ? tc.index : 0
        const fn = obj(tc.function)
        const name = str(fn.name)
        const args = str(fn.arguments)
        const open = calls.get(index)
        if (open) {
            open.args += args
            return
        }
        if (name === '' && args === '') return
        const type = tc.type === undefined || tc.type === null ?
            'function' :
            tc.type
        if (type !== 'function') {
            throw protocolError(
                `unsupported tool call type ${JSON.stringify(type)}`)
        }
        calls.set(index, {
            index,
            id:str(tc.id) || `tool-call-${index}`,
            name,
            args,
        })
    }

    for await (const ev of events) {
        if (ev.data.startsWith('[DONE]')) break
        let chunk:Json
        try {
            chunk = obj(JSON.parse(ev.data))
        } catch (err) {
            throw protocolError('malformed chat stream event', err)
        }
        if ('error' in chunk) throw chunkError(chunk.error)
        const u = obj(chunk.usage)
        if (typeof u.total_tokens === 'number' && u.total_tokens > 0) {
            usage = chunk.usage
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : []
        for (const raw of choices) {
            const choice = obj(raw)
            const finish = str(choice.finish_reason)
            onDelta(obj(choice.delta), finish)
            if (finish !== '') rawFinish = finish
        }
    }

    const ordered = [...calls.values()].sort((a, b) => a.index - b.index)
    let finishReason:FinishReason
    if (rawFinish !== '') {
        finishReason = Object.hasOwn(FINISH, rawFinish) ?
            FINISH[rawFinish] :
            'unknown'
    } else if (ordered.length > 0) {
        if (ordered.some(c => c.args === '' || !validJson(c.args))) {
            throw new IncompleteStreamError()
        }
        finishReason = 'tool-calls'
    } else {
        throw new IncompleteStreamError()
    }

    const turn:ModelTurn = {
        parts,
        finishReason,
        usage:normalizeUsage(chatUsage(usage)),
    }
    if (rawFinish !== '' && RAW_EXPOSED.has(finishReason)) {
        turn.rawFinishReason = rawFinish
    }
    if (ordered.length > 0 && SUPPRESS_CALLS.has(finishReason)) {
        turn.rawFinishReason = rawFinish
        return turn
    }
    for (const c of ordered) {
        parts.push({
            type:'tool-call',
            id:c.id,
            name:c.name,
            input:c.args === '' ? '{}' : c.args,
        })
    }
    return turn
}
