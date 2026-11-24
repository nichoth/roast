// The swappable `fetch` (the TS form of Go's redirectDefaultTransport,
// shared with login and doctor) and the Roast-controlled request headers
// (spec 06, 2.3). Nothing here reads the environment.

import { buildInfo } from '../buildinfo.js'
import type { Protocol } from './types.js'

let override:typeof globalThis.fetch|undefined

// Replaces the fetch every client without its own `fetch` uses (tests).
export function setFetch (f:typeof globalThis.fetch):void {
    override = f
}

export function resetFetch ():void {
    override = undefined
}

export function currentFetch ():typeof globalThis.fetch {
    return override ?? globalThis.fetch
}

export function userAgent ():string {
    return `roast/${buildInfo.version}`
}

// Every header of one request. The session headers are set last; header
// names are case-insensitive, so a session header spelled like another
// header yields one header holding the session ID.
export function requestHeaders (
    protocol:Protocol,
    apiKey:string,
    sessionId:string,
    sessionHeader?:string
):Headers {
    const h = new Headers()
    h.set('Content-Type', 'application/json')
    h.set('Accept', 'text/event-stream')
    if (protocol === 'anthropic') {
        h.set('X-Api-Key', apiKey)
        h.set('Anthropic-Version', '2023-06-01')
    } else {
        h.set('Authorization', `Bearer ${apiKey}`)
    }
    h.set('User-Agent', userAgent())
    h.set('X-Agent-Session-Id', sessionId)
    if (sessionHeader) h.set(sessionHeader, sessionId)
    return h
}
