// pattern: Imperative Shell
// Shared provider fake for login and init. Inference replies can be
// supplied by callers when they also exercise a model request.
import {
    startInferenceServer,
    type Reply,
    type Script,
} from './inference-server.js'

export async function providerServer (inference?:Script) {
    const credentials:string[] = []
    const hooks = {
        answerModels:(key:string):number|Reply => key === '' ? 401 : 200,
        answerKey:(key:string):number|Reply => key === '' ? 401 : 200,
    }
    const server = await startInferenceServer((req, n) => {
        const key = String(req.headers['x-api-key'] ??
            req.headers.authorization ?? '')
        credentials.push(key)
        if (req.method === 'GET' && req.path === '/v1/models') {
            if (req.headers['x-api-key'] &&
                req.headers['anthropic-version'] !== '2023-06-01') {
                return { status:400 }
            }
            const answer = hooks.answerModels(key)
            return typeof answer === 'number' ?
                { status:answer, body:'{}' } : answer
        }
        if (req.method === 'POST' &&
            req.path === '/api/v1/auth/keys') {
            const body = req.body as { code?:string }
            return {
                status:200,
                body:JSON.stringify({
                    key:`sk-or-minted-${body.code}`,
                })
            }
        }
        if (req.method === 'GET' && req.path === '/api/v1/key') {
            const answer = hooks.answerKey(key)
            return typeof answer === 'number' ?
                { status:answer, body:'{}' } : answer
        }
        return inference?.(req, n) ?? { status:404 }
    })
    return { ...server, credentials, hooks }
}
