// A `node:http` fake inference server (Go httptest plus providerServer):
// it records every request and answers from a script that looks at the
// request (path, body, headers) and the request's position.
import {
    createServer,
    type IncomingHttpHeaders,
    type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeInferenceStream } from './inference-stream.js'

export interface RecordedRequest {
    method:string;
    path:string;
    headers:IncomingHttpHeaders;
    // Header names and values exactly as sent, in order.
    rawHeaders:string[];
    rawBody:Buffer;
    // The parsed JSON body; undefined when it is not JSON.
    body:unknown;
}

export type Reply =
    // A complete response object, streamed in the protocol's SSE format;
    // the protocol defaults to the one the request path implies.
    | { stream:unknown, protocol?:string }
    | { status:number, headers?:Record<string, string>, body?:string|Buffer }
    // Full control: write the response yourself.
    | ((res:ServerResponse, req:RecordedRequest) => void|Promise<void>)

// Picks the reply for the n-th request (0-based).
export type Script = (req:RecordedRequest, n:number) => Reply

export interface InferenceServer {
    // `http://127.0.0.1:<port>`.
    url:string;
    requests:RecordedRequest[];
    close ():Promise<void>;
}

export function protocolForPath (path:string):string {
    if (path.endsWith('/chat/completions')) return 'chat'
    if (path.endsWith('/responses')) return 'responses'
    if (path.endsWith('/v1/messages')) return 'anthropic'
    return ''
}

async function reply (res:ServerResponse, req:RecordedRequest, r:Reply) {
    if (typeof r === 'function') {
        await r(res, req)
        return
    }
    if ('stream' in r) {
        writeInferenceStream(res, r.protocol ?? protocolForPath(req.path),
            r.stream)
        return
    }
    res.writeHead(r.status, r.headers ?? {})
    res.end(r.body ?? '')
}

export async function startInferenceServer (
    script:Script
):Promise<InferenceServer> {
    const requests:RecordedRequest[] = []
    const server = createServer((req, res) => {
        const parts:Buffer[] = []
        req.on('data', (c:Buffer) => parts.push(c))
        req.on('end', () => {
            const rawBody = Buffer.concat(parts)
            let body:unknown
            try {
                body = JSON.parse(rawBody.toString('utf8'))
            } catch {
                body = undefined
            }
            const rec:RecordedRequest = {
                method:req.method ?? '',
                path:req.url ?? '',
                headers:req.headers,
                rawHeaders:req.rawHeaders,
                rawBody,
                body,
            }
            const n = requests.length
            requests.push(rec)
            Promise.resolve()
                .then(() => reply(res, rec, script(rec, n)))
                .catch((err:unknown) => {
                    if (!res.headersSent) res.writeHead(500)
                    res.end(String(err))
                })
        })
    })
    await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    return {
        url:`http://127.0.0.1:${port}`,
        requests,
        close () {
            server.closeAllConnections()
            return new Promise<void>(resolve => server.close(() => resolve()))
        },
    }
}
