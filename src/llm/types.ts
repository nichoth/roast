// Protocol-neutral types for the LLM layer (spec 06, 3.1; spec 07, 3.3).

export type Protocol = 'chat'|'responses'|'anthropic'

export interface RawResponse {
    role:string;
    protocol:Protocol;
    model:string;
    contentType:'application/json'|'text/event-stream';
    // Exact bytes of the body: no request, no headers.
    body:Uint8Array;
}

export interface ClientConfig {
    // "finder", "verifier", or a doctor check name.
    role:string;
    baseUrl:string;
    apiKey:string;
    // Sent verbatim as the body's `model`.
    model:string;
    // "" means chat.
    protocol:''|Protocol;
    maxOutputTokens:number;
    // Attempts per model call; <= 0 means DEFAULT_MAX_ATTEMPTS.
    maxAttempts:number;
    // Per request; 0 disables.
    requestTimeoutMs:number;
    sessionHeader?:string;
    captureResponse?:(raw:RawResponse) => Promise<void>|void;
    // Overrides the module-level fetch (http.ts) for this client.
    fetch?:typeof globalThis.fetch;
}

export interface ToolDefinition {
    name:string;
    description:string;
    // The complete caller JSON Schema.
    schema:Record<string, unknown>;
}

// A tool the agent loop offers the model (spec 07, 3.3). The final tool
// has no `run`.
export interface Tool {
    name:string;
    description:string;
    schema:Record<string, unknown>;
    run?:(args:Record<string, unknown>, signal:AbortSignal) =>
        unknown|Promise<unknown>;
    recordsResult?:boolean;
}

export type AssistantPart =
    | { type:'text', text:string }
    | {
        type:'reasoning';
        text:string;
        signature?:string;
        redactedData?:string;
    }
    // `input` is the raw argument string as received.
    | { type:'tool-call', id:string, name:string, input:string }

export interface ToolResult {
    callId:string;
    name:string;
    output:string;
    isError:boolean;
}

export type ConversationItem =
    | { role:'user', text:string }
    | { role:'assistant', parts:AssistantPart[] }
    | { role:'tool', results:ToolResult[] }

export interface Usage {
    uncachedInputTokens:number;
    cachedInputTokens:number;
    cacheWriteTokens:number;
    outputTokens:number;
    calls:number;
}

export interface ModelRequest {
    system:string;
    items:ConversationItem[];
    tools:ToolDefinition[];
    sessionId:string;
    // Already composed by the agent loop (caller, deadline, timeout).
    signal:AbortSignal;
    onUsage?:(usage:Usage) => void;
}

export type FinishReason =
    'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other'|'unknown'

export interface ModelTurn {
    // Arrival order; replayed verbatim.
    parts:AssistantPart[];
    finishReason:FinishReason;
    rawFinishReason?:string;
    // Normalized, calls: 1.
    usage:Usage;
}

// Progress report for one dispatched exploration or record call, or a
// call to an unknown tool (spec 07, 2.10).
export interface TurnInfo {
    turn:number;
    tool:string;
    args:Record<string, unknown>;
}

// Type validation of the final arguments (spec 07, 2.7). `decode`
// receives the value parsed with integer preservation (unsafe integers
// are `bigint`) and the original argument text for lexical checks, and
// throws an Error whose message is the detail.
export interface FinalSpec<T> {
    decode (value:unknown, rawText?:string):T;
}

export interface ConverseOptions<T> {
    // Exploration, record, and final tools, in order.
    tools:readonly Tool[];
    finalTool:string;
    final:FinalSpec<T>;
    // Turn at which the final phase starts; <= 0 means 8.
    maxTurns?:number;
    onTurn?:(info:TurnInfo) => void;
    // <= 0 means 3e6.
    inputByteCeiling?:number;
    // Absolute time, ms since the epoch.
    workDeadline?:number;
    // ms; <= 0 means 90000.
    wrapUpWindow?:number;
    onWorkDeadline?:() => void;
    onBudgetExhausted?:() => void;
}

// Usage as written into run records: snake_case, disjoint counts.
export interface RecordUsage {
    uncached_input_tokens:number;
    cached_input_tokens:number;
    cache_write_tokens:number;
    output_tokens:number;
    calls:number;
}

// One configured model role, as the finder and verifier call it.
export interface Client {
    // The request model name.
    readonly name:string;
    converse<T> (
        system:string,
        user:string,
        opts:ConverseOptions<T>,
        signal:AbortSignal
    ):Promise<T>;
    completeStructured<T> (
        system:string,
        user:string,
        schemaName:string,
        result:{ schema:Record<string, unknown>, decode:FinalSpec<T>['decode'] },
        signal:AbortSignal
    ):Promise<T>;
    usage ():RecordUsage;
}
