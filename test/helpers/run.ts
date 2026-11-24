// runRoast: the CLI run in-process (spec 01, 3.7) with buffer streams, a
// temporary Git repository as cwd, a clean environment, and optionally a
// fetch that sends every request to a fake server.
import { run, type RunResult } from '../../src/cli/run.js'
import { BufferStream, inputStream } from './streams.js'
import { tempRepo } from './repo.js'

export interface RunRoastOpts {
    // Working directory; a fresh temporary repository when absent.
    cwd?:string;
    // The environment; the repository's isolated env when absent.
    env?:Record<string, string>;
    stdin?:NodeJS.ReadableStream|string;
    signal?:AbortSignal;
    // Origin (`http://127.0.0.1:port`) every request is redirected to.
    redirectTo?:string;
}

export interface RunRoastResult extends RunResult {
    stdout:string;
    stderr:string;
    // The original host of every redirected request, in order.
    hosts:string[];
}

// A fetch that rewrites each URL's origin to `origin`, recording the
// original host (Go redirectDefaultTransport).
export function redirectingFetch (
    origin:string,
    hosts:string[]
):typeof globalThis.fetch {
    return (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        hosts.push(url.host)
        const target = new URL(url.pathname + url.search, origin)
        return globalThis.fetch(new Request(target, req))
    }
}

export async function runRoast (
    args:string[],
    opts:RunRoastOpts = {}
):Promise<RunRoastResult> {
    let cwd = opts.cwd
    let env = opts.env
    let remove:(() => void)|undefined
    if (cwd === undefined) {
        const repo = tempRepo()
        cwd = repo.dir
        env ??= repo.env
        remove = repo.remove
    }
    const stdout = new BufferStream()
    const stderr = new BufferStream()
    const hosts:string[] = []
    const stdin = typeof opts.stdin === 'string' || !opts.stdin ?
        inputStream(opts.stdin ?? '') :
        opts.stdin
    try {
        const res = await run(args, {
            stdin,
            stdout,
            stderr,
            env:env ?? {},
            cwd,
            signal:opts.signal,
            fetch:opts.redirectTo ?
                redirectingFetch(opts.redirectTo, hosts) :
                undefined,
        })
        return {
            ...res,
            stdout:stdout.text(),
            stderr:stderr.text(),
            hosts,
        }
    } finally {
        remove?.()
    }
}
