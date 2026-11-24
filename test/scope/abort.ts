import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { build, gitPatch } from '../../src/scope/index.js'
import { newRepo, tempDir, type TestRepo } from './helpers.js'

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'],
    { encoding:'utf8' }).trim()

// A `git` first on PATH that runs `action` (recording its pid first)
// when any argument equals `trigger`, and the real git otherwise.
function wrapGit (
    repo:TestRepo,
    trigger:string,
    action:string
):{ env:NodeJS.ProcessEnv, pidFile:string, dir:string } {
    const dir = tempDir('roast-wrapgit-')
    const pidFile = path.join(dir, 'pid')
    fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\n' +
        'for a in "$@"; do\n' +
        `  if [ "$a" = "${trigger}" ]; then\n` +
        `    echo $$ > "${pidFile}"\n` +
        `    exec ${action}\n` +
        '  fi\n' +
        'done\n' +
        `exec "${REAL_GIT}" "$@"\n`, { mode:0o755 })
    const env = { ...repo.env, PATH:`${dir}:${repo.env.PATH}` }
    return { env, pidFile, dir }
}

function alive (pid:number):boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

async function waitFor (file:string):Promise<number> {
    for (let i = 0; i < 500; i++) {
        if (fs.existsSync(file)) {
            const pid = Number(fs.readFileSync(file, 'utf8').trim())
            if (pid > 0) return pid
        }
        await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`timed out waiting for ${file}`)
}

async function rejection (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

test('aborting a large gitPatch kills git and rejects with AbortError',
    async t => {
        const repo = newRepo()
        // An endless patch stream.
        const w = wrapGit(repo, 'diff', 'yes "+aaaaaaaaaaaaaaaaaaaaaaaa"')
        const ac = new AbortController()
        const p = gitPatch(repo.dir, ['diff'], 1024, {
            signal:ac.signal,
            env:w.env,
        })
        const pid = await waitFor(w.pidFile)
        await new Promise(resolve => setTimeout(resolve, 50))
        ac.abort()
        const err = await rejection(p)
        t.ok(err instanceof Error && err.name === 'AbortError',
            'rejects with an AbortError')
        t.ok(!alive(pid), 'git was killed')
        repo.cleanup()
        fs.rmSync(w.dir, { recursive:true, force:true })
    })

// Each best-effort step swallows git failures, but never an abort.
const STEPS:[string, string][] = [
    ['linguist check-attr', 'check-attr'],
    ['rename compaction', '--name-status'],
]

for (const [label, trigger] of STEPS) {
    test(`aborting build during ${label} rejects with AbortError`,
        async t => {
            const repo = newRepo()
            repo.write('a/f.go', 'package f\n'.repeat(30))
            repo.write('.gitattributes', '*.json linguist-generated\n')
            repo.commitAll()
            fs.mkdirSync(path.join(repo.dir, 'b'))
            repo.git('mv', 'a/f.go', 'b/f.go')
            const w = wrapGit(repo, trigger, 'sleep 30')
            const ac = new AbortController()
            const p = build(repo.dir, { stagedOnly:true, env:w.env },
                ac.signal)
            const pid = await waitFor(w.pidFile)
            ac.abort()
            const err = await rejection(p)
            t.ok(err instanceof Error && err.name === 'AbortError',
                'rejects with an AbortError')
            t.ok(!alive(pid), 'git was killed')
            repo.cleanup()
            fs.rmSync(w.dir, { recursive:true, force:true })
        })
}

test('an already aborted signal rejects build', async t => {
    const repo = newRepo()
    const ac = new AbortController()
    ac.abort()
    const err = await rejection(build(repo.dir, { env:repo.env },
        ac.signal))
    t.ok(err instanceof Error && err.name === 'AbortError', 'AbortError')
    repo.cleanup()
})
