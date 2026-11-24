// The endpoint rule shared by profile validation and role validation
// (spec 02, 2.4 "Endpoint rule").
import { type Protocol, parseEndpoint } from './provider.js'

export const DEFAULT_PROTOCOL = 'responses'
export const PROTOCOLS:readonly Protocol[] = ['chat', 'responses', 'anthropic']

export function isProtocol (p:string):p is Protocol {
    return (PROTOCOLS as readonly string[]).includes(p)
}

function validUrl (s:string):boolean {
    const u = parseEndpoint(s)
    if (!u) return false
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.username !== '' || u.password !== '') return false
    if (u.search !== '' || u.hash !== '') return false
    return true
}

// Null when the endpoint, protocol, and output limit are usable; else an
// error message naming `field`.
export function endpointProblem (
    field:string,
    endpoint:string,
    protocol:string,
    maxOutputTokens:number
):string|null {
    if (!validUrl(endpoint)) {
        return `${field} endpoint must be an http(s) URL without ` +
            'credentials, a query, or a fragment'
    }
    if (!isProtocol(protocol)) {
        return `${field} protocol must be chat, responses, or anthropic`
    }
    if (maxOutputTokens <= 0) {
        return `${field} max_output_tokens must be positive`
    }
    return null
}
