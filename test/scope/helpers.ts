// Temporary Git repositories for scope and denylist tests. Each repo gets
// its own HOME, XDG_CONFIG_HOME and global config file, so the user's Git
// config never reaches these tests and a test may write hostile config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface TestRepo {
    dir:string;
    env:NodeJS.ProcessEnv;
    // The isolated global config file (GIT_CONFIG_GLOBAL).
    globalConfig:string;
    // Runs git in the repo and returns stdout.
    git (...args:string[]):string;
    write (rel:string, content:string|Buffer):void;
    commitAll (msg?:string):void;
    cleanup ():void;
}

export function tempDir (prefix:string):string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

export function newRepo (opts:{ commit?:boolean } = {}):TestRepo {
    const home = tempDir('roast-scope-home-')
    const dir = tempDir('roast-scope-repo-')
    const globalConfig = path.join(home, 'gitconfig')
    fs.writeFileSync(globalConfig, '')
    const env:NodeJS.ProcessEnv = {
        PATH:process.env.PATH ?? '/usr/bin:/bin',
        HOME:home,
        XDG_CONFIG_HOME:path.join(home, '.config'),
        GIT_CONFIG_GLOBAL:globalConfig,
        GIT_CONFIG_NOSYSTEM:'1',
        GIT_AUTHOR_NAME:'test',
        GIT_AUTHOR_EMAIL:'test@example.com',
        GIT_COMMITTER_NAME:'test',
        GIT_COMMITTER_EMAIL:'test@example.com',
    }
    const repo:TestRepo = {
        dir,
        env,
        globalConfig,
        git (...args) {
            return execFileSync('git', ['-C', dir, ...args], {
                env,
                encoding:'utf8',
                stdio:['ignore', 'pipe', 'pipe'],
                maxBuffer:Infinity,
            })
        },
        write (rel, content) {
            const p = path.join(dir, rel)
            fs.mkdirSync(path.dirname(p), { recursive:true })
            fs.writeFileSync(p, content)
        },
        commitAll (msg = 'commit') {
            repo.git('add', '-A')
            repo.git('commit', '-q', '--allow-empty', '-m', msg)
        },
        cleanup () {
            fs.rmSync(dir, { recursive:true, force:true })
            fs.rmSync(home, { recursive:true, force:true })
        },
    }
    repo.git('init', '-q', '-b', 'main')
    if (opts.commit !== false) {
        repo.write('README.md', 'hello\n')
        repo.commitAll('initial')
    }
    return repo
}

// Lines of text, n of them, each distinct.
export function lines (n:number, prefix = 'line'):string {
    let out = ''
    for (let i = 0; i < n; i++) out += `${prefix} ${i}\n`
    return out
}

// Paths named in `diff --git a/P b/P` headers, in order.
export function sectionPaths (diff:string):string[] {
    const out:string[] = []
    for (const line of diff.split('\n')) {
        const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
        if (m) out.push(m[2])
    }
    return out
}
