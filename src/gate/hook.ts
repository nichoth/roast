// Installing, inspecting, and removing the pre-commit gate (spec 12, 2.4
// to 2.9). Roast never clobbers a hook it did not write: ownership is
// anchored (our header at byte 0, or a complete appended block that holds
// the invocation), and everything else is foreign.
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../fsutil/atomic.js'
import { goTrimSpace, isGoSpace } from '../gocompat/strings.js'
import {
    APPEND_BEGIN,
    APPEND_END,
    CONFIG_KEY_NOTICE,
    HOOK_HEADER,
    HOOK_NAME,
    HOOK_SCRIPT,
    SIDECAR_NAME,
    manualLine,
} from './constants.js'
import { type Decision, readDecision } from './decision.js'
import {
    configGet,
    hooksPathConfigured,
    resolveHookPath,
    type Env,
} from './git-config.js'

export interface GateStatus {
    repo:string;
    decision:Decision;
    hookPath:string;
    sidecarPath:string;
    // core.hooksPath is set: the hooks directory may serve other repos.
    shared:boolean;
    exists:boolean;
    // At most one of ours, appended, foreign is true.
    ours:boolean;
    appended:boolean;
    foreign:boolean;
    appendable:boolean;
    // Owner execute bit; git silently skips a hook without it.
    executable:boolean;
    // Roast's part (own hook or sidecar) differs from HOOK_SCRIPT.
    stale:boolean;
    noticeSent:boolean;
}

export type InstallAction =
    'installed'|'appended'|'refreshed'|'up-to-date'|'manual'
export type RemoveAction = 'removed'|'nothing'|'preserved'

const SCRIPT_BYTES = Buffer.from(HOOK_SCRIPT)
const HEADER_BYTES = Buffer.from(HOOK_HEADER)
const NEWLINE = 0x0a

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function isCode (err:unknown, code:string):boolean {
    return (err as NodeJS.ErrnoException)?.code === code
}

function fail (text:string, err:unknown):Error {
    return new Error(`${text}: ${message(err)}`, { cause:err })
}

function hasHeader (body:Buffer):boolean {
    return body.subarray(0, HEADER_BYTES.length).equals(HEADER_BYTES)
}

// Splits on '\n' like Go strings.Split, keeping the raw bytes.
function splitLines (body:Buffer):Buffer[] {
    const lines:Buffer[] = []
    let start = 0
    for (let i = 0; i < body.length; i++) {
        if (body[i] === NEWLINE) {
            lines.push(body.subarray(start, i))
            start = i + 1
        }
    }
    lines.push(body.subarray(start))
    return lines
}

function trimmed (line:Buffer):string {
    return goTrimSpace(line.toString('utf8'))
}

async function readFile (file:string):Promise<Buffer> {
    try {
        return await fs.readFile(file)
    } catch (err) {
        throw fail(`read ${file}`, err)
    }
}

// The file's permission bits, or 0o755 when stat fails.
async function permOr755 (file:string):Promise<number> {
    try {
        return (await fs.stat(file)).mode & 0o777
    } catch {
        return 0o755
    }
}

const SHELLS = new Set(['sh', 'bash', 'dash', 'ksh', 'zsh'])

// Go strings.Fields: split on runs of Unicode white space.
function fields (s:string):string[] {
    const out:string[] = []
    let cur = ''
    for (const ch of s) {
        if (isGoSpace(ch.codePointAt(0) ?? 0)) {
            if (cur) out.push(cur)
            cur = ''
        } else {
            cur += ch
        }
    }
    if (cur) out.push(cur)
    return out
}

const utf8 = new TextDecoder('utf-8', { fatal:true })

// Whether a foreign hook is a plain shell script Roast can safely add its
// block to. Conservative: a false negative costs one printed line, a false
// positive corrupts someone else's hook.
export function appendable (body:Uint8Array):boolean {
    if (body.length === 0) return false
    let text:string
    try {
        text = utf8.decode(body)
    } catch {
        return false
    }
    let line = text.split('\n', 1)[0]
    if (line.endsWith('\r')) line = line.slice(0, -1)
    line = goTrimSpace(line)
    if (!line.startsWith('#!')) return false
    const f = fields(line.slice(2))
    if (f.length === 0) return false
    let interp = path.posix.basename(f[0])
    if (interp === 'env') {
        if (f.length < 2) return false
        if (f[1].startsWith('-') || f[1].includes('=')) return false
        interp = path.posix.basename(f[1])
    }
    return SHELLS.has(interp)
}

// The inclusive line range of a complete block that holds the invocation,
// or undefined. Markers alone are public comment text, not authorship.
function appendedBlock (lines:Buffer[]):[number, number]|undefined {
    const invocation = manualLine()
    let start = -1
    let hasInvocation = false
    for (let i = 0; i < lines.length; i++) {
        const line = trimmed(lines[i])
        if (line === APPEND_BEGIN) {
            start = i
            hasInvocation = false
        } else if (line === APPEND_END && start >= 0) {
            if (hasInvocation) return [start, i]
            start = -1
        } else if (start >= 0 && line === invocation) {
            hasInvocation = true
        }
    }
    return undefined
}

async function sidecarCurrent (file:string):Promise<boolean> {
    try {
        const info = await fs.stat(file)
        if ((info.mode & 0o100) === 0) return false
        return (await fs.readFile(file)).equals(SCRIPT_BYTES)
    } catch {
        return false
    }
}

// Reports the gate state of a repo (a working-tree root). Never mutates.
export async function inspect (repo:string, env:Env):Promise<GateStatus> {
    const hookPath = await resolveHookPath(repo, HOOK_NAME, env)
    const sidecarPath = await resolveHookPath(repo, SIDECAR_NAME, env)
    const st:GateStatus = {
        repo,
        decision:await readDecision(repo, env),
        hookPath,
        sidecarPath,
        shared:await hooksPathConfigured(repo, env),
        exists:false,
        ours:false,
        appended:false,
        foreign:false,
        appendable:false,
        executable:false,
        stale:false,
        noticeSent:(await configGet(repo, CONFIG_KEY_NOTICE, env)) !== '',
    }
    let info
    try {
        info = await fs.lstat(hookPath)
    } catch (err) {
        if (isCode(err, 'ENOENT')) return st
        throw fail(`stat ${hookPath}`, err)
    }
    st.exists = true
    st.executable = (info.mode & 0o100) !== 0
    // A symlinked hook belongs to whatever put it there.
    if (info.isSymbolicLink()) {
        st.foreign = true
        return st
    }
    const body = await readFile(hookPath)
    if (hasHeader(body)) {
        st.ours = true
        st.stale = !body.equals(SCRIPT_BYTES) || !st.executable
    } else if (appendedBlock(splitLines(body))) {
        st.appended = true
        // The foreign file's own mode is not Roast's to repair, so it
        // feeds isActive, never stale.
        st.stale = !(await sidecarCurrent(sidecarPath))
    } else {
        st.foreign = true
        st.appendable = appendable(body)
    }
    return st
}

// Consent plus an executable dispatcher.
export function isActive (s:GateStatus):boolean {
    return s.decision === 'enabled' && (s.ours || s.appended) &&
        s.executable
}

// The one-line state `gate status` prints.
export function summary (s:GateStatus):string {
    const p = s.hookPath
    const mine = s.ours || s.appended
    if (mine && !s.executable) {
        return `INSTALLED BUT NOT RUNNING \u2014 ${p} is not executable, ` +
            'so git skips it (chmod +x it, or `roast gate enable` for ' +
            "roast's own hook)"
    }
    if (mine && s.stale) {
        return 'installed dispatcher is stale \u2014 run `roast gate ' +
            `enable\` to refresh: ${p}`
    }
    if (mine && s.decision === 'declined') {
        return `declined for this repo; dispatcher retained: ${p}`
    }
    if (mine && s.decision !== 'enabled') {
        return 'dispatcher installed but not enrolled in this repo ' +
            `(\`roast gate enable\` enables it): ${p}`
    }
    if (s.ours) return `installed: ${p}`
    if (s.appended) {
        return `installed via an appended block in a foreign hook: ${p}`
    }
    if (s.foreign && s.decision === 'declined') {
        return 'declined; a foreign pre-commit hook is present ' +
            `(untouched): ${p}`
    }
    if (s.foreign && s.appendable) {
        return 'not installed \u2014 a foreign pre-commit hook is present ' +
            `(untouched); \`roast gate enable\` appends to it: ${p}`
    }
    if (s.foreign) {
        return 'not installed \u2014 a foreign pre-commit hook is present ' +
            `and is not an appendable shell script (untouched): ${p}`
    }
    if (s.decision === 'declined') {
        return 'declined for this repo (`roast gate enable` turns it on)'
    }
    if (s.decision === 'enabled') {
        return 'enabled for this repo but the hook is missing \u2014 run ' +
            '`roast gate enable` to reinstall'
    }
    return 'not enrolled (`roast gate enable` installs it)'
}

// Writes an executable script, creating its directory.
async function writeScript (file:string, body:Uint8Array):Promise<void> {
    const dir = path.dirname(file)
    try {
        await fs.mkdir(dir, { recursive:true, mode:0o755 })
    } catch (err) {
        throw fail(`mkdir ${dir}`, err)
    }
    await writeFileAtomic(file, body, { mode:0o755 })
}

// Writes the sidecar only when the path is absent or already Roast's:
// a file by that name may belong to the repo.
async function writeSidecar (file:string):Promise<void> {
    let info
    try {
        info = await fs.lstat(file)
    } catch (err) {
        if (!isCode(err, 'ENOENT')) throw fail(`stat ${file}`, err)
    }
    if (info?.isSymbolicLink()) {
        throw new Error(`${file} is a symlink roast did not create; move ` +
            'it aside and re-run `roast gate enable`')
    }
    if (info && !hasHeader(await readFile(file))) {
        throw new Error(`${file} already exists and was not written by ` +
            'roast; move it aside and re-run `roast gate enable`')
    }
    await writeScript(file, SCRIPT_BYTES)
}

// Deletes the sidecar only when its header proves Roast wrote it.
async function removeOwnedSidecar (file:string):Promise<void> {
    let info
    try {
        info = await fs.lstat(file)
    } catch (err) {
        if (isCode(err, 'ENOENT')) return
        throw fail(`stat ${file}`, err)
    }
    if (info.isSymbolicLink()) return
    if (!hasHeader(await readFile(file))) return
    try {
        await fs.rm(file)
    } catch (err) {
        if (!isCode(err, 'ENOENT')) throw fail(`remove ${file}`, err)
    }
}

// Refreshes an existing Roast-owned regular sidecar; never creates one.
export async function refreshOwnedSidecar (file:string):Promise<void> {
    let info
    try {
        info = await fs.lstat(file)
    } catch (err) {
        if (isCode(err, 'ENOENT')) return
        throw fail(`stat ${file}`, err)
    }
    if (!info.isFile()) return
    const body = await readFile(file)
    if (hasHeader(body) && !body.equals(SCRIPT_BYTES)) {
        await writeSidecar(file)
    }
}

// Inserts the block right after the shebang (a tail block would never run
// in a hook ending in `exit 0`), keeping the hook's mode exactly, so a
// hook its owner chmod -x'd stays disabled.
async function appendBlock (file:string):Promise<void> {
    let body = await readFile(file)
    const mode = await permOr755(file)
    let nl = body.indexOf(NEWLINE)
    if (nl < 0) {
        // A one-line hook without a trailing newline.
        body = Buffer.concat([body, Buffer.from('\n')])
        nl = body.length - 1
    }
    const block = '\n' + APPEND_BEGIN + '\n' +
        '# Added by `roast gate enable`. Delete this block (or run\n' +
        '# `roast gate disable`) to remove the gate; the rest of this ' +
        'file is yours.\n' +
        manualLine() + '\n' +
        APPEND_END + '\n'
    await writeFileAtomic(file, Buffer.concat([
        body.subarray(0, nl + 1),
        Buffer.from(block),
        body.subarray(nl + 1),
    ]), { mode })
}

// Removes the block and the blank line before it; every other byte stays.
async function stripBlock (file:string):Promise<void> {
    const body = await readFile(file)
    const mode = await permOr755(file)
    const lines = splitLines(body)
    const range = appendedBlock(lines)
    if (!range) {
        throw new Error(`remove gate from ${file}: the roast block has no ` +
            'closing marker; left the file untouched (delete the block ' +
            'by hand)')
    }
    let [start] = range
    const end = range[1]
    if (start > 0 && trimmed(lines[start - 1]) === '') start--
    const kept = [...lines.slice(0, start), ...lines.slice(end + 1)]
    const parts:Buffer[] = []
    kept.forEach((line, i) => {
        if (i > 0) parts.push(Buffer.from('\n'))
        parts.push(line)
    })
    await writeFileAtomic(file, Buffer.concat(parts), { mode })
}

// Puts the gate in place without clobbering a hook Roast did not write.
// Records no decision; callers own that. Returns the pre-install status.
export async function install (
    repo:string,
    env:Env
):Promise<{ action:InstallAction, status:GateStatus }> {
    const status = await inspect(repo, env)
    if (status.foreign && !status.appendable) {
        // The sidecar makes the printed manual line work as-is.
        await writeSidecar(status.sidecarPath)
        return { action:'manual', status }
    }
    if (status.foreign) {
        await writeSidecar(status.sidecarPath)
        await appendBlock(status.hookPath)
        return { action:'appended', status }
    }
    if (status.appended) {
        if (!status.stale) return { action:'up-to-date', status }
        await writeSidecar(status.sidecarPath)
        return { action:'refreshed', status }
    }
    if (status.ours) {
        if (!status.stale) return { action:'up-to-date', status }
        await writeScript(status.hookPath, SCRIPT_BYTES)
        return { action:'refreshed', status }
    }
    await writeScript(status.hookPath, SCRIPT_BYTES)
    return { action:'installed', status }
}

// Deletes Roast's own hook or strips its block. A shared (core.hooksPath)
// dispatcher is preserved for other repos, only refreshed when stale.
export async function remove (
    repo:string,
    env:Env
):Promise<{ action:RemoveAction, status:GateStatus }> {
    const status = await inspect(repo, env)
    if (status.shared) {
        // Older dispatchers lack the consent check.
        if ((status.ours || status.appended) && status.stale) {
            await install(repo, env)
        }
        await refreshOwnedSidecar(status.sidecarPath)
        return { action:'preserved', status }
    }
    let action:RemoveAction = 'nothing'
    if (status.ours) {
        try {
            await fs.rm(status.hookPath)
        } catch (err) {
            if (!isCode(err, 'ENOENT')) {
                throw fail(`remove ${status.hookPath}`, err)
            }
        }
        action = 'removed'
    } else if (status.appended) {
        await stripBlock(status.hookPath)
        action = 'removed'
    }
    // A leftover sidecar goes too, but only one Roast provably wrote.
    await removeOwnedSidecar(status.sidecarPath)
    return { action, status }
}
