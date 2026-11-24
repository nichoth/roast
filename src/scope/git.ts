// Scope-specific git wrappers on top of the shared runner in src/git/.
// Only gitPatch spawns git itself: it streams stdout through a
// SectionCapper so a huge file never sits in memory whole.
import { spawn } from 'node:child_process'
import { git, gitOk, GitError, type GitRunOpts } from '../git/git.js'
import { DIFF_CONFIG } from './constants.js'
import { SectionCapper } from './patch.js'

export { git, gitOk, GitError, type GitRunOpts }

// How long a child gets after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 1000

// `DIFF_CONFIG diff <args>`: every diff invocation starts this way.
export function diffArgs (...args:readonly string[]):string[] {
    return [...DIFF_CONFIG, 'diff', ...args]
}

export interface PatchResult {
    out:Buffer;
    cut:string[];
}

// Runs a patch-producing git command, cutting each file section at
// maxSection bytes. A non-zero exit rejects with a GitError; an abort
// kills git and rejects with the signal's reason.
export function gitPatch (
    repo:string,
    args:readonly string[],
    maxSection:number,
    opts:GitRunOpts = {}
):Promise<PatchResult> {
    const { signal } = opts
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason)
            return
        }
        const env = { ...(opts.env ?? process.env), ...opts.extraEnv }
        const child = spawn('git', ['-C', repo, ...args], {
            env,
            stdio:['ignore', 'pipe', 'pipe'],
        })
        const capper = new SectionCapper(maxSection)
        const err:Buffer[] = []
        let killTimer:NodeJS.Timeout|undefined
        let failure:Error|undefined

        function kill ():void {
            child.kill('SIGTERM')
            killTimer ??= setTimeout(() => child.kill('SIGKILL'),
                KILL_GRACE_MS)
        }
        signal?.addEventListener('abort', kill, { once:true })

        child.stdout.on('data', (chunk:Buffer) => {
            if (failure) return
            try {
                capper.write(chunk)
            } catch (e) {
                failure = e as Error
                kill()
            }
        })
        child.stdout.on('error', e => {
            failure ??= e
            kill()
        })
        child.stderr.on('data', (chunk:Buffer) => err.push(chunk))
        child.on('error', e => { failure ??= e })
        child.on('close', (code, sig) => {
            clearTimeout(killTimer)
            signal?.removeEventListener('abort', kill)
            if (signal?.aborted) {
                reject(signal.reason)
            } else if (failure) {
                reject(failure)
            } else if (code !== 0) {
                reject(new GitError(code, sig,
                    Buffer.concat(err).toString()))
            } else {
                resolve(capper.finish())
            }
        })
    })
}

// Wraps a git failure as `<prefix>: <cause>`; an abort passes through.
export function wrapGitError (
    prefix:string,
    err:unknown,
    signal?:AbortSignal
):unknown {
    if (signal?.aborted) return err
    const msg = err instanceof Error ? err.message : String(err)
    return new Error(`${prefix}: ${msg}`, { cause:err })
}
