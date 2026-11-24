// Gate test repositories (spec 12, 5): every git child runs with the
// global and system config cut out, and new repos disable background
// maintenance so a detached `git gc` cannot race temp-dir removal.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tempRepo, tempDir, type TempDir } from '../helpers/repo.js'
import type { CleanupTest } from '../helpers/test.js'

export const ISOLATED_GIT = {
    GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_CONFIG_SYSTEM:'/dev/null',
    GIT_CONFIG_NOSYSTEM:'1',
}

export interface GateRepo extends TempDir {
    hooks:string;
    hook:string;
    sidecar:string;
}

// Runs git in `repo` with `env`, returning trimmed stdout.
export function git (
    repo:string,
    env:Record<string, string>,
    ...args:string[]
):string {
    return execFileSync('git', ['-C', repo, ...args], {
        env,
        encoding:'utf8',
        stdio:['ignore', 'pipe', 'pipe'],
    }).trim()
}

// A local config value, '' when unset.
export function localConfig (r:GateRepo, key:string):string {
    try {
        return git(r.dir, r.env, 'config', '--local', '--get', key)
    } catch {
        return ''
    }
}

export function gateRepo (t:CleanupTest, toplevelConfig = true):GateRepo {
    const base = tempRepo('roast-gate-')
    t.cleanup(base.remove)
    const env = { ...base.env, ...ISOLATED_GIT }
    for (const [k, v] of [
        ['maintenance.auto', 'false'],
        ['gc.auto', '0'],
        ['user.email', 'roast-test@example.com'],
        ['user.name', 'roast test'],
        ['commit.gpgsign', 'false'],
    ]) {
        git(base.dir, env, 'config', k, v)
    }
    if (toplevelConfig) {
        fs.writeFileSync(path.join(base.dir, '.roast.json'), '{"version": 1}')
    }
    const hooks = path.join(base.dir, '.git', 'hooks')
    return {
        ...base,
        env,
        hooks,
        hook:path.join(hooks, 'pre-commit'),
        sidecar:path.join(hooks, 'roast-pre-commit'),
    }
}

// A scratch directory outside any repository.
export function scratch (t:CleanupTest):string {
    const d = tempDir('roast-gate-scratch-')
    t.cleanup(d.remove)
    return d.dir
}

export function writeHook (file:string, body:string, mode = 0o755):void {
    fs.mkdirSync(path.dirname(file), { recursive:true })
    fs.writeFileSync(file, body)
    fs.chmodSync(file, mode)
}

export function read (file:string):string {
    return fs.readFileSync(file, 'utf8')
}

export function modeOf (file:string):number {
    return fs.statSync(file).mode & 0o777
}
