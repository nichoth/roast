// pattern: Imperative Shell
// Chat, responses, and anthropic fake that requires automatic choice
// and a stable probe prefix.
import type { RecordedRequest, Reply, Script }
    from './inference-server.js'
import { anthropicCalls } from './anthropic-fakes.js'

type Json = Record<string, unknown>

// The anthropic form of the probe (path `/v1/messages`).
function anthropicProbe (
    prefixes:Map<string, { messages:unknown[], tools:unknown }>,
    req:RecordedRequest
):Reply {
    const body = req.body as {
        messages:{ role:string, content:Json[] }[],
        tools:unknown,
        tool_choice?:{ type?:string },
    }
    if (body.tool_choice !== undefined && body.tool_choice.type !== 'auto') {
        return { status:400, body:'forced tool choice' }
    }
    const messages = body.messages
    const result = messages.flatMap(m => m.content)
        .find(b => b.type === 'tool_result')
    const key = String(req.headers['x-api-key'])
    if (!result) {
        prefixes.set(key, { messages, tools:body.tools })
        return { stream:anthropicCalls([{ name:'doctor_lookup', args:{} }]) }
    }
    const prefix = prefixes.get(key)
    if (!prefix || JSON.stringify(body.tools) !==
        JSON.stringify(prefix.tools) ||
        JSON.stringify(messages.slice(0, prefix.messages.length)) !==
        JSON.stringify(prefix.messages)) {
        return { status:400, body:'changed conversation prefix' }
    }
    const content = result.content as { text:string }[]
    const token = JSON.parse(content[0].text).token
    return {
        stream:anthropicCalls([{
            name:'doctor_probe', args:{ ok:true, token },
        }]),
    }
}

export function probeCall (name:string, args:unknown):Reply {
    return {
        stream:{
            choices:[{
                index:0,
                message:{
                    role:'assistant',
                    tool_calls:[{
                        id:'doctor-call',
                        type:'function',
                        function:{ name, arguments:JSON.stringify(args) },
                    }]
                },
                finish_reason:'tool_calls',
            }],
        }
    }
}

export function responsesProbeCall (name:string, args:unknown):Reply {
    return {
        stream:{
            id:'resp-doctor',
            status:'completed',
            output:[{
                type:'function_call',
                id:'fc-doctor',
                call_id:'doctor-call',
                name,
                arguments:JSON.stringify(args),
                status:'completed',
            }],
            usage:{ input_tokens:1, output_tokens:1, total_tokens:2 },
        }
    }
}

export function doctorProbe ():Script {
    const prefixes = new Map<string, { messages:unknown[], tools:unknown }>()
    return (req:RecordedRequest) => {
        if (req.path.endsWith('/v1/messages')) {
            return anthropicProbe(prefixes, req)
        }
        const body = req.body as {
            messages?:Record<string, unknown>[],
            input?:Record<string, unknown>[],
            tools:unknown,
            tool_choice?:unknown,
        }
        if (body.tool_choice !== undefined && body.tool_choice !== 'auto') {
            return { status:400, body:'forced tool choice' }
        }
        const responses = body.input !== undefined
        const call = responses ? responsesProbeCall : probeCall
        const messages = body.messages ?? body.input ?? []
        const result = messages.find(m => m.role === 'tool' ||
            m.type === 'function_call_output')
        const key = String(req.headers.authorization)
        if (!result) {
            prefixes.set(key, { messages, tools:body.tools })
            return call('doctor_lookup', {})
        }
        const prefix = prefixes.get(key)
        if (!prefix || JSON.stringify(body.tools) !==
            JSON.stringify(prefix.tools) ||
            JSON.stringify(messages.slice(0, prefix.messages.length)) !==
            JSON.stringify(prefix.messages)) {
            return { status:400, body:'changed conversation prefix' }
        }
        const output = responses ? result.output : result.content
        const token = JSON.parse(String(output)).token
        return call('doctor_probe', { ok:true, token })
    }
}
