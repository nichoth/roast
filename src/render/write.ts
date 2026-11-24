// pattern: Imperative Shell
import type { Writable } from 'node:stream'
import { toJSON, toMarkdown, type Report } from './render.js'

export function writeReport (
    io:{ stdout:Writable; stderr:Writable },
    format:'json'|'markdown'|'both',
    showDropped:boolean,
    report:Report,
):void {
    if (format === 'json' || format === 'both') {
        io.stdout.write(toJSON(report) + '\n')
    }
    if (format === 'markdown' || format === 'both') {
        io.stderr.write(toMarkdown(report, showDropped) + '\n')
    }
}
