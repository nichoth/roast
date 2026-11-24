// The secret denylist (spec 11, "Secret denylist"): untracked paths that
// are never folded into a review diff, captured into a snapshot, or
// served from the live working tree.
import { goPathMatch } from '../gocompat/match.js'
import { git } from '../git/git.js'
import { compareBytes, decodePaths, splitNul } from '../scope/text.js'

// SSH keys match by key-type prefix so suffixed names are covered; a bare
// `id_*` would also drop ordinary sources such as id_map.go.
export const DEFAULT_DENYLIST:readonly string[] = Object.freeze([
    '.env*', '*.pem', '*_rsa', '*.key', 'creds*',
    'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'id_xmss*',
    'credentials.json', '.npmrc', '.pypirc', '.netrc', '_netrc', '.pgpass',
    '.git-credentials', '*.p12', '*.pfx',
])

function basename (p:string):string {
    const i = p.lastIndexOf('/')
    return i === -1 ? p : p.slice(i + 1)
}

// Whether a repo-relative `/`-separated path matches any pattern, by its
// basename or its full path, case-insensitively. A malformed pattern
// never matches.
export function denylisted (
    path:string,
    patterns:readonly string[] = DEFAULT_DENYLIST
):boolean {
    const full = path.toLowerCase()
    const base = basename(full)
    return patterns.some(pattern => {
        const p = pattern.toLowerCase()
        return goPathMatch(p, base) || goPathMatch(p, full)
    })
}

export interface DenylistedUntrackedOpts {
    // Omitted means DEFAULT_DENYLIST; an empty list disables filtering.
    patterns?:readonly string[];
    signal?:AbortSignal;
    env?:NodeJS.ProcessEnv;
}

// The untracked, non-ignored paths matching the denylist, in byte order.
// Tracked files are never listed: their content is already in history.
export async function denylistedUntracked (
    repo:string,
    opts:DenylistedUntrackedOpts = {}
):Promise<string[]> {
    const patterns = opts.patterns ?? DEFAULT_DENYLIST
    if (patterns.length === 0) return []
    const out = await git(repo,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        { signal:opts.signal, env:opts.env })
    return decodePaths(out).paths
        .filter(p => p !== '' && denylisted(p, patterns))
        .sort(compareBytes)
}

export interface RawPath {
    // The name exactly as git listed it.
    raw:Buffer;
    // The name decoded with U+FFFD replacement, for reports.
    name:string;
}

const lossy = new TextDecoder('utf-8')

// Like denylistedUntracked, but keeps names that are not valid UTF-8
// (matched on their U+FFFD-decoded form), so callers that exclude by
// raw name never let such a secret through. In raw byte order.
export async function denylistedUntrackedRaw (
    repo:string,
    opts:DenylistedUntrackedOpts = {}
):Promise<RawPath[]> {
    const patterns = opts.patterns ?? DEFAULT_DENYLIST
    if (patterns.length === 0) return []
    const out = await git(repo,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        { signal:opts.signal, env:opts.env })
    return splitNul(out)
        .filter(raw => raw.length > 0)
        .map(raw => ({ raw, name:lossy.decode(raw) }))
        .filter(p => denylisted(p.name, patterns))
        .sort((a, b) => Buffer.compare(a.raw, b.raw))
}
