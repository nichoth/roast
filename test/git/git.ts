import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { git, gitOk, gitRoot, GitError } from '../../src/git/git.js'

function tempDir (name:string):string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)))
}

function tempRepo ():string {
    const dir = tempDir('roast-git-')
    execFileSync('git', ['init', '-q', dir])
    return dir
}

// An env with only what git needs, so ambient config cannot leak in.
function baseEnv (extra:Record<string, string> = {}):NodeJS.ProcessEnv {
    return {
        PATH:process.env.PATH ?? '/usr/bin:/bin',
        HOME:process.env.HOME ?? '/',
        ...extra,
    }
}

function alive (pid:number):boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

test('gitRoot from a subdirectory returns the toplevel', async t => {
    const repo = tempRepo()
    const sub = path.join(repo, 'a', 'b')
    fs.mkdirSync(sub, { recursive:true })
    const root = await gitRoot(sub, { env:baseEnv() })
    t.equal(fs.realpathSync(root), fs.realpathSync(repo), 'toplevel')
    fs.rmSync(repo, { recursive:true, force:true })
})

test('gitRoot outside a repository fails', async t => {
    const dir = tempDir('roast-norepo-')
    const env = baseEnv({ GIT_CEILING_DIRECTORIES:path.dirname(dir) })
    let err:unknown
    try {
        await gitRoot(dir, { env })
    } catch (e) {
        err = e
    }
    t.ok(err instanceof Error, 'rejects')
    t.equal((err as Error)?.message, 'not inside a git repository',
        'not-in-a-repository error')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('a failing git call rejects with a GitError', async t => {
    const repo = tempRepo()
    let err:unknown
    try {
        await git(repo, ['rev-parse', '--verify', 'no-such-ref'],
            { env:baseEnv() })
    } catch (e) {
        err = e
    }
    t.ok(err instanceof GitError, 'GitError')
    const gerr = err as GitError
    t.equal(gerr.exitCode, 128, 'exit code')
    t.ok(gerr.stderr.length > 0, 'stderr captured')
    t.equal(gerr.message, `exit status 128: ${gerr.stderr.trim()}`,
        'message is exit status and trimmed stderr')
    fs.rmSync(repo, { recursive:true, force:true })
})

test('git returns stdout as a Buffer and passes input to stdin', async t => {
    const repo = tempRepo()
    const out = await git(repo, ['hash-object', '--stdin'],
        { env:baseEnv(), input:'hello\n' })
    t.ok(Buffer.isBuffer(out), 'Buffer output')
    t.equal(out.toString().trim(),
        'ce013625030ba8dba906f756967f9e9ca394464a', 'blob hash of input')
    fs.rmSync(repo, { recursive:true, force:true })
})

test('gitOk resolves false on failure and true on success', async t => {
    const repo = tempRepo()
    const env = baseEnv()
    t.equal(await gitOk(repo, ['rev-parse', '--verify', '--quiet',
        'no-such-ref'], { env }), false, 'failing rev-parse --verify')
    t.equal(await gitOk(repo, ['rev-parse', '--git-dir'], { env }), true,
        'succeeding call')
    fs.rmSync(repo, { recursive:true, force:true })
})

test('the runner uses the given env and merges extra variables', async t => {
    const repo = tempRepo()
    const env = baseEnv({
        GIT_CONFIG_COUNT:'1',
        GIT_CONFIG_KEY_0:'roast.injected',
        GIT_CONFIG_VALUE_0:'yes',
    })
    const out = await git(repo, ['config', '--get', 'roast.injected'],
        { env })
    t.equal(out.toString().trim(), 'yes', 'injected env reaches git')

    const extra = await git(repo, ['config', '--get', 'roast.extra'], {
        env:baseEnv(),
        extraEnv:{
            GIT_CONFIG_COUNT:'1',
            GIT_CONFIG_KEY_0:'roast.extra',
            GIT_CONFIG_VALUE_0:'merged',
        },
    })
    t.equal(extra.toString().trim(), 'merged', 'extra env merged over env')

    // A variable only in process.env must not reach git when env is given.
    const saved = { ...process.env }
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'roast.leak'
    process.env.GIT_CONFIG_VALUE_0 = 'leaked'
    try {
        t.equal(await gitOk(repo, ['config', '--get', 'roast.leak'],
            { env:baseEnv() }), false, 'process.env is not read')
    } finally {
        for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0',
            'GIT_CONFIG_VALUE_0']) {
            if (saved[k] === undefined) delete process.env[k]
            else process.env[k] = saved[k]
        }
    }
    fs.rmSync(repo, { recursive:true, force:true })
})

// A fake `git` first on the injected PATH records its pid and then blocks.
// With `ignoreTerm`, it ignores SIGTERM so only SIGKILL stops it.
function fakeGit (ignoreTerm:boolean):{ bin:string, pidFile:string } {
    const bin = tempDir('roast-fakegit-')
    const pidFile = path.join(bin, 'pid')
    const trap = ignoreTerm ? "trap '' TERM\n" : ''
    fs.writeFileSync(path.join(bin, 'git'),
        `#!/bin/sh\n${trap}echo $$ > "${pidFile}"\nexec sleep 30\n`,
        { mode:0o755 })
    return { bin, pidFile }
}

async function waitFor (file:string):Promise<string> {
    for (let i = 0; i < 200; i++) {
        if (fs.existsSync(file)) {
            const text = fs.readFileSync(file, 'utf8').trim()
            if (text) return text
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${file}`)
}

for (const ignoreTerm of [false, true]) {
    const what = ignoreTerm ? ' that ignores SIGTERM' : ''
    test(`aborting a git call${what} rejects and kills the child`, async t => {
        const { bin, pidFile } = fakeGit(ignoreTerm)
        const ac = new AbortController()
        const reason = new Error('cancelled by test')
        const env = baseEnv({ PATH:`${bin}:${process.env.PATH}` })
        const call = git(bin, ['status'], { env, signal:ac.signal })
        const pid = Number(await waitFor(pidFile))
        t.ok(alive(pid), 'child is running')
        ac.abort(reason)
        let err:unknown
        try {
            await call
        } catch (e) {
            err = e
        }
        t.equal(err, reason, 'rejects with the abort reason')
        t.ok(!alive(pid), 'no child process left')
        fs.rmSync(bin, { recursive:true, force:true })
    })
}

test('an already aborted signal rejects without running git', async t => {
    const ac = new AbortController()
    const reason = new Error('early')
    ac.abort(reason)
    let err:unknown
    try {
        await gitOk(os.tmpdir(), ['status'],
            { env:baseEnv(), signal:ac.signal })
    } catch (e) {
        err = e
    }
    t.equal(err, reason, 'rejects with the reason')
})
