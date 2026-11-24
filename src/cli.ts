// The bundle entry. The Node version check runs before the CLI body is
// loaded, so an older Node fails with a clear message instead of an
// obscure error later.
import { checkNodeVersion, installWarningFilter } from './startup.js'

const versionError = checkNodeVersion(process.versions.node)
if (versionError) {
    process.stderr.write(`${versionError.message}\n`)
    process.exit(2)
}
installWarningFilter()

const { run } = await import('./cli/run.js')
const { createSignalHandler, createStdoutErrorHandler } =
    await import('./cli/process.js')

const exit = (code:number):void => {
    process.exitCode = code
    process.exit(code)
}

// First SIGINT/SIGTERM cancels the command; a second exits 130.
const controller = new AbortController()
const onSignal = createSignalHandler(controller, exit)
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

// A closed stdout pipe never prints a stack trace; the process exits with
// the computed code.
const done:{ code?:number } = {}
process.stdout.on('error', createStdoutErrorHandler(() => done.code, exit))

const { code } = await run(process.argv.slice(2), {
    stdin:process.stdin,
    stdout:process.stdout,
    stderr:process.stderr,
    env:process.env,
    cwd:process.cwd(),
    signal:controller.signal,
})
done.code = code

// Wait for both streams to flush, then exit even if a handle lingers.
function flush (stream:NodeJS.WriteStream):Promise<void> {
    return new Promise(resolve => {
        if (stream.destroyed) {
            resolve()
            return
        }
        stream.write('', () => resolve())
    })
}
await Promise.all([flush(process.stdout), flush(process.stderr)])
exit(code)
