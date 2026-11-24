// Streaming git helpers for the context area, on top of the shared runner
// in src/git/. Blocking calls go through `git` / `gitOk` there; these two
// stream stdout so a large blob is never buffered whole, and kill the
// child (rather than drain it) once the reader has what it needs.
import { spawn } from 'node:child_process'

export interface ContextOpts {
    // Kills every git child on abort.
    signal?:AbortSignal;
    // The environment git runs with, normally the CLI context's env. Only
    // when absent is process.env used.
    env?:NodeJS.ProcessEnv;
}

export interface StreamOpts extends ContextOpts {
    // Variables merged over `env`.
    extraEnv?:Record<string, string>;
}

export interface GitStreamExit {
    // null when git was killed by a signal or could not be started.
    code:number|null;
    stderr:string;
    error?:Error;
}

export interface GitStream {
    stdout:AsyncIterable<Buffer>;
    // Safe to call more than once and after exit.
    kill ():void;
    // Always resolves, also after an abort or kill; callers check their
    // signal.
    done:Promise<GitStreamExit>;
}

// How long a child gets after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 1000

// The read buffer for streamed git output.
export const STREAM_BUFFER = 64 * 1024

// Runs `git -C <repo> <args>` with stdout streamed.
export function gitStream (
    repo:string,
    args:readonly string[],
    opts:StreamOpts = {}
):GitStream {
    const env = { ...(opts.env ?? process.env), ...opts.extraEnv }
    const child = spawn('git', ['-C', repo, ...args], {
        env,
        stdio:['ignore', 'pipe', 'pipe'],
    })
    const err:Buffer[] = []
    let spawnError:Error|undefined
    let killTimer:NodeJS.Timeout|undefined
    let exited = false

    function kill ():void {
        if (exited) return
        child.kill('SIGTERM')
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }
    const { signal } = opts
    if (signal?.aborted) kill()
    else signal?.addEventListener('abort', kill, { once:true })

    child.stderr.on('data', (chunk:Buffer) => err.push(chunk))
    // A destroyed stdout (consumer stopped iterating) must not crash.
    child.stdout.on('error', () => {})
    const done = new Promise<GitStreamExit>(resolve => {
        child.on('error', e => { spawnError ??= e })
        child.on('close', code => {
            exited = true
            clearTimeout(killTimer)
            signal?.removeEventListener('abort', kill)
            resolve({
                code,
                stderr:Buffer.concat(err).toString(),
                error:spawnError,
            })
        })
    })
    return { stdout:child.stdout, kill, done }
}

export interface CappedOutput {
    // false when git failed and the output was not truncated.
    ok:boolean;
    // At most `limit` bytes of stdout.
    out:Buffer;
    // stdout held more than `limit` bytes; git was killed.
    truncated:boolean;
}

// Reads up to `limit` bytes of stdout, probes for one more, and kills git
// if more remains. Rejects with the signal's reason on abort.
export async function gitCapped (
    repo:string,
    args:readonly string[],
    limit:number,
    opts:StreamOpts = {}
):Promise<CappedOutput> {
    opts.signal?.throwIfAborted()
    const s = gitStream(repo, args, opts)
    const chunks:Buffer[] = []
    let total = 0
    let truncated = false
    try {
        for await (const chunk of s.stdout) {
            const room = limit - total
            if (chunk.length > room) {
                if (room > 0) chunks.push(chunk.subarray(0, room))
                total = limit
                truncated = true
                break
            }
            chunks.push(chunk)
            total += chunk.length
        }
    } finally {
        if (truncated) s.kill()
    }
    const exit = await s.done
    opts.signal?.throwIfAborted()
    const ok = truncated || (exit.code === 0 && !exit.error)
    return { ok, out:Buffer.concat(chunks, total), truncated }
}
