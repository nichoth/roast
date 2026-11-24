// Transcript size (spec 07, 2.13 "Transcript bytes").

import type { ConversationItem } from './types.js'

// UTF-8 byte length of the JSON serialization of the transcript's
// messages, system prompt included, tool definitions excluded.
export function transcriptBytes (
    system:string,
    items:readonly ConversationItem[]
):number {
    const json = JSON.stringify([{ role:'system', text:system }, ...items])
    return Buffer.byteLength(json, 'utf8')
}
