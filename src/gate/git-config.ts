// The git calls the gate makes (spec 12, 2.2), all `git -C <repo> ...`
// through the shared runner with the caller's env.
import path from 'node:path'
import { git, gitOk } from '../git/git.js'

export type Env = Readonly<Record<string, string|undefined>>

function opts (env:Env):{ env:NodeJS.ProcessEnv } {
    return { env:env as NodeJS.ProcessEnv }
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// A local config value, trimmed; '' when unset or on any failure.
export async function configGet (
    repo:string,
    key:string,
    env:Env
):Promise<string> {
    try {
        const out = await git(repo, ['config', '--local', '--get', key],
            opts(env))
        return out.toString().trim()
    } catch {
        return ''
    }
}

export async function configSet (
    repo:string,
    key:string,
    value:string,
    env:Env
):Promise<void> {
    try {
        await git(repo, ['config', '--local', key, value], opts(env))
    } catch (err) {
        throw new Error(`git config ${key}: ${message(err)}`, { cause:err })
    }
}

// Unsets a local key; reports only whether git succeeded (exit 5 means
// the key was not set, which callers ignore).
export function configUnset (
    repo:string,
    key:string,
    env:Env
):Promise<boolean> {
    return gitOk(repo, ['config', '--local', '--unset', key], opts(env))
}

// Whether any config scope sets core.hooksPath (not only --local: a global
// or system hooks directory is shared too).
export function hooksPathConfigured (repo:string, env:Env):Promise<boolean> {
    return gitOk(repo, ['config', '--get', 'core.hooksPath'], opts(env))
}

// The absolute path of hooks/<name>. Git honours core.hooksPath and, in a
// linked worktree, the common git dir.
export async function resolveHookPath (
    repo:string,
    name:string,
    env:Env
):Promise<string> {
    let out:string
    try {
        out = (await git(repo, ['rev-parse', '--git-path', `hooks/${name}`],
            opts(env))).toString().trim()
    } catch (err) {
        throw new Error(`resolve hooks path in ${repo}: ${message(err)}`,
            { cause:err })
    }
    if (out === '') {
        throw new Error(`resolve hooks path in ${repo}: git returned nothing`)
    }
    return path.isAbsolute(out) ? out : path.join(repo, out)
}
