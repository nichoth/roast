// Process-level handlers for the entry (src/cli.ts), kept here with an
// injectable `exit` so tests can drive them without a real process.
import { CancelledError } from './errors.js'

export type Exit = (code:number) => void

// The SIGINT/SIGTERM handler: the first signal aborts `controller` with a
// CancelledError so the command winds down; a second exits 130 at once.
export function createSignalHandler (
    controller:AbortController,
    exit:Exit
):() => void {
    let signalled = false
    return () => {
        if (signalled) {
            exit(130)
            return
        }
        signalled = true
        controller.abort(new CancelledError())
    }
}

// The stdout `error` listener. An EPIPE (the reader went away) is
// swallowed with no stack trace: while the command still runs its later
// writes are dropped, and once `code()` is known the process exits with
// it. Any other error is rethrown.
export function createStdoutErrorHandler (
    code:() => number|undefined,
    exit:Exit
):(err:Error) => void {
    let broken = false
    return (err:Error) => {
        const errCode = (err as NodeJS.ErrnoException).code
        const pipe = errCode === 'EPIPE' ||
            (broken && errCode === 'ERR_STREAM_DESTROYED')
        if (!pipe) throw err
        broken = true
        const c = code()
        if (c !== undefined) exit(c)
    }
}
