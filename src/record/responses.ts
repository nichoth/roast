// pattern: Imperative Shell
import path from 'node:path'
import { isValidName, makeRunDir, openPrivate } from './dir.js'
import { goStringify, encodeResponseBody } from './json.js'

export const PROVIDER_RESPONSES_FILE = 'provider-responses.jsonl'

export class ResponseRecorder {
    readonly dir:string
    readonly runId:string
    private tail:Promise<void> = Promise.resolve()
    private sequence = 0

    constructor (dir:string, runId:string) {
        this.dir = dir
        this.runId = runId
    }

    append (
        role:string,
        protocol:string,
        model:string,
        contentType:string,
        body:Uint8Array
    ):Promise<void> {
        let encoded:string
        try {
            if (!isValidName(this.runId)) {
                throw new Error('record provider response: invalid run id')
            }
            encoded = encodeResponseBody(contentType, body)
        } catch (err) {
            return Promise.reject(err)
        }
        const write = this.tail.then(async () => {
            const header = goStringify({
                sequence:this.sequence + 1,
                role,
                protocol,
                model,
                content_type:contentType,
            })
            const line = header.slice(0, -1) + ',"body":' + encoded + '}\n'
            const runDir = await makeRunDir(this.dir, this.runId)
            const file = path.join(runDir, PROVIDER_RESPONSES_FILE)
            const handle = await openPrivate(file, 'a')
            try {
                await handle.writeFile(line)
                await handle.sync()
            } finally {
                await handle.close()
            }
            this.sequence++
        })
        this.tail = write.catch(() => {})
        return write
    }
}
