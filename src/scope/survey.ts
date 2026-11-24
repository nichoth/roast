// Repo survey scope (spec 04, 2.12): the committed tree at HEAD as one
// manifest, instead of a diff.
import { compareBytes, goQuote, goTrimSpace, isGoPrint } from
    '../gocompat/strings.js'
import { git, gitOk, wrapGitError, type GitRunOpts } from './git.js'
import { untrackedPasses } from './glob.js'
import { decodeName, splitNul } from './text.js'

export interface SurveyFields {
    manifest:string;
    survey:true;
    files:string[];
    headOID:string;
    notes:string[];
}

const EXPLANATION = '\n(Names in double quotes contain control or ' +
    'markup characters and are Go-escaped; unescape one before passing it ' +
    'to a tool.)\n'

// A name unchanged when it is safe on one manifest line; otherwise Go
// strconv.Quote with `<` and `>` escaped, so no name can spell the
// manifest's closing tag or forge a line.
export function manifestQuote (name:string):{ text:string, quoted:boolean } {
    let safe = true
    for (const ch of name) {
        const cp = ch.codePointAt(0)!
        if (cp === 0x22 || cp === 0x5c || cp === 0x3c || cp === 0x3e ||
            !isGoPrint(cp)) {
            safe = false
            break
        }
    }
    if (safe) return { text:name, quoted:false }
    const text = goQuote(name).replaceAll('<', '\\x3c')
        .replaceAll('>', '\\x3e')
    return { text, quoted:true }
}

export async function buildSurveyRepo (
    repo:string,
    paths:readonly string[],
    allExcludes:readonly string[],
    linguistExcludes:readonly string[],
    notesIn:readonly string[],
    run:GitRunOpts
):Promise<SurveyFields> {
    const notes = [...notesIn]
    let literal = linguistExcludes
    let status:Buffer
    try {
        status = await git(repo, ['status', '--porcelain'], run)
    } catch (err) {
        throw wrapGitError('git status --porcelain', err, run.signal)
    }
    if (goTrimSpace(status.toString('utf8')) !== '') {
        // The linguist set came from the mutable index and worktree, not
        // HEAD: drop it rather than let an unstaged edit hide a file.
        if (literal.length > 0) {
            notes.push('working tree is dirty: skipping .gitattributes-' +
                'based excludes for repo scope (they were resolved from ' +
                'the mutable index/worktree, not HeadOID)')
        }
        literal = []
        notes.push('working tree has uncommitted changes not reflected in ' +
            'this repo-scope snapshot (pinned to HeadOID)')
    }

    let headOID = ''
    if (await gitOk(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'],
        run)) {
        try {
            headOID = goTrimSpace(
                (await git(repo, ['rev-parse', 'HEAD'], run)).toString())
        } catch (err) {
            throw wrapGitError('git rev-parse HEAD', err, run.signal)
        }
    } else {
        notes.push('repository has no commits; manifest is empty')
    }

    const files:string[] = []
    let invalid = 0
    if (headOID !== '') {
        let out:Buffer
        try {
            out = await git(repo,
                ['ls-tree', '-r', '--name-only', '-z', headOID], run)
        } catch (err) {
            throw wrapGitError('git ls-tree', err, run.signal)
        }
        const literalSet = new Set(literal)
        for (const raw of splitNul(out)) {
            const name = decodeName(raw)
            if (name === null) {
                invalid++
                continue
            }
            if (literalSet.has(name)) continue
            if (untrackedPasses(name, paths, allExcludes)) files.push(name)
        }
    }
    files.sort(compareBytes)
    if (invalid > 0) {
        notes.push(`skipped ${invalid} path(s) whose names are not valid ` +
            'UTF-8')
    }

    let headLine = ''
    if (headOID !== '') {
        try {
            headLine = goTrimSpace((await git(repo, ['log', '--oneline',
                '--no-color', '--no-show-signature', '-1'], run)).toString())
        } catch (err) {
            if (run.signal?.aborted) throw err
        }
    }

    const counts = new Map<string, number>()
    for (const f of files) {
        const i = f.indexOf('/')
        const top = i >= 0 ? f.slice(0, i) : f
        counts.set(top, (counts.get(top) ?? 0) + 1)
    }
    const dirs = [...counts.keys()].sort(compareBytes)

    let quoted = false
    const q = (s:string):string => {
        const r = manifestQuote(s)
        quoted ||= r.quoted
        return r.text
    }
    let m = '### Repository snapshot ###\n'
    m += headLine !== '' ?
        `HEAD: ${q(headLine)}\n` :
        'HEAD: (no commits)\n'
    m += `${files.length} tracked file(s) across ${dirs.length} ` +
        'top-level director(ies)\n\n'
    m += '### Files by top-level directory ###\n'
    for (const d of dirs) m += `${q(d)} (${counts.get(d)})\n`
    m += '\n### Tracked files ###\n'
    for (const f of files) m += `${q(f)}\n`
    if (quoted) m += EXPLANATION

    return { manifest:m, survey:true, files, headOID, notes }
}
