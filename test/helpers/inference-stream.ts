// Fixture writer for fake inference servers (spec 01, 3.8; Go
// testutil.WriteInferenceStream): from a complete response object, emit
// the protocol's native SSE stream (`chat`, `responses`, and `anthropic`).

// The part of `http.ServerResponse` the writer uses.
export interface StreamSink {
    setHeader (name:string, value:string):unknown;
    write (chunk:string):unknown;
    end ():unknown;
}

type Json = Record<string, unknown>

function obj (v:unknown):Json {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ?
        v as Json :
        {}
}

function event (data:unknown, name?:string):string {
    const head = name ? `event: ${name}\n` : ''
    const body = typeof data === 'string' ? data : JSON.stringify(data)
    return `${head}data: ${body}\n\n`
}

// Three chunks (delta, finish, usage) and `[DONE]`.
function chatEvents (response:Json):string[] {
    const base = {
        id:response.id,
        object:'chat.completion.chunk',
        created:1,
        model:response.model,
    }
    const choices = Array.isArray(response.choices) ? response.choices : []
    const deltas = choices.map((c:unknown) => {
        const choice = obj(c)
        const delta = { ...obj(choice.message) }
        if (Array.isArray(delta.tool_calls)) {
            delta.tool_calls = delta.tool_calls.map((tc:unknown, i:number) => (
                { ...obj(tc), index:i }
            ))
        }
        return { index:choice.index, delta, finish_reason:null }
    })
    const finishes = choices.map((c:unknown) => {
        const choice = obj(c)
        return {
            index:choice.index,
            delta:{},
            finish_reason:choice.finish_reason,
        }
    })
    return [
        event({ ...base, choices:deltas }),
        event({ ...base, choices:finishes }),
        event({ ...base, choices:[], usage:response.usage }),
        event('[DONE]'),
    ]
}

function named (data:Json):string {
    return event(data, String(data.type))
}

// message_start, per block start/deltas/stop, message_delta, message_stop.
function anthropicEvents (response:Json):string[] {
    const usage = obj(response.usage)
    const out = [named({
        type:'message_start',
        message:{
            ...response,
            content:[],
            stop_reason:null,
            usage:{ ...usage, output_tokens:0 },
        },
    })]
    const content = Array.isArray(response.content) ? response.content : []
    content.forEach((raw:unknown, index:number) => {
        const block = obj(raw)
        const startBlock:Json = { ...block }
        let deltas:Json[]
        if (block.type === 'thinking') {
            startBlock.thinking = ''
            startBlock.signature = ''
            deltas = [
                { type:'thinking_delta', thinking:block.thinking },
                { type:'signature_delta', signature:block.signature },
            ]
        } else if (block.type === 'text') {
            startBlock.text = ''
            deltas = [{ type:'text_delta', text:block.text }]
        } else {
            startBlock.input = {}
            deltas = [{
                type:'input_json_delta',
                partial_json:JSON.stringify(block.input ?? null),
            }]
        }
        out.push(named({
            type:'content_block_start', index, content_block:startBlock,
        }))
        for (const delta of deltas) {
            out.push(named({ type:'content_block_delta', index, delta }))
        }
        out.push(named({ type:'content_block_stop', index }))
    })
    out.push(named({
        type:'message_delta',
        delta:{ stop_reason:response.stop_reason, stop_sequence:null },
        usage:response.usage,
    }))
    out.push(named({ type:'message_stop' }))
    return out
}

// `response.created`, four events per output item, `response.completed`;
// every object carries `sequence_number` in emission order. Each item is
// treated as a function call, as in Go.
function responsesEvents (response:Json):string[] {
    const objects:Json[] = [{
        type:'response.created',
        response:{ ...response, output:[], status:'in_progress' },
    }]
    const output = Array.isArray(response.output) ? response.output : []
    output.forEach((raw:unknown, index:number) => {
        const item = obj(raw)
        const args = item.arguments ?? null
        objects.push(
            {
                type:'response.output_item.added',
                output_index:index,
                item:{ ...item, arguments:'', status:'in_progress' },
            },
            {
                type:'response.function_call_arguments.delta',
                output_index:index,
                item_id:item.id ?? null,
                delta:args,
            },
            {
                type:'response.function_call_arguments.done',
                output_index:index,
                item_id:item.id ?? null,
                arguments:args,
            },
            { type:'response.output_item.done', output_index:index, item },
        )
    })
    objects.push({ type:'response.completed', response })
    return objects.map((o, i) => event({ ...o, sequence_number:i },
        o.type as string))
}

export function writeInferenceStream (
    res:StreamSink,
    protocol:string,
    response:unknown
):void {
    let events:string[]
    if (protocol === 'chat') events = chatEvents(obj(response))
    else if (protocol === 'responses') {
        events = responsesEvents(obj(response))
    } else if (protocol === 'anthropic') {
        events = anthropicEvents(obj(response))
    } else throw new Error(`unsupported inference protocol "${protocol}"`)
    res.setHeader('Content-Type', 'text/event-stream')
    for (const e of events) res.write(e)
    res.end()
}

// `writeInferenceStream` from a JSON string.
export function writeJSONStream (
    res:StreamSink,
    protocol:string,
    body:string
):void {
    writeInferenceStream(res, protocol, JSON.parse(body))
}
