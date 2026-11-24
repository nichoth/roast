// Build: decides exactly what a review looks at (spec 04, 2.4 to 2.16).
// The file list comes from the same pathspec-filtered git queries that
// produced the diff, so nothing outside the post-exclude diff can reach
// the finder.
import { goQuote, goTrimSpace } from '../gocompat/strings.js'
import { denylisted } from '../snapshot/denylist.js'
import {
    BASE_CANDIDATES,
    DEFAULT_IGNORES,
    DEFAULT_MAX_FILE_DIFF_BYTES,
    DIFF_FLAGS,
    EMPTY_TREE,
} from './constants.js'
import {
    diffArgs,
    git,
    gitOk,
    gitPatch,
    wrapGitError,
    type GitRunOpts,
} from './git.js'
import { untrackedPasses } from './glob.js'
import { linguistIgnores, linguistMarked } from './linguist.js'
import { listSome, truncationNote } from './patch.js'
import { compactRenames, renameNote, renameOf, splitSections } from
    './renames.js'
import { compareBytes, decodeName, splitNul } from './text.js'
import { buildSurveyRepo } from './survey.js'
import { synthesizeNewFileDiff } from './untracked.js'

export type ScopeKind = ''|'diff'|'repo'

export interface BuildOpts {
    base?:string;
    uncommittedOnly?:boolean;
    stagedOnly?:boolean;
    paths?:readonly string[];
    excludes?:readonly string[];
    includeVendored?:boolean;
    scope?:string;
    stagedTreeOID?:string;
    maxFileDiffBytes?:number;
    // The environment git runs with (the CLI context's env); process.env
    // when absent. An ambient GIT_INDEX_FILE in it is honored.
    env?:NodeJS.ProcessEnv;
}

export interface Scope {
    readonly diff:string;
    readonly diffBytes:Buffer;
    readonly files:readonly string[];
    readonly base:string;
    readonly notes:readonly string[];
    readonly staged:boolean;
    readonly stagedTreeOID:string;
    readonly manifest:string;
    readonly survey:boolean;
    readonly headOID:string;
}

export interface SizeEntry {
    path:string;
    bytes:number;
}

// Whether there is nothing to review.
export function isEmpty (scope:Scope):boolean {
    if (scope.survey) return scope.files.length === 0
    return goTrimSpace(scope.diff) === ''
}

function makeScope (diffBytes:Buffer, fields:Partial<Scope>):Scope {
    return {
        diff:diffBytes.toString('utf8'),
        diffBytes,
        files:[],
        base:'',
        notes:[],
        staged:false,
        stagedTreeOID:'',
        manifest:'',
        survey:false,
        headOID:'',
        ...fields,
    }
}

// The pathspec arguments: none at all when every list is empty.
export function pathspecArgs (
    paths:readonly string[],
    excludes:readonly string[],
    literalExcludes:readonly string[]
):string[] {
    if (paths.length === 0 && excludes.length === 0 &&
        literalExcludes.length === 0) {
        return []
    }
    return [
        '--',
        ...paths,
        ...excludes.map(p => `:(exclude)${p}`),
        ...literalExcludes.map(p => `:(exclude,literal)${p}`),
    ]
}

// The first candidate ref that resolves, or ''.
export async function resolveBase (
    repo:string,
    requested:string,
    opts:GitRunOpts
):Promise<string> {
    const candidates = requested ? [requested] : BASE_CANDIDATES
    for (const ref of candidates) {
        if (await gitOk(repo, ['rev-parse', '--verify', '--quiet', ref],
            opts)) {
            return ref
        }
    }
    return ''
}

export async function buildRangeArgs (
    repo:string,
    base:string,
    opts:GitRunOpts
):Promise<string[]> {
    if (await gitOk(repo, ['merge-base', base, 'HEAD'], opts)) {
        return [`${base}...HEAD`]
    }
    return [base, 'HEAD']
}

// Collects decoded names into a set, counting (once per distinct raw
// name) the ones that are not valid UTF-8.
class NameCollector {
    readonly names = new Set<string>()
    private readonly invalid = new Set<string>()

    add (buf:Buffer):void {
        for (const raw of splitNul(buf)) {
            const name = decodeName(raw)
            if (name === null) this.invalid.add(raw.toString('hex'))
            else this.names.add(name)
        }
    }

    addInvalid (raw:Buffer):void {
        this.invalid.add(raw.toString('hex'))
    }

    note (notes:string[]):string[] {
        if (this.invalid.size === 0) return notes
        return [...notes, `skipped ${this.invalid.size} path(s) whose ` +
            'names are not valid UTF-8']
    }

    sorted ():string[] {
        return [...this.names].sort(compareBytes)
    }
}

interface Ctx {
    repo:string;
    opts:BuildOpts;
    run:GitRunOpts;
    spec:string[];
    maxSection:number;
    allExcludes:string[];
    notes:string[];
}

export async function build (
    repo:string,
    opts:BuildOpts,
    signal?:AbortSignal
):Promise<Scope> {
    const run:GitRunOpts = { signal, env:opts.env }
    const notes:string[] = []
    const maxSection = opts.maxFileDiffBytes && opts.maxFileDiffBytes > 0 ?
        opts.maxFileDiffBytes :
        DEFAULT_MAX_FILE_DIFF_BYTES
    const allExcludes = [...(opts.excludes ?? [])]
    let linguistExcludes:string[] = []
    if (!opts.includeVendored) {
        allExcludes.push(...DEFAULT_IGNORES)
        linguistExcludes = await linguistIgnores(repo, !!opts.stagedOnly,
            opts.stagedTreeOID ?? '', run)
        if (linguistExcludes.length > 0) {
            notes.push(`excluding ${linguistExcludes.length} path(s) ` +
                'marked linguist-generated/-vendored in .gitattributes ' +
                '(--include-vendored to review)')
        }
    }
    const spec = pathspecArgs(opts.paths ?? [], allExcludes,
        linguistExcludes)
    const scope = opts.scope ?? ''
    if (scope === 'repo') {
        const fields = await buildSurveyRepo(repo, opts.paths ?? [],
            allExcludes, linguistExcludes, notes, run)
        return makeScope(Buffer.alloc(0), fields)
    }
    if (scope !== '' && scope !== 'diff') {
        throw new Error(`unsupported scope ${goQuote(scope)}: expected ` +
            '"", "diff", or "repo"')
    }
    const ctx:Ctx = { repo, opts, run, spec, maxSection, allExcludes, notes }

    let head = 'HEAD'
    let uncommittedOnly = !!opts.uncommittedOnly
    if (!await gitOk(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'],
        run)) {
        head = EMPTY_TREE
        uncommittedOnly = true
        ctx.notes.push('repository has no commits; reviewing staged + ' +
            'untracked files')
    }
    if (opts.stagedOnly) return buildStaged(ctx, head)

    const names = new NameCollector()
    let cutSections:string[] = []
    let resolvedBase = ''
    let committed:Buffer = Buffer.alloc(0)
    if (!uncommittedOnly) {
        resolvedBase = await resolveBase(repo, opts.base ?? '', run)
        if (resolvedBase === '') {
            const tried = opts.base || BASE_CANDIDATES.join(', ')
            ctx.notes.push(`no usable base ref (tried ${tried}); reviewing ` +
                'uncommitted changes only')
        } else {
            if (!opts.base && resolvedBase !== BASE_CANDIDATES[0]) {
                ctx.notes.push(`using base '${resolvedBase}'`)
            }
            const range = await buildRangeArgs(repo, resolvedBase, run)
            const part = await diffPart(ctx, range, 'committed', names)
            committed = part.diff
            cutSections = [...cutSections, ...part.cut]
            ctx.notes = renameNote(ctx.notes, part.renamed)
        }
    }
    const unc = await diffPart(ctx, [head], 'uncommitted', names)
    cutSections = [...cutSections, ...unc.cut]
    ctx.notes = renameNote(ctx.notes, unc.renamed)

    const parts:Buffer[] = [committed]
    if (!isBlank(unc.diff)) {
        parts.push(Buffer.from('\n\n### Uncommitted changes ###\n'), unc.diff)
    }
    let diff = Buffer.concat(parts)

    const untracked = await untrackedBlocks(ctx, names)
    cutSections = [...cutSections, ...untracked.cut]
    ctx.notes = truncationNote(ctx.notes, cutSections, maxSection)
    if (untracked.blocks.length > 0) {
        const tail:Buffer[] = []
        if (!isBlank(diff)) {
            tail.push(Buffer.from('\n\n### Untracked files (treated as ' +
                'new-file additions) ###\n'))
        }
        untracked.blocks.forEach((b, i) => {
            if (i > 0) tail.push(Buffer.from('\n'))
            tail.push(b)
        })
        diff = Buffer.concat([diff, ...tail])
    }
    return makeScope(diff, {
        files:names.sorted(),
        base:resolvedBase,
        notes:names.note(ctx.notes),
    })
}

function isBlank (buf:Buffer):boolean {
    return goTrimSpace(buf.toString('utf8')) === ''
}

async function buildStaged (ctx:Ctx, head:string):Promise<Scope> {
    const { opts, run, repo, spec, maxSection } = ctx
    const pinned = opts.stagedTreeOID ?? ''
    const ref = pinned ? [head, pinned] : ['--cached', head]
    let patch
    try {
        patch = await gitPatch(repo, diffArgs(...DIFF_FLAGS, ...ref, ...spec),
            maxSection, run)
    } catch (err) {
        throw wrapGitError('git diff (staged)', err, run.signal)
    }
    let notes = truncationNote(ctx.notes, patch.cut, maxSection)
    const compact = await compactRenames(repo, ref, spec, patch.out,
        maxSection, run)
    notes = renameNote(notes, compact.renamed)
    const names = new NameCollector()
    try {
        names.add(await git(repo, diffArgs(...DIFF_FLAGS, '--name-only',
            '-z', ...ref, ...spec), run))
    } catch (err) {
        throw wrapGitError('git diff --name-only (staged)', err, run.signal)
    }
    return makeScope(compact.diff, {
        files:names.sorted(),
        notes:names.note(notes),
        staged:true,
        stagedTreeOID:pinned,
    })
}

// One capped, rename-compacted diff against `ref`, with its names.
async function diffPart (
    ctx:Ctx,
    ref:readonly string[],
    label:string,
    names:NameCollector
):Promise<{ diff:Buffer, cut:string[], renamed:number }> {
    const { repo, spec, maxSection, run } = ctx
    let patch
    try {
        patch = await gitPatch(repo, diffArgs(...DIFF_FLAGS, ...ref, ...spec),
            maxSection, run)
    } catch (err) {
        throw wrapGitError(`git diff (${label})`, err, run.signal)
    }
    const compact = await compactRenames(repo, ref, spec, patch.out,
        maxSection, run)
    try {
        names.add(await git(repo, diffArgs(...DIFF_FLAGS, '--name-only',
            '-z', ...ref, ...spec), run))
    } catch (err) {
        throw wrapGitError(`git diff --name-only (${label})`, err,
            run.signal)
    }
    return { diff:compact.diff, cut:patch.cut, renamed:compact.renamed }
}

// Untracked files as new-file blocks (default diff mode only). Adds the
// denylist note to ctx.notes.
async function untrackedBlocks (
    ctx:Ctx,
    names:NameCollector
):Promise<{ blocks:Buffer[], cut:string[] }> {
    const { repo, opts, run, maxSection } = ctx
    let out:Buffer
    try {
        out = await git(repo,
            ['ls-files', '--others', '--exclude-standard', '-z'], run)
    } catch (err) {
        throw wrapGitError('git ls-files --others', err, run.signal)
    }
    let candidates:string[] = []
    const denied:string[] = []
    for (const raw of splitNul(out)) {
        const u = decodeName(raw)
        if (u === null) {
            names.addInvalid(raw)
            continue
        }
        if (!untrackedPasses(u, opts.paths ?? [], ctx.allExcludes)) continue
        if (denylisted(u)) denied.push(u)
        else candidates.push(u)
    }
    if (denied.length > 0) {
        ctx.notes = [...ctx.notes, `skipped ${denied.length} untracked ` +
            `file(s) matching the secret denylist: ${listSome(denied, 10)}`]
    }
    if (!opts.includeVendored && candidates.length > 0) {
        // Untracked files are worktree state: attributes come from the
        // worktree, with no pinned index.
        const marked = new Set(await linguistMarked(repo, candidates, false,
            { signal:run.signal, env:run.env }))
        candidates = candidates.filter(u => !marked.has(u))
    }
    const blocks:Buffer[] = []
    const cut:string[] = []
    for (const u of candidates) {
        const s = await synthesizeNewFileDiff(repo, u, maxSection,
            run.signal)
        if (s.block.length === 0) continue
        if (s.cut) cut.push(u)
        blocks.push(s.block)
        names.names.add(u)
    }
    return { blocks, cut }
}

// The bytes of `path`'s sections in the diff: every `diff --git a/P b/P`
// block, plus every collapsed move naming it on either side.
export function fileDiffBytes (diff:Buffer, path:string):number {
    const marker = Buffer.from(`diff --git a/${path} b/${path}`)
    const next = Buffer.from('\ndiff --git ')
    let total = 0
    let pos = 0
    for (;;) {
        const start = diff.indexOf(marker, pos)
        if (start === -1) break
        const n = diff.indexOf(next, start + 1)
        const end = n === -1 ? diff.length : n
        total += end - start
        pos = end
    }
    for (const sec of splitSections(diff)) {
        const r = renameOf(sec.bytes)
        if (r !== null && (r.from === path || r.to === path)) {
            total += sec.bytes.length
        }
    }
    return total
}

// Fits the diff into maxBytes. Over budget: truncates on a byte offset
// and returns a per-file size breakdown, largest first (stable: ties keep
// files order). Returns a new Scope.
export function fit (
    scope:Scope,
    maxBytes:number
):{ scope:Scope, breakdown:SizeEntry[]|null } {
    if (scope.diffBytes.length <= maxBytes) return { scope, breakdown:null }
    const breakdown = scope.files
        .map(path => ({ path, bytes:fileDiffBytes(scope.diffBytes, path) }))
        .sort((a, b) => b.bytes - a.bytes)
    const diffBytes = Buffer.concat([
        scope.diffBytes.subarray(0, maxBytes),
        Buffer.from('\n... (diff truncated)\n'),
    ])
    return {
        scope:{
            ...scope,
            diff:diffBytes.toString('utf8'),
            diffBytes,
            notes:[...scope.notes, `diff truncated to ${maxBytes} bytes`],
        },
        breakdown,
    }
}
