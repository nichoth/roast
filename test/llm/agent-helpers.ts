// A scripted fake ModelClient for agent-loop tests: each request takes
// the next step of the script (a canned turn, an error to throw, or a
// function of the request), and every request is recorded.
import type { ModelClient } from '../../src/llm/client.js'
import { createClient, type CreateClientOptions } from '../../src/llm/client.js'
import type {
    AssistantPart,
    Client,
    ClientConfig,
    ConversationItem,
    ConverseOptions,
    FinishReason,
    ModelRequest,
    ModelTurn,
    Tool,
    ToolDefinition,
    Usage,
} from '../../src/llm/types.js'
import { zeroUsage } from '../../src/llm/usage.js'

export type Step =
    | ModelTurn
    | Error
    | ((req:ModelRequest, n:number) => ModelTurn|Promise<ModelTurn>)

export interface Recorded {
    system:string;
    items:ConversationItem[];
    tools:ToolDefinition[];
    sessionId:string;
    signal:AbortSignal;
    // Whether the signal was already aborted when the request arrived.
    abortedAtSend:boolean;
}

export interface FakeModel {
    model:ModelClient;
    requests:Recorded[];
}

export function fakeModel (
    script:Step[]|((req:ModelRequest, n:number) => Step),
    over:Partial<ClientConfig> = {}
):FakeModel {
    const config:ClientConfig = {
        role:'finder',
        baseUrl:'http://fake.invalid',
        apiKey:'sk-test',
        model:'fake-model',
        protocol:'chat',
        maxOutputTokens:100,
        maxAttempts:4,
        requestTimeoutMs:0,
        ...over,
    }
    const requests:Recorded[] = []
    const model:ModelClient = {
        config,
        protocol:'chat',
        maxAttempts:config.maxAttempts > 0 ? config.maxAttempts : 4,
        requestBytes:() => 100,
        usage:zeroUsage,
        async send (req:ModelRequest):Promise<ModelTurn> {
            const n = requests.length
            requests.push({
                system:req.system,
                items:structuredClone(req.items),
                tools:structuredClone(req.tools),
                sessionId:req.sessionId,
                signal:req.signal,
                abortedAtSend:req.signal.aborted,
            })
            let step:Step|undefined
            if (typeof script === 'function' && !Array.isArray(script)) {
                step = script(req, n)
            } else {
                step = script[n]
            }
            if (step === undefined) throw new Error(`script exhausted at ${n}`)
            if (step instanceof Error) throw step
            if (typeof step === 'function') return step(req, n)
            return structuredClone(step)
        },
    }
    return { model, requests }
}

export function usage (over:Partial<Usage> = {}):Usage {
    return { ...zeroUsage(), calls:1, ...over }
}

export function turn (
    parts:AssistantPart[],
    finishReason:FinishReason = 'tool-calls',
    u:Usage = usage()
):ModelTurn {
    return { parts, finishReason, usage:u }
}

let ids = 0

export function callPart (
    name:string,
    input:unknown = {},
    id = `call-${++ids}`
):AssistantPart {
    return {
        type:'tool-call',
        id,
        name,
        input:typeof input === 'string' ? input : JSON.stringify(input),
    }
}

// One response calling the given tools.
export function calls (...parts:AssistantPart[]):ModelTurn {
    return turn(parts)
}

export function call (name:string, input:unknown = {}, id?:string):ModelTurn {
    return calls(callPart(name, input, id))
}

export const FINAL = 'submit'

export function submit (input:unknown = { summary:'ok' }):ModelTurn {
    return call(FINAL, input)
}

export function prose (text = 'I think it is fine.'):ModelTurn {
    return turn([{ type:'text', text }], 'stop')
}

export interface Summary {
    summary?:string;
    id?:number|bigint;
}

export const FINAL_SCHEMA = {
    type:'object',
    properties:{
        summary:{ type:'string' },
        id:{ type:'integer' },
    },
    required:['summary'],
    additionalProperties:false,
}

// Mirrors decoding into a typed result: present properties must have the
// right type; absent ones (and null) are allowed.
export function decodeSummary (value:unknown):Summary {
    if (value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('result is not an object')
    }
    const v = value as Record<string, unknown>
    const out:Summary = {}
    if (v.summary !== undefined && v.summary !== null) {
        if (typeof v.summary !== 'string') {
            throw new Error('summary is not a string')
        }
        out.summary = v.summary
    }
    if (v.id !== undefined && v.id !== null) {
        if (typeof v.id === 'bigint') out.id = v.id
        else if (typeof v.id === 'number' && Number.isInteger(v.id)) {
            out.id = v.id
        } else throw new Error('id is not an integer')
    }
    return out
}

export function finalTool ():Tool {
    return {
        name:FINAL,
        description:'Submit the result.',
        schema:structuredClone(FINAL_SCHEMA),
    }
}

// An exploration tool that counts its runs.
export function readTool (log:string[] = []):Tool&{ runs:number } {
    const tool = {
        name:'read',
        description:'Read a file.',
        schema:{
            type:'object',
            properties:{ path:{ type:'string' } },
        },
        runs:0,
        run (args:Record<string, unknown>) {
            tool.runs++
            log.push(`read:${String(args.path)}`)
            return { text:'contents' }
        },
    }
    return tool
}

// A record tool that counts its runs.
export function recordTool (
    onRun?:() => void
):Tool&{ runs:number } {
    const tool = {
        name:'report',
        description:'Record one finding.',
        schema:{ type:'object', properties:{ title:{ type:'string' } } },
        recordsResult:true,
        runs:0,
        run () {
            tool.runs++
            onRun?.()
            return { ok:true }
        },
    }
    return tool
}

export function options (
    tools:Tool[],
    over:Partial<ConverseOptions<Summary>> = {}
):ConverseOptions<Summary> {
    return {
        tools,
        finalTool:FINAL,
        final:{ decode:decodeSummary },
        ...over,
    }
}

export interface Harness extends FakeModel {
    client:Client;
    sleeps:number[];
}

// A client over a fake model; sleeps are recorded and return at once.
export function harness (
    script:Step[]|((req:ModelRequest, n:number) => Step),
    over:Partial<ClientConfig> = {},
    clientOpts:CreateClientOptions = {}
):Harness {
    const fake = fakeModel(script, over)
    const sleeps:number[] = []
    const client = createClient(fake.model, {
        sleep:async ms => { sleeps.push(ms) },
        ...clientOpts,
    })
    return { ...fake, client, sleeps }
}

export async function failure (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    throw new Error('expected a rejection')
}

export function signal ():AbortSignal {
    return new AbortController().signal
}

// The tool results message of a recorded request, if its last item is
// one.
export function lastResults (r:Recorded) {
    const last = r.items[r.items.length - 1]
    return last?.role === 'tool' ? last.results : []
}

// Resolves when `s` aborts. Holds a timer meanwhile: AbortSignal.timeout
// does not keep Node alive, a real request's socket would.
export function aborted (s:AbortSignal):Promise<void> {
    return new Promise(resolve => {
        if (s.aborted) {
            resolve()
            return
        }
        const keep = setInterval(() => {}, 1000)
        s.addEventListener('abort', () => {
            clearInterval(keep)
            resolve()
        }, { once:true })
    })
}
