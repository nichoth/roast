// Temporary directories and Git repositories for CLI tests, with an
// environment that isolates the user's home and config directories and
// gives Git an identity (CI runners have none).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanEnv } from './env.js'

export interface TempDir {
    dir:string;
    env:Record<string, string>;
    remove ():void;
}

function makeTemp (prefix:string):string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

// The base test environment: the process env without provider or roast
// variables, with HOME, XDG_CONFIG_HOME, and CLAUDE_CONFIG_DIR inside
// `root`, a Git identity, and no Git discovery above `root`.
export function isolatedEnv (root:string):Record<string, string> {
    const home = path.join(root, '.home')
    fs.mkdirSync(home, { recursive:true })
    return {
        ...cleanEnv(process.env),
        HOME:home,
        XDG_CONFIG_HOME:path.join(home, '.config'),
        CLAUDE_CONFIG_DIR:path.join(home, '.claude'),
        GIT_AUTHOR_NAME:'Roast Test',
        GIT_AUTHOR_EMAIL:'roast-test@example.com',
        GIT_COMMITTER_NAME:'Roast Test',
        GIT_COMMITTER_EMAIL:'roast-test@example.com',
        GIT_CEILING_DIRECTORIES:path.dirname(root),
        GIT_CONFIG_NOSYSTEM:'1',
    }
}

// A temporary directory that is not inside any Git repository. The test
// working directory is `dir/work`.
export function tempDir (prefix = 'roast-dir-'):TempDir {
    const root = makeTemp(prefix)
    const dir = path.join(root, 'work')
    fs.mkdirSync(dir)
    return {
        dir,
        env:isolatedEnv(root),
        remove:() => fs.rmSync(root, { recursive:true, force:true }),
    }
}

// A temporary Git repository at `dir` (realpath, so it compares equal to
// what Git prints).
export function tempRepo (prefix = 'roast-repo-'):TempDir {
    const t = tempDir(prefix)
    execFileSync('git', ['init', '-q', t.dir], { env:t.env })
    return t
}
