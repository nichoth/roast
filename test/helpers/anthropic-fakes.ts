// Anthropic Messages fakes: a response builder, Go's `bindingServer`
// (signed thinking bound to its prefix) and `deepSeekThinkingServer`
// (DeepSeek thinking mode on chat and its Anthropic endpoint).
import type { ServerResponse } from 'node:http'
import {
    startInferenceServer,
    type InferenceServer,
    type RecordedRequest,
    type Script,
} from './inference-server.js'
import { writeInferenceStream } from './inference-stream.js'
import { encodeToolResult } from '../../src/llm/json.js'

type Json = Record<string, unknown>

export interface Call {
    name:string;
    args:unknown;
}

export const ANTHROPIC_USAGE = {
    input_tokens:10,
    output_tokens:4,
    cache_creation_input_tokens:2,
    cache_read_input_tokens:3,
}

export function thinkingBlock (text:string, signature = ''):Json {
    return { type:'thinking', thinking:text, signature }
}

export function toolUseBlock (id:string, name:string, args:unknown):Json {
    return { type:'tool_use', id, name, input:args }
}

// A complete Messages response; `stop_reason` follows the content unless
// given.
export function anthropicMessage (content:Json[], opts:{
    stop?:string,
    usage?:Json,
    model?:string,
} = {}):Json {
    const calls = content.some(b => b.type === 'tool_use')
    return {
        id:'msg-1',
        type:'message',
        role:'assistant',
        model:opts.model ?? 'claude-test',
        content,
        stop_reason:opts.stop ?? (calls ? 'tool_use' : 'end_turn'),
        usage:opts.usage ?? ANTHROPIC_USAGE,
    }
}

// A response calling each of `calls` in order (text when none).
export function anthropicCalls (calls:Call[], opts:{
    thinking?:string,
    usage?:Json,
} = {}):Json {
    const content:Json[] = []
    if (opts.thinking !== undefined) {
        content.push(thinkingBlock(opts.thinking, 'sig-fixture'))
    }
    if (calls.length === 0) content.push({ type:'text', text:'done' })
    calls.forEach((c, i) => {
        content.push(toolUseBlock(`toolu-${i}`, c.name, c.args))
    })
    return anthropicMessage(content, { usage:opts.usage })
}

// Tool names an Anthropic request offers.
export function anthropicToolNames (req:RecordedRequest):string[] {
    const body = req.body as { tools?:{ name:string }[] }
    return (body?.tools ?? []).map(t => t.name)
}

// Parsed-JSON identity: key order and whitespace are ignored.
function canonical (v:unknown):string {
    return encodeToolResult(v ?? null)
}

function reject (res:ServerResponse, body:unknown):void {
    res.writeHead(400, { 'Content-Type':'application/json' })
    res.end(JSON.stringify(body))
}

export interface BindingServer extends InferenceServer {
    rejected:number;
}

// Go bindingServer: a signed thinking block is valid only while the
// system prompt, the tool set, and every content block before it are
// unchanged (compared as parsed JSON). The fake signs every thinking
// block it emits over its prefix. `respond(n)` gives the content of the
// n-th (1-based) response.
export async function startBindingServer (
    respond:(request:number) => Json[]
):Promise<BindingServer> {
    const issued = new Map<string, string>()
    let count = 0
    const holder:{ server?:BindingServer } = {}
    const server = await startInferenceServer(req => res => {
        const body = (req.body ?? {}) as {
            system?:unknown,
            tools?:unknown,
            messages?:{ role:string, content:unknown[] }[],
        }
        count++
        let prefix = canonical(body.system) + '\n' +
            canonical(body.tools) + '\n'
        const msgs = body.messages ?? []
        for (let i = 0; i < msgs.length; i++) {
            prefix += msgs[i].role + ':'
            const content = Array.isArray(msgs[i].content) ?
                msgs[i].content :
                []
            for (let j = 0; j < content.length; j++) {
                const block = (content[j] ?? {}) as Json
                if (block.type === 'thinking') {
                    const want = issued.get(String(block.signature))
                    if (want !== prefix) {
                        if (holder.server) holder.server.rejected++
                        reject(res, {
                            type:'error',
                            error:{
                                type:'invalid_request_error',
                                message:`messages.${i}.content.${j}: ` +
                                    'Invalid `signature` in `thinking` block',
                            },
                        })
                        return
                    }
                }
                prefix += canonical(block) + '\n'
            }
        }
        const content = respond(count).map(b => ({ ...b }))
        prefix += 'assistant:'
        let stop = 'end_turn'
        for (const block of content) {
            if (block.type === 'thinking') {
                const sig = `sig-${issued.size + 1}`
                block.signature = sig
                issued.set(sig, prefix)
            } else if (block.type === 'tool_use') {
                stop = 'tool_use'
            }
            prefix += canonical(block) + '\n'
        }
        writeInferenceStream(res, 'anthropic', {
            ...anthropicMessage(content, { stop }),
            id:`msg-${count}`,
            usage:{ input_tokens:10, output_tokens:5 },
        })
    })
    holder.server = Object.assign(server, { rejected:0 })
    return holder.server
}

export interface DeepSeekServer extends InferenceServer {
    // Requests answered 400.
    rejected:RecordedRequest[];
}

// What a DeepSeek fake answers: a tool call, or prose when `tool` is
// empty; `finish` overrides the natural finish reason.
export interface DeepSeekAnswer {
    tool:string;
    args?:unknown;
    finish?:string;
}

// Go deepSeekThinkingServer as a script: any forced tool choice is a
// 400, and with tools present every earlier assistant message must
// replay its reasoning (`reasoning_content` on chat, a leading
// `thinking` block on anthropic). `respond(req, n)` answers the n-th
// (1-based) request; `rejected` collects the requests answered 400.
export function deepSeekScript (
    protocol:'chat'|'anthropic',
    respond:(req:RecordedRequest, n:number) => DeepSeekAnswer
):{ script:Script, rejected:RecordedRequest[] } {
    const rejected:RecordedRequest[] = []
    let count = 0
    const script:Script = req => res => {
        const body = (req.body ?? {}) as {
            tool_choice?:unknown,
            tools?:unknown[],
            messages?:Json[],
        }
        const call = ++count
        const choice = body.tool_choice
        let auto = choice === undefined || choice === null ||
            choice === 'auto'
        if (choice !== null && typeof choice === 'object') {
            auto = (choice as Json).type === 'auto'
        }
        if (!auto) {
            rejected.push(req)
            reject(res, {
                error:{
                    message:'Thinking mode does not support this ' +
                        'tool_choice',
                    type:'invalid_request_error',
                },
            })
            return
        }
        const hasTools = (body.tools ?? []).length > 0
        for (const m of body.messages ?? []) {
            if (m.role !== 'assistant' || !hasTools) continue
            const ok = protocol === 'chat' ?
                'reasoning_content' in m :
                Array.isArray(m.content) &&
                    (m.content[0] as Json|undefined)?.type === 'thinking'
            if (!ok) {
                rejected.push(req)
                reject(res, {
                    type:'error',
                    error:{
                        type:'invalid_request_error',
                        message:'The thinking in the thinking mode must ' +
                            'be passed back to the API.',
                    },
                })
                return
            }
        }
        const answer = respond(req, call)
        writeInferenceStream(res, protocol, protocol === 'chat' ?
            deepSeekChat(answer, call) :
            deepSeekAnthropic(answer, call))
    }
    return { script, rejected }
}

export async function startDeepSeekServer (
    protocol:'chat'|'anthropic',
    respond:(req:RecordedRequest, n:number) => DeepSeekAnswer
):Promise<DeepSeekServer> {
    const { script, rejected } = deepSeekScript(protocol, respond)
    const server = await startInferenceServer(script)
    return Object.assign(server, { rejected })
}

function deepSeekChat (a:DeepSeekAnswer, call:number):Json {
    const message:Json = {
        role:'assistant',
        reasoning_content:'Thinking it through.',
    }
    let natural = 'stop'
    if (a.tool === '') {
        message.content = 'Here is my answer in prose.'
    } else {
        natural = 'tool_calls'
        message.tool_calls = [{
            id:`call-${call}`,
            type:'function',
            function:{ name:a.tool, arguments:JSON.stringify(a.args ?? {}) },
        }]
    }
    return {
        id:'chat',
        object:'chat.completion',
        model:'deepseek-test',
        choices:[{
            index:0,
            finish_reason:a.finish || natural,
            message,
        }],
        usage:{ prompt_tokens:10, completion_tokens:5, total_tokens:15 },
    }
}

function deepSeekAnthropic (a:DeepSeekAnswer, call:number):Json {
    const content:Json[] = [
        thinkingBlock('Thinking it through.', `ds-${call}`),
    ]
    let natural = 'end_turn'
    if (a.tool === '') {
        content.push({ type:'text', text:'Here is my answer in prose.' })
    } else {
        natural = 'tool_use'
        content.push(toolUseBlock(`toolu-${call}`, a.tool, a.args ?? {}))
    }
    return anthropicMessage(content, {
        stop:a.finish || natural,
        usage:{ input_tokens:10, output_tokens:5 },
        model:'deepseek-test',
    })
}
