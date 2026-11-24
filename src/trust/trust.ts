// Per-clone approvals of project configs (spec 03, 2.5 and 2.6). The
// record lives under the Git common directory, which `git clone` never
// copies, so a repository cannot ship its own approval.
import fs from 'node:fs/promises'
import path from 'node:path'
import { git } from '../git/git.js'
import { writeFileAtomic } from '../fsutil/atomic.js'

export const TRUST_FILE = 'trust.json'
const CURRENT_VERSION = 2
const LEGACY_VERSION = 1

export interface TrustOpts {
    signal?:AbortSignal;
    // The git environment, normally the CLI context's env.
    env?:NodeJS.ProcessEnv;
}

export type TrustRecord =
    { kind:'current', approved:string[] }|{ kind:'legacy' }

export type ApprovalState = 'approved'|'not-approved'|'legacy'

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// <git-common-dir>/roast for the repository containing `dir`. Linked
// worktrees share the main repository's.
export async function stateDir (
    dir:string,
    opts:TrustOpts = {}
):Promise<string> {
    let out:Buffer
    try {
        out = await git(dir, ['rev-parse', '--path-format=absolute',
            '--git-common-dir'], opts)
    } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new Error('not inside a git repository', { cause:err })
    }
    return path.join(out.toString('utf8').trim(), 'roast')
}

export async function trustPath (
    dir:string,
    opts:TrustOpts = {}
):Promise<string> {
    try {
        return path.join(await stateDir(dir, opts), TRUST_FILE)
    } catch (err) {
        if (opts.signal?.aborted) throw err
        throw new Error(`trust: ${message(err)}`, { cause:err })
    }
}

function isObject (v:unknown):v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Reads the record at `file`. An absent file is an empty current record;
// a version 1 file (Go era) is legacy; anything else is an error.
export async function readTrustRecord (file:string):Promise<TrustRecord> {
    let text:string
    try {
        text = await fs.readFile(file, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { kind:'current', approved:[] }
        }
        throw new Error(`read trust record: ${message(err)}`, { cause:err })
    }
    const invalid = (cause:string):Error =>
        new Error(`read trust record ${file}: ${cause}`)
    let doc:unknown
    try {
        doc = JSON.parse(text)
    } catch (err) {
        throw invalid(message(err))
    }
    if (!isObject(doc)) throw invalid('not a JSON object')
    const version = doc.version
    if (version === LEGACY_VERSION) return { kind:'legacy' }
    if (version !== CURRENT_VERSION) {
        const shown = version === undefined ? 0 : JSON.stringify(version)
        throw new Error(`trust record ${file} has unsupported version ` +
            `${shown}`)
    }
    const approved = doc.approved ?? []
    if (!Array.isArray(approved) ||
        !approved.every(h => typeof h === 'string')) {
        throw invalid('approved must be an array of strings')
    }
    return { kind:'current', approved }
}

export async function isApproved (
    dir:string,
    hash:string,
    opts:TrustOpts = {}
):Promise<ApprovalState> {
    const rec = await readTrustRecord(await trustPath(dir, opts))
    if (rec.kind === 'legacy') return 'legacy'
    return rec.approved.includes(hash) ? 'approved' : 'not-approved'
}

// Records `hash` for this clone. A legacy record is replaced, not
// migrated; a malformed one aborts with the file untouched.
export async function approve (
    dir:string,
    hash:string,
    opts:TrustOpts = {}
):Promise<void> {
    const file = await trustPath(dir, opts)
    const rec = await readTrustRecord(file)
    let approved = [hash]
    if (rec.kind === 'current') {
        if (rec.approved.includes(hash)) return
        approved = [...rec.approved, hash]
    }
    const body = { version:CURRENT_VERSION, approved }
    await writeFileAtomic(file, JSON.stringify(body, null, 2) + '\n', {
        mode:0o600,
        tempPrefix:'trust-',
        tempSuffix:'.json',
        dirMode:0o755,
        errorPrefix:'write trust record',
    })
}
