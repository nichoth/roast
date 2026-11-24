// Installs and inspects Roast's bundled agent skill (Go internal/skill).
import { constants } from 'node:fs'
import {
    access,
    lstat,
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { SKILL_FILES } from './assets.js'

export type SkillState = 'not_installed'|'symlink'|'up_to_date'|'stale'

export interface SkillStatus {
    state:SkillState;
    path:string;
    stale:string[];
}

export type Harness = 'custom'|'agents'|'claude'|'polytoken'

// One harness-visible parent directory for the skill.
export interface InstallationTarget {
    harness:Harness;
    parent:string;
    path:string;
}

export interface SkillEnv {
    // HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, and PATH are read.
    env:Readonly<Record<string, string|undefined>>;
}

type LookPath = (
    name:string,
    env:Readonly<Record<string, string|undefined>>
) => Promise<boolean>

async function isExecutableFile (file:string):Promise<boolean> {
    try {
        if (!(await stat(file)).isFile()) return false
        await access(file, constants.X_OK)
        return true
    } catch {
        return false
    }
}

// Go exec.LookPath: an executable regular file named `name` in a PATH
// entry. Relative entries do not count (Go reports them as ErrDot).
async function defaultLookPath (
    name:string,
    env:Readonly<Record<string, string|undefined>>
):Promise<boolean> {
    if (name.includes('/')) return isExecutableFile(name)
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
        if (!path.isAbsolute(dir)) continue
        if (await isExecutableFile(path.join(dir, name))) return true
    }
    return false
}

// Swappable for tests, like terminalHooks.
export const skillHooks:{ lookPath:LookPath } = {
    lookPath:defaultLookPath,
}

export function lookPath (
    name:string,
    env:Readonly<Record<string, string|undefined>>
):Promise<boolean> {
    return skillHooks.lookPath(name, env)
}

async function directoryExists (dir:string):Promise<boolean> {
    try {
        return (await stat(dir)).isDirectory()
    } catch {
        return false
    }
}

// Go filepath.Clean for the paths used here: normalized, no trailing
// slash except the root.
function clean (p:string):string {
    const n = path.normalize(p)
    return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
}

function configuredRoot (
    home:string,
    override:string|undefined,
    fallback:string
):string {
    if (!override) return path.join(home, fallback)
    if (override === '~') return home
    if (override.startsWith('~/')) return path.join(home, override.slice(2))
    return clean(override)
}

function finalizeTargets (
    parents:{ harness:Harness, parent:string }[]
):InstallationTarget[] {
    const seen = new Set<string>()
    const out:InstallationTarget[] = []
    for (const t of parents) {
        const parent = clean(t.parent)
        const p = path.join(parent, 'roast')
        if (seen.has(p)) continue
        seen.add(p)
        out.push({ harness:t.harness, parent, path:p })
    }
    return out
}

// The explicit `parent` (--dir) target when set; otherwise the project's
// agent skill directories below `projectRoot`, or the user-level
// directories of detected harnesses when `projectRoot` is empty.
export async function installationTargets (
    parent:string,
    projectRoot:string,
    opts:SkillEnv
):Promise<InstallationTarget[]> {
    if (parent) {
        return [{
            harness:'custom',
            parent,
            path:path.join(parent, 'roast'),
        }]
    }
    const env = opts.env
    const home = env.HOME
    if (!home) {
        throw new Error('resolve user home: $HOME is not defined')
    }
    const claudeRoot = configuredRoot(home, env.CLAUDE_CONFIG_DIR, '.claude')
    const claudePresent = !!env.CLAUDE_CONFIG_DIR ||
        (await directoryExists(claudeRoot)) ||
        (await lookPath('claude', env))
    if (projectRoot) {
        const parents:{ harness:Harness, parent:string }[] = [{
            harness:'agents',
            parent:path.join(projectRoot, '.agents', 'skills'),
        }]
        if (claudePresent ||
            await directoryExists(path.join(projectRoot, '.claude'))) {
            parents.push({
                harness:'claude',
                parent:path.join(projectRoot, '.claude', 'skills'),
            })
        }
        return finalizeTargets(parents)
    }
    const configRoot = configuredRoot(home, env.XDG_CONFIG_HOME, '.config')
    const polytokenRoot = path.join(configRoot, 'polytoken')
    const polytokenPresent = (await directoryExists(polytokenRoot)) ||
        (await lookPath('polytoken', env))
    const parents:{ harness:Harness, parent:string }[] = [{
        harness:'agents',
        parent:path.join(home, '.agents', 'skills'),
    }]
    if (claudePresent) {
        parents.push({
            harness:'claude',
            parent:path.join(claudeRoot, 'skills'),
        })
    }
    if (polytokenPresent) {
        parents.push({
            harness:'polytoken',
            parent:path.join(polytokenRoot, 'skills'),
        })
    }
    return finalizeTargets(parents)
}

function errorCode (err:unknown):string|undefined {
    return (err as NodeJS.ErrnoException|null)?.code
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function sameBytes (a:Uint8Array, b:Uint8Array):boolean {
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)
}

// Bundled file paths in byte order (Go sort.Strings).
function bundledPaths ():string[] {
    return [...SKILL_FILES.keys()].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)))
}

// Reports whether `target` holds the bundled skill. A symlinked target is
// a development checkout and is not compared.
export async function inspect (target:string):Promise<SkillStatus> {
    const status:SkillStatus = { state:'not_installed', path:target, stale:[] }
    let info
    try {
        info = await lstat(target)
    } catch (err) {
        if (errorCode(err) === 'ENOENT') return status
        throw new Error(`stat skill directory ${target}: ${message(err)}`,
            { cause:err })
    }
    if (info.isSymbolicLink()) {
        status.state = 'symlink'
        return status
    }
    if (!info.isDirectory()) {
        throw new Error(`skill path ${target} is not a directory`)
    }
    for (const rel of bundledPaths()) {
        const want = SKILL_FILES.get(rel) as Uint8Array
        let got:Buffer|undefined
        try {
            got = await readFile(path.join(target, rel))
        } catch {
            got = undefined
        }
        if (!got || !sameBytes(want, got)) status.stale.push(rel)
    }
    status.state = status.stale.length > 0 ? 'stale' : 'up_to_date'
    return status
}

// Writes the bundled skill into `target`. Differing files are kept unless
// `force`; a symlinked target is never modified, and a bundled path that
// is a symlink inside the target is refused.
export async function install (
    target:string,
    force:boolean
):Promise<SkillStatus> {
    const status = await inspect(target)
    if (status.state === 'symlink' || status.state === 'up_to_date') {
        return status
    }
    if (status.state === 'stale' && !force) {
        throw new Error('skill files differ; re-run with --force to overwrite')
    }
    try {
        await mkdir(target, { recursive:true, mode:0o755 })
    } catch (err) {
        throw new Error(`create skill directory ${target}: ${message(err)}`,
            { cause:err })
    }
    for (const rel of bundledPaths()) {
        const destination = path.join(target, rel)
        let isLink = false
        try {
            isLink = (await lstat(destination)).isSymbolicLink()
        } catch (err) {
            if (errorCode(err) !== 'ENOENT') {
                throw new Error(`stat ${destination}: ${message(err)}`,
                    { cause:err })
            }
        }
        if (isLink) {
            throw new Error(`refusing to overwrite symlink ${destination}`)
        }
        try {
            await mkdir(path.dirname(destination),
                { recursive:true, mode:0o755 })
        } catch (err) {
            throw new Error(`create skill directory: ${message(err)}`,
                { cause:err })
        }
        try {
            await writeFile(destination, SKILL_FILES.get(rel) as Uint8Array,
                { mode:0o644 })
        } catch (err) {
            throw new Error(
                `write skill file ${destination}: ${message(err)}`,
                { cause:err })
        }
    }
    return inspect(target)
}
