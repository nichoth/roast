// The one git runner. Every area runs git through here; scope and context
// add their specialized wrappers (patch capping, streaming) on top.

import { spawn } from 'node:child_process'

export class GitError extends Error {
    exitCode:number|null
    stderr:string

    constructor (exitCode:number|null, signal:string|null, stderr:string) {
        const status = exitCode === null ?
            `signal: ${signal}` :
            `exit status ${exitCode}`
        const detail = stderr.trim()
        super(detail ? `${status}: ${detail}` : status)
        this.name = 'GitError'
        this.exitCode = exitCode
        this.stderr = stderr
    }
}

export interface GitRunOpts {
    // Kills the child on abort; the call rejects with the signal's reason.
    signal?:AbortSignal;
    // The environment git runs with, normally the CLI context's env. Only
    // when absent is process.env used.
    env?:NodeJS.ProcessEnv;
    // Variables merged over `env`.
    extraEnv?:Record<string, string>;
    // Written to stdin, which is then closed.
    input?:Buffer|string;
}

// How long a child gets after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 1000

interface Exit {
    code:number|null;
    signal:string|null;
    stdout:Buffer;
    stderr:Buffer;
}

function runGit (
    repo:string,
    args:readonly string[],
    opts:GitRunOpts
):Promise<Exit> {
    const { signal } = opts
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const env = { ...(opts.env ?? process.env), ...opts.extraEnv }
        const child = spawn('git', ['-C', repo, ...args], {
            env,
            stdio:['pipe', 'pipe', 'pipe'],
        })
        const out:Buffer[] = []
        const err:Buffer[] = []
        let killTimer:NodeJS.Timeout|undefined
        let spawnError:Error|undefined

        function onAbort ():void {
            child.kill('SIGTERM')
            killTimer = setTimeout(() => child.kill('SIGKILL'),
                KILL_GRACE_MS)
        }
        signal?.addEventListener('abort', onAbort, { once:true })

        child.stdout.on('data', (chunk:Buffer) => out.push(chunk))
        child.stderr.on('data', (chunk:Buffer) => err.push(chunk))
        child.on('error', e => { spawnError ??= e })
        // A child that exits without reading stdin closes the pipe; that
        // EPIPE is not a git failure.
        child.stdin.on('error', () => {})
        if (opts.input !== undefined) child.stdin.end(opts.input)
        else child.stdin.end()

        child.on('close', (code, sig) => {
            clearTimeout(killTimer)
            signal?.removeEventListener('abort', onAbort)
            if (signal?.aborted) {
                reject(signal.reason)
            } else if (spawnError) {
                reject(spawnError)
            } else {
                resolve({
                    code,
                    signal:sig,
                    stdout:Buffer.concat(out),
                    stderr:Buffer.concat(err),
                })
            }
        })
    })
}

// Runs `git -C <repo> <args>` and resolves stdout. A non-zero exit
// rejects with a GitError.
export async function git (
    repo:string,
    args:readonly string[],
    opts:GitRunOpts = {}
):Promise<Buffer> {
    const exit = await runGit(repo, args, opts)
    if (exit.code !== 0) {
        throw new GitError(exit.code, exit.signal, exit.stderr.toString())
    }
    return exit.stdout
}

// Exit status only: false on a non-zero exit. Rejects only on abort or
// when git cannot be started.
export async function gitOk (
    repo:string,
    args:readonly string[],
    opts:GitRunOpts = {}
):Promise<boolean> {
    const exit = await runGit(repo, args, opts)
    return exit.code === 0
}

// The repository toplevel containing `start`.
export async function gitRoot (
    start:string,
    opts:GitRunOpts = {}
):Promise<string> {
    let out:Buffer
    try {
        out = await git(start, ['rev-parse', '--show-toplevel'], opts)
    } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new Error('not inside a git repository', { cause:err })
    }
    return out.toString().trim()
}
