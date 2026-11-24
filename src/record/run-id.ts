// pattern: Imperative Shell
import { randomBytes } from 'node:crypto'

export function newRunId ():string {
    const utc = new Date().toISOString().slice(0, 19)
        .replaceAll('-', '').replaceAll(':', '') + 'Z'
    return `${utc}-${randomBytes(4).toString('hex')}`
}
