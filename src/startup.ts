// Startup guards that run before the CLI body loads. Kept to plain syntax
// and APIs so an old Node that can parse the bundle still reaches the
// version check.

const FLOOR_MAJOR = 22
const FLOOR_MINOR = 18

// Returns an error naming the required and the running version when
// `version` (a `process.versions.node` string) is below 22.18, else null.
export function checkNodeVersion (version:string):Error|null {
    const parts = version.split('.')
    const major = Number(parts[0])
    const minor = Number(parts[1])
    const ok = major > FLOOR_MAJOR ||
        (major === FLOOR_MAJOR && minor >= FLOOR_MINOR)
    if (ok) return null
    return new Error(`roast requires Node.js ${FLOOR_MAJOR}.${FLOOR_MINOR}` +
        ` or later; this is Node.js ${version}`)
}

type WarningListener = (warning:Error) => void

// node:zlib emits this while zstd is experimental; Roast uses zstd for
// run bundles, so the warning is noise for users.
function isZstdExperimentalWarning (warning:Error):boolean {
    return warning.name === 'ExperimentalWarning' &&
        /\bzstd\b/i.test(warning.message)
}

// Wraps the original `warning` listeners (Node's printer among them) so
// they see every warning except the zstd ExperimentalWarning.
export function filterWarnings (listeners:WarningListener[]):WarningListener {
    return warning => {
        if (isZstdExperimentalWarning(warning)) return
        for (const listener of listeners) listener(warning)
    }
}

// Replaces the process `warning` listeners with the filtered wrapper.
// With --no-warnings Node installs no printer, and nothing is printed.
export function installWarningFilter ():void {
    const original = process.listeners('warning') as WarningListener[]
    process.removeAllListeners('warning')
    process.on('warning', filterWarnings(original))
}
