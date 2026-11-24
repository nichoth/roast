// The read_file tool body (spec 05, 2.8): a window of numbered lines from
// the reviewed tree, streamed so a huge file is never held whole.
import fs from 'node:fs'
import { stat } from 'node:fs/promises'
import { git, GitError } from '../git/git.js'
import { gitStream, STREAM_BUFFER, type ContextOpts } from './git.js'
import { LineReader } from './lines.js'
import { parseOffsetLimit } from './offset-limit.js'
import { resolveLive, stagedPathCanonical } from './paths.js'
import { pinned, staged, type Tree } from './tree.js'

const EM = '\u2014'

// Ceiling on one tool result's content.
export const TOOL_OUTPUT_CAP = 65536
// Ceiling on one served line.
export const MAX_LINE_BYTES = 32768
// Max lines in one window.
export const READ_FILE_LINE_LIMIT = 2000

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function outside (p:string):{ error:string } {
    return { error:`path '${p}' is outside the repository or invalid` }
}

interface Source {
    lines:LineReader;
    // Stops the source early (pinned: kills cat-file).
    stop ():void;
    // Resolves once the source is done; an error message on failure.
    finish ():Promise<string|null>;
}

function liveSource (abs:string, signal:AbortSignal):Source {
    const stream = fs.createReadStream(abs,
        { highWaterMark:STREAM_BUFFER, signal })
    let openError:string|null = null
    stream.on('error', err => {
        if (!signal.aborted) openError = message(err)
    })
    return {
        lines:new LineReader(stream as AsyncIterable<Buffer>),
        stop () { stream.destroy() },
        async finish () {
            stream.destroy()
            return openError
        },
    }
}

function pinnedSource (
    repo:string,
    spec:string,
    opts:ContextOpts
):Source {
    const s = gitStream(repo, ['cat-file', 'blob', spec], opts)
    const lines = new LineReader(s.stdout)
    return {
        lines,
        stop () { s.kill() },
        async finish () {
            // A paused stdout would keep the child from closing.
            await lines.close()
            // The exit status is ignored; only a spawn failure counts.
            const exit = await s.done
            return exit.error ? message(exit.error) : null
        },
    }
}

// Whether the path exists in the served corpus, or the error result.
async function checkPinned (
    repo:string,
    tree:Tree,
    p:string,
    opts:ContextOpts
):Promise<{ error:string }|null> {
    try {
        await git(repo, ['cat-file', '-e', `${tree.oid}:${p}`], opts)
        return null
    } catch (err) {
        opts.signal?.throwIfAborted()
        if (!(err instanceof GitError)) throw err
        return {
            error:staged(tree) ?
                `${p} is not in the index ${EM} staged deletion? this ` +
                    'review covers the index, not the working tree' :
                `${p} is not in the captured worktree for this run`,
        }
    }
}

export async function readFile (
    repo:string,
    tree:Tree,
    args:Record<string, unknown>,
    signal:AbortSignal,
    opts:ContextOpts = {}
):Promise<Record<string, unknown>> {
    const runOpts:ContextOpts = { ...opts, signal }
    const p = typeof args.path === 'string' ? args.path : ''
    let abs = ''
    if (pinned(tree)) {
        if (!stagedPathCanonical(p)) return outside(p)
        const missing = await checkPinned(repo, tree, p, runOpts)
        if (missing) return missing
    } else {
        const resolved = await resolveLive(repo, p, runOpts)
        if (resolved === null) return outside(p)
        abs = resolved
        const st = await stat(abs).catch(() => null)
        if (!st?.isFile()) {
            return { error:`${p} does not exist or is not a regular file` }
        }
    }
    const window = parseOffsetLimit(args)
    if ('error' in window) return window
    const offset = window.offset
    const limit = Math.min(window.limit, READ_FILE_LINE_LIMIT)
    let end = offset + limit

    const src = pinned(tree) ?
        pinnedSource(repo, `${tree.oid}:${p}`, runOpts) :
        liveSource(abs, signal)
    let body = ''
    let bodyBytes = 0
    let lineNo = 0
    let moreBelow = false
    let outputCapped = false
    const truncatedLines:number[] = []
    try {
        for (;;) {
            const { line, cut, eof } = await src.lines
                .readLineCapped(MAX_LINE_BYTES)
            if (eof && line.length === 0 && !cut) break
            lineNo++
            const raw = line[line.length - 1] === 0x0a ?
                line.subarray(0, -1) :
                line
            let text = raw.toString('utf8')
            if (cut) {
                truncatedLines.push(lineNo)
                text += `  ... (line truncated at ${MAX_LINE_BYTES} bytes)`
            }
            if (lineNo >= end) {
                moreBelow = true
                break
            }
            if (lineNo >= offset) {
                let numbered = `${String(lineNo).padStart(5)}  ${text}`
                if (body !== '') numbered = '\n' + numbered
                const n = Buffer.byteLength(numbered)
                if (bodyBytes + n > TOOL_OUTPUT_CAP) {
                    end = lineNo
                    moreBelow = true
                    outputCapped = true
                    break
                }
                body += numbered
                bodyBytes += n
            }
            if (eof) break
        }
    } catch (err) {
        signal.throwIfAborted()
        src.stop()
        await src.finish()
        return { error:`read failed: ${message(err)}` }
    }
    if (moreBelow) src.stop()
    const failed = await src.finish()
    signal.throwIfAborted()
    if (failed !== null) return { error:`read failed: ${failed}` }

    if (outputCapped) {
        body += `\n... (output capped at ${TOOL_OUTPUT_CAP} bytes; more ` +
            `lines below; request offset>=${end} to continue)`
    } else if (moreBelow) {
        body += `\n... (more lines below; request offset>=${end} to ` +
            'continue)'
    } else if (lineNo === 0) {
        body += '\n(file is empty)'
    } else if (offset > lineNo) {
        body += `\n(offset ${offset} is past EOF ${EM} file has ${lineNo} ` +
            'lines)'
    }
    if (truncatedLines.length > 0) {
        body += `\n(lines truncated at ${MAX_LINE_BYTES} bytes: ` +
            `[${truncatedLines.join(' ')}])`
    }
    return {
        content:body,
        more_below:moreBelow,
        path:p,
        returned_range:[offset, Math.min(end - 1, lineNo)],
    }
}
