// Keys saved by login live in .env.roast at the worktree root or in
// credentials.json under the user config directory (ADR-0002).
import fs from 'node:fs'
import { lstat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { StoredCredentials } from '../config/credential.js'
import { lookupProvider } from '../config/provider.js'
import { writeFileAtomic } from '../fsutil/atomic.js'
import { compareBytes, goTrimSpace } from '../gocompat/strings.js'
import { git, gitRoot, type GitRunOpts } from '../git/git.js'
import { stateDir } from '../trust/trust.js'
import {
    decodeDotenv, encodeDotenv,
    PROJECT_CREDENTIALS_FILE, PROJECT_CREDENTIALS_TEMP_PREFIX,
} from './dotenv.js'
import {
    assertProjectCredentialUntracked, protectProjectCredential,
} from './project-ignore.js'

export const CREDENTIALS_FILE = 'credentials.json'
const CURRENT_VERSION = 1

export type CredentialScope = 'project'|'user'

export interface Entry {
    key:string;
    // RFC 3339, kept as read so a rewrite for another provider preserves
    // it. Go's zero time when the file had none.
    storedAt:string;
}

const ZERO_TIME = '0001-01-01T00:00:00Z'

// Go's time.Time JSON form (RFC 3339 with optional fraction).
const RFC3339 =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// Shape and types only, with exact-case member names. Version, provider
// names, and keys are checked afterwards so each failure names itself.
const FileSchema = z.strictObject({
    version:z.unknown().optional(),
    providers:z.record(z.string(), z.strictObject({
        key:z.string().optional(),
        stored_at:z.string().refine(s => RFC3339.test(s), {
            error:'stored_at is not an RFC 3339 timestamp',
        }).nullable().optional(),
    })).nullable().optional(),
})

export type Env = Readonly<Record<string, string|undefined>>

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function envValue (env:Env, name:string):string {
    const v = Object.hasOwn(env, name) ? env[name] : undefined
    return typeof v === 'string' ? v : ''
}

// The file belongs to the worktree holding dir.
export async function projectCredentialsPath (
    dir:string,
    opts:GitRunOpts = {}
):Promise<string> {
    try {
        return path.join(await gitRoot(dir, opts), PROJECT_CREDENTIALS_FILE)
    } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new Error(`project credentials: ${message(err)}`,
            { cause:err })
    }
}

// $XDG_CONFIG_HOME/roast/credentials.json, else
// $HOME/.config/roast/credentials.json, both read from `env` (never the
// passwd entry, which would defeat test isolation).
export function userCredentialsPath (env:Env):string {
    const xdg = envValue(env, 'XDG_CONFIG_HOME')
    if (xdg !== '') return path.join(xdg, 'roast', CREDENTIALS_FILE)
    const home = envValue(env, 'HOME')
    if (home === '') {
        throw new Error('user credentials: $HOME is not defined')
    }
    return path.join(home, '.config', 'roast', CREDENTIALS_FILE)
}

// Go's fs.FileMode string of the permission bits, such as -rw-r--r--.
function permString (mode:number):string {
    let s = '-'
    for (let shift = 6; shift >= 0; shift -= 3) {
        const bits = (mode >> shift) & 7
        s += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') +
            (bits & 1 ? 'x' : '-')
    }
    return s
}

function issueText (err:z.ZodError):string {
    const issue = err.issues[0]
    if (!issue) return 'invalid credentials file'
    if (issue.code === 'unrecognized_keys') {
        return `unknown field ${JSON.stringify(issue.keys[0])}`
    }
    const at = issue.path.map(String).join('.')
    return at === '' ? issue.message : `${at}: ${issue.message}`
}

// Decodes a credentials file. Errors never include a key.
function decode (text:string):Map<string, Entry> {
    let doc:unknown
    try {
        doc = JSON.parse(text)
    } catch {
        // JSON.parse can quote input around a syntax error, including a
        // stored key. Never expose its message to diagnostic callers.
        throw new Error('invalid credentials JSON')
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
        throw new Error('not a JSON object')
    }
    const checked = FileSchema.safeParse(doc)
    if (!checked.success) throw new Error(issueText(checked.error))
    // The validated input, never zod's output (see config/load.ts).
    const input = doc as z.input<typeof FileSchema>
    if (input.version !== CURRENT_VERSION) {
        const v = input.version === undefined ?
            '0' :
            JSON.stringify(input.version)
        throw new Error(`unsupported version ${v} ` +
            `(want ${CURRENT_VERSION})`)
    }
    const entries = new Map<string, Entry>()
    for (const [name, entry] of Object.entries(input.providers ?? {})) {
        if (!lookupProvider(name)) {
            throw new Error(`unknown provider ${JSON.stringify(name)}`)
        }
        const key = entry.key ?? ''
        if (goTrimSpace(key) === '') {
            throw new Error(`provider ${JSON.stringify(name)} has an ` +
                'empty key')
        }
        entries.set(name, { key, storedAt:entry.stored_at ?? ZERO_TIME })
    }
    return entries
}

function isCode (err:unknown, code:string):boolean {
    return (err as NodeJS.ErrnoException)?.code === code
}

function isProjectFile (file:string):boolean {
    return path.basename(file) === PROJECT_CREDENTIALS_FILE
}

// The synchronous loader behind loadCredentials and the store's lookup
// (the files are tiny). A missing file holds no credentials; a file any
// group or other user may access is an error, never skipped.
function readPrivateFile (file:string):string|null {
    let fd:number
    try {
        fd = fs.openSync(file, isProjectFile(file) ?
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
                fs.constants.O_NONBLOCK : 'r')
    } catch (err) {
        if (isCode(err, 'ENOENT')) return null
        throw new Error(`read credentials: ${message(err)}`, { cause:err })
    }
    try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) throw new Error(`${file} is not a regular file`)
        const perm = stat.mode & 0o777
        if ((perm & 0o077) !== 0) {
            throw new Error(`credentials file ${file} is readable by ` +
                `other users (mode ${permString(perm)}); run ` +
                `\`chmod 600 ${file}\``)
        }
        try {
            return fs.readFileSync(fd, 'utf8')
        } catch (err) {
            throw new Error(`read credentials: ${message(err)}`,
                { cause:err })
        }
    } finally {
        fs.closeSync(fd)
    }
}

export function loadCredentialsSync (file:string):Map<string, Entry> {
    const text = readPrivateFile(file)
    if (text === null) return new Map()
    try {
        if (isProjectFile(file)) {
            return new Map([...decodeDotenv(text)].map(([name, key]) =>
                [name, { key, storedAt:ZERO_TIME }]))
        }
        return decode(text)
    } catch (err) {
        throw new Error(`credentials file ${file}: ${message(err)}`)
    }
}

export async function loadCredentials (
    file:string
):Promise<Map<string, Entry>> {
    return loadCredentialsSync(file)
}

// Go's RFC3339Nano in UTC: the fraction only when non-zero, trailing
// zeros trimmed.
function formatStoredAt (d:Date):string {
    return d.toISOString().replace(/\.(\d*?)0*Z$/, (_, frac:string) =>
        frac === '' ? 'Z' : `.${frac}Z`)
}

async function writeCredentials (
    file:string,
    entries:Map<string, Entry>,
    opts:GitRunOpts
):Promise<void> {
    if (isProjectFile(file)) {
        const keys = new Map([...entries].map(([name, { key }]) =>
            [name, key]))
        return writeProjectFile(file, encodeDotenv(keys), opts)
    }
    const providers:Record<string, { key:string, stored_at:string }> =
        Object.create(null)
    for (const name of [...entries.keys()].sort(compareBytes)) {
        const e = entries.get(name) as Entry
        providers[name] = { key:e.key, stored_at:e.storedAt }
    }
    const body = { version:CURRENT_VERSION, providers }
    await writeFileAtomic(file, JSON.stringify(body, null, 2) + '\n', {
        mode:0o600,
        tempPrefix:'credentials-',
        tempSuffix:'.json',
        dirMode:0o700,
        chmodDir:true,
        errorPrefix:'write credentials',
    })
}

async function writeProjectFile (
    file:string, body:string, opts:GitRunOpts
):Promise<void> {
    await protectProjectCredential(path.dirname(file), opts)
    opts.signal?.throwIfAborted()
    await writeFileAtomic(file, body, {
        mode:0o600,
        tempPrefix:PROJECT_CREDENTIALS_TEMP_PREFIX,
        errorPrefix:'write project credentials',
    })
}

// Stores `key` for `provider`, replacing any previous entry. The key is
// stored as given; an unusable existing file aborts the save.
export async function saveCredential (
    file:string,
    provider:string,
    key:string,
    storedAt:Date,
    opts:GitRunOpts = {}
):Promise<void> {
    if (!lookupProvider(provider)) {
        throw new Error('save credential: unknown provider ' +
            JSON.stringify(provider))
    }
    if (goTrimSpace(key) === '') {
        throw new Error('save credential: empty key')
    }
    const entries = await loadCredentials(file)
    entries.set(provider, { key, storedAt:formatStoredAt(storedAt) })
    await writeCredentials(file, entries, opts)
}

export interface ScopePaths {
    // '' when the scope does not exist (outside a repository, or no
    // XDG_CONFIG_HOME and no HOME).
    project:string;
    user:string;
}

// The config area's StoredCredentials. Paths are fixed at construction,
// so lookup is synchronous; each file is read on first need and its map
// cached after a successful load. A failed load is not cached.
export class CredentialStore implements StoredCredentials {
    readonly paths:ScopePaths
    private readonly loaded = new Map<CredentialScope, Map<string, Entry>>()

    constructor (paths:ScopePaths) {
        this.paths = Object.freeze({ ...paths })
    }

    private entries (scope:CredentialScope):Map<string, Entry> {
        let map = this.loaded.get(scope)
        if (!map) {
            const file = this.paths[scope]
            map = file === '' ? new Map() : loadCredentialsSync(file)
            this.loaded.set(scope, map)
        }
        return map
    }

    // Project scope first, then user scope. Throws when a file it reaches
    // cannot be used, even if a later scope holds the key.
    lookup (provider:string):{ key:string, scope:CredentialScope }|null {
        for (const scope of ['project', 'user'] as const) {
            const entry = this.entries(scope).get(provider)
            if (entry) return { key:entry.key, scope }
        }
        return null
    }
}

// The store for working directory `dir` (no project scope when '' or
// outside a repository) and the environment's user config directory.
export async function openCredentialStore (
    dir:string,
    env:Env,
    opts:{ signal?:AbortSignal } = {}
):Promise<CredentialStore> {
    let project = ''
    if (dir !== '') {
        try {
            const gitOpts = {
                signal:opts.signal,
                env:env as NodeJS.ProcessEnv,
            }
            project = await projectCredentialsPath(dir, gitOpts)
            project = await readableProjectPath(project, gitOpts)
        } catch (err) {
            if (opts.signal?.aborted) throw err
        }
    }
    let user = ''
    try {
        user = userCredentialsPath(env)
    } catch {
        // No user scope.
    }
    return new CredentialStore({ project, user })
}

// Removes `provider`'s entry. A missing file or entry writes nothing.
export async function deleteCredential (
    file:string,
    provider:string,
    opts:GitRunOpts = {}
):Promise<void> {
    const entries = await loadCredentials(file)
    if (!entries.delete(provider)) return
    await writeCredentials(file, entries, opts)
}

async function exists (file:string):Promise<boolean> {
    try {
        await lstat(file)
        return true
    } catch (err) {
        if (isCode(err, 'ENOENT')) return false
        throw err
    }
}

async function legacyPath (file:string, opts:GitRunOpts):Promise<string> {
    const dir = await stateDir(path.dirname(file), opts)
    return path.join(dir, CREDENTIALS_FILE)
}

async function primaryProjectPath (
    file:string, opts:GitRunOpts
):Promise<string> {
    const list = await git(path.dirname(file),
        ['worktree', 'list', '--porcelain', '-z'], opts)
    const fields = list.toString('utf8').split('\0')
    const first = fields[0]
    if (!first?.startsWith('worktree ') || fields[1] === 'bare') {
        return file
    }
    return path.join(first.slice('worktree '.length),
        PROJECT_CREDENTIALS_FILE)
}

async function readableProjectPath (
    file:string, opts:GitRunOpts
):Promise<string> {
    if (await exists(file)) return file
    const primary = await primaryProjectPath(file, opts)
    if (primary !== file && await exists(primary)) return primary
    const legacy = await legacyPath(file, opts)
    return await exists(legacy) ? legacy : file
}

async function migrateLegacyCredentials (
    legacy:string, primary:string, opts:GitRunOpts
):Promise<void> {
    const entries = await loadCredentials(legacy)
    for (const [name, entry] of await loadCredentials(primary)) {
        entries.set(name, entry)
    }
    await writeCredentials(primary, entries, opts)
    try {
        await unlink(legacy)
    } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err
    }
}

// Local writes start with the inherited keys. Migration puts old shared
// keys in the primary checkout so other worktrees can still find them.
export async function prepareProjectCredentials (
    file:string, opts:GitRunOpts
):Promise<void> {
    const legacy = await legacyPath(file, opts)
    const migrate = await exists(legacy)
    if (!migrate && await exists(file)) return
    const primary = await primaryProjectPath(file, opts)
    if (migrate) await migrateLegacyCredentials(legacy, primary, opts)
    if (primary === file || await exists(file)) return
    const body = readPrivateFile(primary)
    if (body !== null) await writeProjectFile(file, body, opts)
}

export async function copyProjectCredentials (
    source:string, dest:string, opts:GitRunOpts
):Promise<void> {
    const file = path.join(source, PROJECT_CREDENTIALS_FILE)
    const from = await readableProjectPath(file, opts)
    const body = readPrivateFile(from)
    if (body === null) return
    if (isProjectFile(from)) {
        await assertProjectCredentialUntracked(path.dirname(from), opts)
    }
    const target = path.join(dest, PROJECT_CREDENTIALS_FILE)
    if (await exists(target)) {
        throw new Error(`restored snapshot already contains ${target}`)
    }
    if (isProjectFile(from)) {
        await writeProjectFile(target, body, opts)
    } else {
        await writeCredentials(target, decode(body), opts)
    }
}
