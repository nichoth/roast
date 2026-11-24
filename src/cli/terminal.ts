// Shared terminal helpers (spec 01, 2.16): yes/no prompt, secret input,
// terminal detection, browser opening. Terminal detection and browser
// opening are swappable through `terminalHooks` so tests never touch a
// real terminal or launch a browser.
import { spawn } from 'node:child_process'
import { isatty } from 'node:tty'
import { goTrimSpace } from '../gocompat/strings.js'
import { CancelledError } from './errors.js'

// Reads a stream one character or line at a time. One reader serves every
// prompt in a command, so input buffered past one answer is kept for the
// next. The stream is attached lazily, on the first read.
export class LineReader {
    private readonly stream:NodeJS.ReadableStream
    private buf = ''
    private ended = false
    private error:Error|undefined
    private attached = false
    private wake:(() => void)|undefined

    constructor (stream:NodeJS.ReadableStream) {
        this.stream = stream
    }

    private attach ():void {
        if (this.attached) return
        this.attached = true
        const notify = ():void => {
            const w = this.wake
            this.wake = undefined
            w?.()
        }
        this.stream.setEncoding('utf8')
        this.stream.on('data', (chunk:string) => {
            this.buf += chunk
            notify()
        })
        this.stream.on('end', () => {
            this.ended = true
            notify()
        })
        this.stream.on('error', (err:Error) => {
            this.error = err
            notify()
        })
    }

    // Waits until the buffer holds data, the stream ended, or failed.
    private async fill ():Promise<void> {
        this.attach()
        while (this.buf === '' && !this.ended && !this.error) {
            this.stream.resume()
            await new Promise<void>(resolve => { this.wake = resolve })
        }
        this.stream.pause()
        if (this.buf === '' && this.error) throw this.error
    }

    // The next character, or null at end of input.
    async readChar ():Promise<string|null> {
        await this.fill()
        if (this.buf === '') return null
        const c = String.fromCodePoint(this.buf.codePointAt(0) as number)
        this.buf = this.buf.slice(c.length)
        return c
    }

    // The next line without its line ending, or null at end of input with
    // nothing read. A last line without a newline is returned as is.
    async readLine ():Promise<string|null> {
        let line = ''
        for (;;) {
            await this.fill()
            if (this.buf === '') return line === '' ? null : line
            const i = this.buf.indexOf('\n')
            if (i >= 0) {
                line += this.buf.slice(0, i)
                this.buf = this.buf.slice(i + 1)
                return line.endsWith('\r') ? line.slice(0, -1) : line
            }
            line += this.buf
            this.buf = ''
        }
    }
}

// Writes `<question> [Y/n] ` and reads one answer: empty, y, or yes (any
// case) is true; anything else, or end of input, is false.
export async function promptYesDefault (
    out:NodeJS.WritableStream,
    lines:LineReader,
    question:string
):Promise<boolean> {
    out.write(`${question} [Y/n] `)
    const answer = await lines.readLine()
    if (answer === null) return false
    const a = goTrimSpace(answer).toLowerCase()
    return a === '' || a === 'y' || a === 'yes'
}

// Writes `<question> [y/N] ` and reads one answer: only y or yes (any
// case, surrounding space ignored) is true; empty input, anything else,
// or end of input is false.
export async function promptNoDefault (
    out:NodeJS.WritableStream,
    lines:LineReader,
    question:string
):Promise<boolean> {
    out.write(`${question} [y/N] `)
    const answer = await lines.readLine()
    if (answer === null) return false
    const a = goTrimSpace(answer).toLowerCase()
    return a === 'y' || a === 'yes'
}

interface RawTTY {
    isTTY?:boolean;
    setRawMode?:(on:boolean) => unknown;
}

function rawCapable (stdin:NodeJS.ReadableStream):stdin is
    NodeJS.ReadableStream&Required<RawTTY> {
    const s = stdin as NodeJS.ReadableStream&RawTTY
    return s.isTTY === true && typeof s.setRawMode === 'function'
}

const CTRL_C = '\x03'
const CTRL_D = '\x04'
const BACKSPACE = '\x08'
const DELETE = '\x7f'

// Reads one line in raw mode without echo. Ctrl-C cancels.
async function readRawLine (lines:LineReader):Promise<string|null> {
    let line = ''
    for (;;) {
        const c = await lines.readChar()
        if (c === null) return line === '' ? null : line
        if (c === '\r' || c === '\n') return line
        if (c === CTRL_C) throw new CancelledError()
        if (c === CTRL_D && line === '') return null
        if (c === BACKSPACE || c === DELETE) {
            line = line.slice(0, -1)
            continue
        }
        line += c
    }
}

// Writes `prompt` and reads one secret. On a TTY it reads in raw mode
// without echo (Ctrl-C is cancellation); otherwise one plain line from
// the shared reader. The result is trimmed; end of input with no text is
// an error.
export async function readSecret (
    out:NodeJS.WritableStream,
    stdin:NodeJS.ReadableStream,
    lines:LineReader,
    prompt:string
):Promise<string> {
    out.write(prompt)
    let answer:string|null
    if (rawCapable(stdin)) {
        stdin.setRawMode(true)
        try {
            answer = await readRawLine(lines)
        } finally {
            stdin.setRawMode(false)
            out.write('\n')
        }
    } else {
        answer = await lines.readLine()
    }
    if (answer === null) throw new Error('no input: end of file')
    return goTrimSpace(answer)
}

function isTerminal (stream:unknown):boolean {
    const s = stream as { isTTY?:boolean, fd?:unknown }
    return s.isTTY === true && typeof s.fd === 'number' && isatty(s.fd)
}

// Both streams are real terminals. A stream without a file descriptor,
// such as a test buffer, never is.
function defaultInteractiveTerminals (
    stdin:NodeJS.ReadableStream,
    stderr:NodeJS.WritableStream
):boolean {
    return isTerminal(stdin) && isTerminal(stderr)
}

// Starts `open <url>` (darwin) or `xdg-open <url>` without waiting for
// it. Resolves with a spawn error, or undefined once started. The child
// is killed when `signal` aborts.
function defaultOpenBrowser (
    url:string,
    signal?:AbortSignal
):Promise<Error|undefined> {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    return new Promise(resolve => {
        const child = spawn(cmd, [url], {
            stdio:'ignore',
            detached:true,
            signal,
        })
        child.on('spawn', () => {
            child.unref()
            resolve(undefined)
        })
        // Also swallows the AbortError emitted when `signal` kills it.
        child.on('error', err => resolve(err))
    })
}

export const terminalHooks = {
    interactiveTerminals:defaultInteractiveTerminals,
    openBrowser:defaultOpenBrowser,
}

export function interactiveTerminals (
    stdin:NodeJS.ReadableStream,
    stderr:NodeJS.WritableStream
):boolean {
    return terminalHooks.interactiveTerminals(stdin, stderr)
}

export function openBrowser (
    url:string,
    signal?:AbortSignal
):Promise<Error|undefined> {
    return terminalHooks.openBrowser(url, signal)
}
