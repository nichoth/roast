// Log lines on stderr: `roast: <text>\n`, sanitized so control bytes in
// repository paths or Git output never reach the terminal.
import { text } from '../textsafe/textsafe.js'

export function logf (out:NodeJS.WritableStream, message:string):void {
    out.write(`roast: ${text(message)}\n`)
}
