// The shared, pull-based SSE parser (spec 06, 2.7). Bytes are read only
// as the consumer asks for the next event; it never buffers more than the
// current chunk plus a partial line.

export interface SseEvent {
    event:string;
    data:string;
}

interface EventState {
    event:string;
    data:string[];
}

// Applies one line to the event state; returns the event a blank line
// dispatches, if any.
function applyLine (line:string, st:EventState):SseEvent|null {
    if (line === '') {
        const ev = st.data.length > 0 ?
            { event:st.event, data:st.data.join('\n') } :
            null
        st.event = ''
        st.data = []
        return ev
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') st.event = value
    else if (field === 'data') st.data.push(value)
    return null
}

export async function * parseSse (
    chunks:AsyncIterable<Uint8Array>
):AsyncGenerator<SseEvent> {
    const decoder = new TextDecoder('utf-8')
    const st:EventState = { event:'', data:[] }
    let buf = ''
    // A CR ended the previous line; a directly following LF belongs to it.
    let skipLF = false

    function * lines (final:boolean):Generator<string> {
        for (;;) {
            if (skipLF && buf.length > 0) {
                if (buf.charCodeAt(0) === 10) buf = buf.slice(1)
                skipLF = false
            }
            let i = 0
            for (; i < buf.length; i++) {
                const c = buf.charCodeAt(i)
                if (c === 10 || c === 13) break
            }
            if (i === buf.length) {
                if (final && buf.length > 0) {
                    const rest = buf
                    buf = ''
                    yield rest
                }
                return
            }
            const line = buf.slice(0, i)
            skipLF = buf.charCodeAt(i) === 13
            buf = buf.slice(i + 1)
            yield line
        }
    }

    for await (const chunk of chunks) {
        buf += decoder.decode(chunk, { stream:true })
        for (const line of lines(false)) {
            const ev = applyLine(line, st)
            if (ev) yield ev
        }
    }
    buf += decoder.decode()
    for (const line of lines(true)) {
        const ev = applyLine(line, st)
        if (ev) yield ev
    }
    const last = applyLine('', st)
    if (last) yield last
}
