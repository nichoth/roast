// `roast runs` and `roast runs show` (spec 10, 2.14 and 2.15), and the
// snapshot subcommands `runs checkout` and `runs prune` (spec 11).
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Argv } from 'yargs'
import { recordDir } from '../record/dir.js'
import { readMeta, reportPath, type Meta } from '../record/meta.js'
import { gitRoot } from '../git/git.js'
import {
    formatGoDuration, parseGoDuration, type GoDuration,
} from '../gocompat/duration.js'
import { prune, restore } from '../snapshot/snapshot.js'
import { compareBytes } from '../gocompat/strings.js'
import { textBytes } from '../textsafe/textsafe.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { UsageError } from './errors.js'

const DEFAULT_LIMIT = 20

// Go bufio.Scanner's maximum token size as Roast configures it.
const MAX_LINE = 16 * 1024 * 1024

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

// A decimal Go int flag value.
function parseLimit (raw:unknown):number {
    if (raw === undefined) return DEFAULT_LIMIT
    const s = String(raw)
    if (!/^[+-]?[0-9]+$/.test(s)) {
        throw new UsageError(
            `invalid argument ${JSON.stringify(s)} for "--limit" flag`)
    }
    const n = BigInt(s)
    if (n < INT64_MIN || n > INT64_MAX) {
        throw new UsageError(`invalid argument ${JSON.stringify(s)} ` +
            'for "--limit" flag: value out of range')
    }
    return Number(n)
}

// Splits like Go's bufio.Scanner with ScanLines: on \n, dropping one
// trailing \r; a final unterminated line counts. A line of MAX_LINE
// bytes or more stops the scan, keeping the lines before it.
export function scanLines (data:Buffer):Buffer[] {
    const lines:Buffer[] = []
    let start = 0
    while (start < data.length) {
        let end = data.indexOf(0x0a, start)
        const terminated = end !== -1
        if (!terminated) end = data.length
        if (end - start >= MAX_LINE) break
        let line = data.subarray(start, end)
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1)
        }
        lines.push(line)
        start = end + 1
    }
    return lines
}

// Go `%-Ns`: right-padded to n code points, never truncated.
function pad (s:string, n:number):string {
    const len = [...s].length
    return len >= n ? s : s + ' '.repeat(n - len)
}

type Json = Record<string, unknown>

function str (o:Json, key:string):string {
    const v = o[key] ?? ''
    if (typeof v !== 'string') throw new TypeError(key)
    return v
}

function int (o:Json, key:string):number {
    const v = o[key] ?? 0
    if (!Number.isSafeInteger(v)) throw new TypeError(key)
    return v as number
}

// One index line in the `runs` listing format, or null when the line
// does not decode the way Go's json.Unmarshal would accept.
export function formatRunLine (line:string):string|null {
    try {
        const o:unknown = JSON.parse(line)
        if (o === null) return formatRunLine('{}')
        if (typeof o !== 'object' || Array.isArray(o)) return null
        const r = o as Json
        const quick = r.quick ?? false
        if (typeof quick !== 'boolean') return null
        const files = r.files_reviewed ?? []
        if (!Array.isArray(files) ||
            files.some(f => f !== null && typeof f !== 'string')) {
            return null
        }
        return `${str(r, 'ts')}  ${pad(str(r, 'run_id'), 25)} ` +
            `${pad(str(r, 'mode'), 8)} q=${pad(String(quick), 5)} ` +
            `${pad(str(r, 'assessment'), 30)} ` +
            `findings=${int(r, 'n_findings')} ` +
            `refuted=${int(r, 'n_refuted')} files=${files.length}  ` +
            `${str(r, 'repo')}\n`
    } catch {
        return null
    }
}

// Every index line across the monthly files, oldest first.
async function indexLines (dir:string):Promise<Buffer[]> {
    let names:string[]
    try {
        names = await fs.readdir(dir)
    } catch {
        return []
    }
    const files = names
        .filter(n => n.startsWith('runs-') && n.endsWith('.jsonl'))
        .sort(compareBytes)
    const lines:Buffer[] = []
    for (const name of files) {
        let data:Buffer
        try {
            data = await fs.readFile(path.join(dir, name))
        } catch {
            continue
        }
        lines.push(...scanLines(data))
    }
    return lines
}

async function listHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const limit = parseLimit(args.limit)
    const dir = await recordDir(ctx.cwd, {
        env:ctx.env as NodeJS.ProcessEnv,
        signal:ctx.signal,
    })
    if (!dir) {
        throw new UsageError('cannot resolve record directory: run ' +
            'inside a Git repository')
    }
    let lines = await indexLines(dir)
    if (limit > 0 && lines.length > limit) {
        lines = lines.slice(lines.length - limit)
    }
    if (lines.length === 0) {
        ctx.stderr.write(`roast: no run records in ${dir}\n`)
        return
    }
    if (args.json) {
        for (const line of lines) {
            ctx.stdout.write(Buffer.concat([line, Buffer.from('\n')]))
        }
        return
    }
    for (const line of lines) {
        const out = formatRunLine(line.toString('utf8'))
        if (out !== null) ctx.stdout.write(out)
    }
}

async function showHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const dir = await recordDir(ctx.cwd, {
        env:ctx.env as NodeJS.ProcessEnv,
        signal:ctx.signal,
    })
    // Plain errors (exit 4), including invalid IDs such as `..`.
    const file = await reportPath(dir, String(args['run-id']))
    let content:Buffer
    try {
        content = await fs.readFile(file)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`run has no report artifact: ${msg}`,
            { cause:err })
    }
    ctx.stdout.write(textBytes(content))
}

const showCommand:CommandDef = {
    command:'show <run-id>',
    describe:'Print the stored report of a run',
    handler:showHandler,
}

function errorMessage (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// `runs checkout <run-id> [dir]` (spec 11): restores the run's snapshot
// into a detached linked worktree; stdout carries only its path.
async function checkoutHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const env = ctx.env as NodeJS.ProcessEnv
    const id = String(args['run-id'])
    let meta:Meta
    try {
        const dir = await recordDir(ctx.cwd,
            { env, signal:ctx.signal })
        meta = (await readMeta(dir, id)).meta
    } catch (err) {
        ctx.signal.throwIfAborted()
        throw new UsageError(errorMessage(err), { cause:err })
    }
    if (!meta.snapshot.captured) {
        throw new UsageError(`run ${meta.run_id} has no Git snapshot ` +
            `(${meta.snapshot.reason ?? ''})`)
    }
    let dest:string
    if (args.dir !== undefined) {
        dest = path.resolve(ctx.cwd, String(args.dir))
    } else {
        const tmp = await fs.mkdtemp(
            path.join(os.tmpdir(), 'roast-checkout-'))
        dest = path.join(tmp, meta.run_id)
    }
    try {
        await restore(meta.repo, meta.run_id, dest,
            { env, signal:ctx.signal })
    } catch (err) {
        ctx.signal.throwIfAborted()
        throw new Error(`restore run ${meta.run_id}: ${errorMessage(err)}`,
            { cause:err })
    }
    ctx.stderr.write(`roast: remove with: git -C ${meta.repo} worktree ` +
        `remove --force ${dest}\n`)
    ctx.stdout.write(dest + '\n')
}

const checkoutCommand:CommandDef = {
    command:'checkout <run-id> [dir]',
    describe:'Materialize a run\'s Git snapshot as a linked worktree',
    handler:checkoutHandler,
}

const DEFAULT_OLDER_THAN = '720h'
const NS_PER_MS = 1_000_000n
const NS_PER_HOUR = 3_600_000_000_000n
const MS_PER_HOUR = 3_600_000

function parseOlderThan (raw:unknown):GoDuration {
    const s = raw === undefined ? DEFAULT_OLDER_THAN : String(raw)
    try {
        return parseGoDuration(s)
    } catch (err) {
        throw new UsageError(`invalid argument ${JSON.stringify(s)} for ` +
            `"--older-than" flag: ${errorMessage(err)}`, { cause:err })
    }
}

// Go `age.Round(time.Hour)` (half away from zero), as a Go duration.
function roundedAge (ageMs:number):string {
    const hours = Math.sign(ageMs) * Math.round(Math.abs(ageMs) /
        MS_PER_HOUR)
    return formatGoDuration(BigInt(hours) * NS_PER_HOUR)
}

// `runs prune [--older-than d] [--dry-run]` (spec 11): deletes aged
// snapshot refs; run records are never touched.
async function pruneHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    const olderThan = parseOlderThan(args['older-than'])
    const env = ctx.env as NodeJS.ProcessEnv
    let repo:string
    try {
        repo = await gitRoot(ctx.cwd, { env, signal:ctx.signal })
    } catch (err) {
        ctx.signal.throwIfAborted()
        throw new UsageError(errorMessage(err), { cause:err })
    }
    const dryRun = Boolean(args['dry-run'])
    // Fractional milliseconds keep sub-millisecond thresholds positive.
    const ms = Number(olderThan / NS_PER_MS) +
        Number(olderThan % NS_PER_MS) / 1e6
    const pruned = await prune(repo, ms, dryRun,
        { env, signal:ctx.signal })
    if (pruned.length === 0) {
        ctx.stderr.write('roast: no snapshot refs older than ' +
            `${formatGoDuration(olderThan)}\n`)
        return
    }
    const verb = dryRun ? 'would delete' : 'deleted'
    for (const p of pruned) {
        ctx.stdout.write(`${verb} ${p.ref} (age ${roundedAge(p.ageMs)})\n`)
    }
}

const pruneCommand:CommandDef = {
    command:'prune',
    describe:'Delete old snapshot refs under refs/roast/snapshots/',
    builder:(y:Argv) => y
        .option('older-than', {
            type:'string',
            describe:'Delete snapshot refs at least this old',
            default:undefined,
            defaultDescription:'720h0m0s',
        })
        .option('dry-run', {
            type:'boolean',
            default:false,
            describe:'List refs that would be deleted',
        }),
    handler:pruneHandler,
}

// The `runs` subcommands.
export const runsSubcommands:CommandDef[] = [
    showCommand, checkoutCommand, pruneCommand,
]

export const runsCommand:CommandDef = {
    command:'runs',
    subcommands:runsSubcommands,
    describe:'List past review runs',
    builder:(y:Argv) => y
        .option('limit', {
            type:'string',
            describe:'Show the last N runs (<= 0 for all)',
            default:undefined,
            defaultDescription:String(DEFAULT_LIMIT),
        })
        .option('json', {
            type:'boolean',
            default:false,
            describe:'Print raw index lines',
        }),
    handler:listHandler,
}
