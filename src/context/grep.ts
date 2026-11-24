// The grep_repo tool body (spec 05, 2.10): `git grep -E` over the reviewed
// tree, streamed and capped.
import { goQuote } from '../gocompat/strings.js'
import { denylistedUntracked } from '../snapshot/denylist.js'
import { gitStream, type ContextOpts } from './git.js'
import { LineReader } from './lines.js'
import { TOOL_OUTPUT_CAP } from './read-file.js'
import { pinned, staged, type Tree } from './tree.js'

const EM = '\u2014'

// Ceiling on one match line.
export const GREP_LINE_BYTES = 2048
// Max match lines in one result.
export const GREP_MATCH_CAP = 200

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function searched (tree:Tree, pathGlob:string):string {
    let s = !pinned(tree) ?
        'tracked + untracked (non-ignored) files in the working tree of ' +
            'this checkout' :
        staged(tree) ?
            `the git INDEX of this checkout ${EM} the staged content ` +
                'this review covers, NOT the working tree' :
            'the immutable captured worktree used by this run'
    if (pathGlob !== '') s += `, restricted to path_glob ${goQuote(pathGlob)}`
    return s
}

function noMatches (
    tree:Tree,
    pattern:string,
    pathGlob:string
):Record<string, unknown> {
    const blind = staged(tree) ?
        'unstaged working-tree edits, untracked files, ' :
        ''
    return {
        matches:[],
        note:'No matches. This is NOT proof the symbol is absent or ' +
            'unused: this search cannot see ' + blind + '.gitignore\'d ' +
            'or generated files, other repositories, calls made through ' +
            'an interface, embedding, reflection, or a struct/func value, ' +
            'code behind build tags, or a name spelled differently at ' +
            'the call site. Do not cite an empty grep as grounding for ' +
            '\'no callers\' / \'never invoked\' / \'unreachable\' / ' +
            '\'dead code\'. If a verdict or a severity downgrade depends ' +
            'on such a claim, establish it positively or report ' +
            'insufficient_context.',
        pattern,
        searched:searched(tree, pathGlob),
    }
}

export async function grepRepo (
    repo:string,
    tree:Tree,
    args:Record<string, unknown>,
    signal:AbortSignal,
    opts:ContextOpts = {}
):Promise<Record<string, unknown>> {
    const runOpts:ContextOpts = { ...opts, signal }
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (pattern === '') return { error:'pattern is required' }
    const pathGlob = typeof args.path_glob === 'string' ? args.path_glob : ''
    try {
        RegExp(pattern)
    } catch (err) {
        return { error:`invalid pattern: ${message(err)}` }
    }

    const live = !pinned(tree)
    const cmd = ['grep', '-n', '--no-color']
    if (live) cmd.push('--untracked')
    cmd.push('-E', '-e', pattern)
    if (!live) cmd.push(tree.oid)
    cmd.push('--')
    if (pathGlob !== '') cmd.push(pathGlob)
    if (live) {
        let denied:string[]
        try {
            denied = await denylistedUntracked(repo, runOpts)
        } catch (err) {
            signal.throwIfAborted()
            return { error:`grep failed: ${message(err)}` }
        }
        if (denied.length > 0 && pathGlob === '') cmd.push('.')
        for (const p of denied) cmd.push(`:(exclude,literal)${p}`)
    }

    // A parent GIT_LITERAL_PATHSPECS=1 would make the exclusions plain
    // paths and let denylisted files be searched (deliberate change 10).
    const s = gitStream(repo, cmd,
        { ...runOpts, extraEnv:{ GIT_LITERAL_PATHSPECS:'0' } })
    const reader = new LineReader(s.stdout)
    const prefix = Buffer.from(live ? '' : `${tree.oid}:`)
    const prefixBytes = prefix.length
    const out:string[] = []
    let used = 0
    let capped = false
    try {
        for (;;) {
            const { line, cut, eof } = await reader
                .readLineCapped(prefixBytes + GREP_LINE_BYTES)
            if (eof && line.length === 0) break
            let raw = line[line.length - 1] === 0x0a ?
                line.subarray(0, -1) :
                line
            if (prefixBytes > 0 &&
                raw.subarray(0, prefixBytes).equals(prefix)) {
                raw = raw.subarray(prefixBytes)
            }
            let l:string
            if (cut || raw.length > GREP_LINE_BYTES) {
                l = raw.subarray(0, GREP_LINE_BYTES).toString('utf8') +
                    ' ... (line truncated)'
            } else {
                l = raw.toString('utf8')
            }
            if (l !== '') {
                if (out.length >= GREP_MATCH_CAP) {
                    out.push(`... (truncated at ${GREP_MATCH_CAP} matching ` +
                        'lines)')
                    capped = true
                    break
                }
                const n = Buffer.byteLength(l) + 1
                if (used + n > TOOL_OUTPUT_CAP) {
                    out.push(`... (truncated at ${TOOL_OUTPUT_CAP} bytes ` +
                        `after ${out.length} matching lines)`)
                    capped = true
                    break
                }
                out.push(l)
                used += n
            }
            if (eof) break
        }
    } finally {
        if (capped) s.kill()
        await reader.close()
    }
    const exit = await s.done
    signal.throwIfAborted()
    if (exit.error) return { error:`grep failed: ${message(exit.error)}` }
    if (!capped) {
        if (exit.code === 1) return noMatches(tree, pattern, pathGlob)
        if (exit.code !== 0) {
            const status = exit.code === null ?
                'signal: killed' :
                `exit status ${exit.code}`
            const detail = exit.stderr.trim()
            return {
                error:`grep failed: ${status}` +
                    (detail === '' ? '' : `: ${detail}`),
            }
        }
    }
    if (out.length === 0) return noMatches(tree, pattern, pathGlob)
    return { matches:out, pattern }
}
