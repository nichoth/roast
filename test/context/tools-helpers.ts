// Helpers for the exploration tool tests: call a tool by name on a tree
// of a temporary repository.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { explorationTools } from '../../src/context/tools.js'
import {
    LIVE_TREE,
    pinIndexTree,
    pinnedWorktree,
    type Tree,
} from '../../src/context/tree.js'
import { tempDir, type TestRepo } from '../scope/helpers.js'

export type Result = Record<string, unknown>

export async function call (
    repo:TestRepo,
    tree:Tree,
    name:string,
    args:Record<string, unknown>,
    opts:{ env?:NodeJS.ProcessEnv, signal?:AbortSignal } = {}
):Promise<Result> {
    const tool = explorationTools(repo.dir, tree, { env:opts.env ?? repo.env })
        .find(x => x.name === name)
    if (!tool?.run) throw new Error(`no tool ${name}`)
    const signal = opts.signal ?? new AbortController().signal
    return await tool.run(args, signal) as Result
}

export async function stagedTree (repo:TestRepo):Promise<Tree> {
    return pinIndexTree(repo.dir, new AbortController().signal,
        { env:repo.env })
}

export function headTree (repo:TestRepo):Tree {
    return pinnedWorktree(repo.git('rev-parse', 'HEAD^{tree}').trim())
}

// The three trees over the same content: commit everything first.
export async function allTrees (repo:TestRepo):Promise<[string, Tree][]> {
    return [['live', LIVE_TREE], ['staged', await stagedTree(repo)],
        ['worktree', headTree(repo)]]
}

export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'],
    { encoding:'utf8' }).trim()

// A fake `git` first on PATH. `body` is shell run before anything else;
// it may `exec` something; otherwise the real git runs. `$PIDFILE` and
// `$REAL_GIT` are available to it.
export function fakeGit (repo:TestRepo, body:string) {
    const dir = tempDir('roast-ctx-fakegit-')
    const pidFile = path.join(dir, 'pid')
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\n' +
        `PIDFILE="${pidFile}"\nREAL_GIT="${REAL_GIT}"\n` +
        body + '\n' +
        'exec "$REAL_GIT" "$@"\n', { mode:0o755 })
    return {
        env:{ ...repo.env, PATH:`${dir}:${repo.env.PATH}` },
        pidFile,
        dir,
        cleanup () { fs.rmSync(dir, { recursive:true, force:true }) },
    }
}

// Shell for fakeGit: when any argument equals `trigger`, record the pid
// and exec `action`.
export function onArg (trigger:string, action:string):string {
    return 'for a in "$@"; do\n' +
        `  if [ "$a" = "${trigger}" ]; then\n` +
        '    echo $$ > "$PIDFILE"\n' +
        `    exec ${action}\n` +
        '  fi\n' +
        'done'
}

export function alive (pid:number):boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export async function waitForPid (file:string):Promise<number> {
    for (let i = 0; i < 500; i++) {
        if (fs.existsSync(file)) {
            const pid = Number(fs.readFileSync(file, 'utf8').trim())
            if (pid > 0) return pid
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${file}`)
}

export async function waitDead (pid:number):Promise<boolean> {
    for (let i = 0; i < 300 && alive(pid); i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    return !alive(pid)
}

export function content (r:Result):string {
    return typeof r.content === 'string' ? r.content : ''
}
