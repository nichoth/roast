// The hook execution harness (spec 12, 5): a shell stub standing in for
// the project roast, seeded repositories, and real path-scoped commits.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { CleanupTest } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import {
    gateRepo,
    git,
    scratch,
    writeHook,
    type GateRepo,
} from './helpers.js'

// Ported verbatim from internal/gate/hook_exec_test.go.
export const STUB_SCRIPT = `#!/bin/sh
if [ "$1 $2" = "gate settings" ]; then
  if [ -n "\${STUB_SETTINGS_STDERR:-}" ]; then
    printf '%s\\n' "$STUB_SETTINGS_STDERR" >&2
  fi
  printf 'timeout_seconds=%s\\nseverity=%s\\n' \\
    "\${STUB_TIMEOUT:-180}" "\${STUB_SEVERITY:-HIGH}"
  exit "\${STUB_SETTINGS_EXIT:-0}"
fi
{
  echo "ARGS: $*"
  echo "NAMES: $(git -C "$(pwd)" diff --cached --name-only HEAD | tr '\\n' ' ')"
  echo "DIFF-START"
  git -C "$(pwd)" diff --cached HEAD
  echo "DIFF-END"
} >> "$STUB_LOG"
if [ -n "\${STUB_SLEEP:-}" ]; then sleep "$STUB_SLEEP"; fi
if [ -n "\${STUB_STDOUT:-}" ]; then printf '%s\\n' "$STUB_STDOUT"; fi
if [ -n "\${STUB_STDERR:-}" ]; then printf '%s\\n' "$STUB_STDERR" >&2; fi
exit "\${STUB_EXIT:-0}"
`

export const CLEAN = '{"findings":[]}'
export const BLOCKING = '{"findings":[{"severity":"HIGH"}]}'

export interface Stub {
    log:string;
    // The stub's observations, '' when no review ran.
    ran ():string;
}

export function projectRoast (repo:string):string {
    return path.join(repo, 'node_modules', '.bin', 'roast')
}

// Installs the stub as the project roast in each repo, one shared log.
export function newStub (t:CleanupTest, ...repos:string[]):Stub {
    const log = path.join(scratch(t), 'scope.log')
    for (const r of repos) writeHook(projectRoast(r), STUB_SCRIPT, 0o755)
    return {
        log,
        ran:() => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    }
}

// A repo with a.txt and b.txt committed, both modified, a.txt staged,
// and the gate consented to. The hook is not installed yet.
export function seededRepo (t:CleanupTest):GateRepo {
    const r = gateRepo(t)
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'a-committed\n')
    fs.writeFileSync(path.join(r.dir, 'b.txt'), 'b-committed\n')
    // Keep the stub and config out of the commits.
    fs.writeFileSync(path.join(r.dir, '.git', 'info', 'exclude'),
        'node_modules/\n.roast.json\n')
    git(r.dir, r.env, 'add', '-A')
    git(r.dir, r.env, 'commit', '-qm', 'seed')
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'a-STAGED-NOT-COMMITTED\n')
    fs.writeFileSync(path.join(r.dir, 'b.txt'), 'b-IN-THIS-COMMIT\n')
    git(r.dir, r.env, 'add', 'a.txt')
    git(r.dir, r.env, 'config', '--local', 'roast.gate', 'enabled')
    return r
}

export async function enable (t:CleanupTest, r:GateRepo):Promise<void> {
    const res = await runRoast(['gate', 'enable'], { cwd:r.dir, env:r.env })
    t.equal(res.code, 0, `gate enable exits 0 ${res.stderr}`)
}

// A real path-scoped commit of b.txt.
export function commit (
    r:GateRepo,
    s:Stub,
    extra:Record<string, string> = {}
):{ ok:boolean, out:string } {
    const res = spawnSync('git',
        ['-C', r.dir, 'commit', 'b.txt', '-m', 'scoped'], {
            env:{ ...r.env, STUB_LOG:s.log, ...extra },
            encoding:'utf8',
        })
    return { ok:res.status === 0, out:res.stdout + res.stderr }
}

export function logLine (seen:string, prefix:string):string {
    const line = seen.split('\n').find(l => l.startsWith(prefix))
    return line === undefined ? '' : line.slice(prefix.length).trim()
}
