// `roast review`, also the default command: the review orchestration of
// spec 01, 2.8. Snapshot capture is injectable (see snapshot-meta.ts).
import type { Writable } from 'node:stream'
import { buildInfo } from '../buildinfo.js'
import {
    type ProjectConfig,
    credentialEnvNames,
    promptPath,
    snapshotEnabled,
} from '../config/load.js'
import {
    DEFAULT_LIMITS,
    QUICK_DIFF_BYTES,
    QUICK_FILE_CTX_BYTES,
    SURVEY_DEADLINE,
} from '../config/defaults.js'
import { resolveFinderFlip, resolveRole, validateRole }
    from '../config/role.js'
import type { ResolvedRole } from '../config/resolved-role.js'
import { buildFileContext, numberedSnippet } from '../context/snippet.js'
import { newQuoteGrounder } from '../context/grounding.js'
import { explorationTools } from '../context/tools.js'
import {
    LIVE_TREE,
    pinIndexTree,
    pinnedWorktree,
    type Tree,
} from '../context/tree.js'
import { gitRoot } from '../git/git.js'
import {
    type GoDuration,
    formatGoDuration,
    parseGoDuration,
    toMillis,
} from '../gocompat/duration.js'
import { createClient, createModelClient } from '../llm/client.js'
import { type Ledger, committed, newLedger } from '../llm/ledger.js'
import type {
    Client, ClientConfig, Protocol, RawResponse, RecordUsage, Tool,
} from '../llm/types.js'
import { finderSystem, verifierSystem } from '../prompts/index.js'
import { renderFinderUser, renderVerifierUser } from '../prompts/render.js'
import { recordDir } from '../record/dir.js'
import { openFindingSpill } from '../record/findings.js'
import { appendRunLine, seenBefore } from '../record/index-file.js'
import {
    type Meta,
    type RoleMeta,
    captureEnv,
    digest,
    removeRun,
    reportPath,
    resolveRunDir,
    writeArtifact,
    writeMeta,
    writeReport as writeRunReport,
} from '../record/meta.js'
import { rfc3339NanoUTC } from '../record/json.js'
import { ResponseRecorder } from '../record/responses.js'
import { newRunId } from '../record/run-id.js'
import { toJSON, toMarkdown, type Report } from '../render/render.js'
import { writeReport } from '../render/write.js'
import { classifyMode } from '../review/classify.js'
import { find } from '../review/find.js'
import {
    type Finding, type Result, type WireFinding, maxSeverity,
} from '../review/types.js'
import { type VerifiedResult, verify } from '../verify/verify.js'
import { buildBundle } from '../runbundle/bundle.js'
import { build, fit, isEmpty, type BuildOpts } from '../scope/index.js'
import { ExitSignal, UsageError } from './errors.js'
import type { CommandArgs, CommandDef, RunContext } from './command.js'
import { loadProjectConfig } from './config.js'
import { maybeBootstrapGate } from './gate-offer.js'
import { logf } from './log.js'
import {
    DEFAULT_MAX_TURNS,
    SURVEY_MAX_TURNS,
    type ReviewFlags,
    parseReviewFlags,
    reviewBuilder,
    validateReviewFlags,
} from './review-flags.js'
import {
    applyRoleFlags,
    configInt,
    flagOrConfig,
    resolveLangs,
} from './resolve.js'
import {
    type SnapshotDeps,
    type WorktreePin,
    captureSnapshot,
    defaultSnapshotDeps,
} from './snapshot-meta.js'
import { deleteSnapshot, pinWorktree } from '../snapshot/snapshot.js'
import { requireTrust } from './trust.js'
import type { Sleep } from '../llm/retry.js'

const INTERACTIVE_MIN_DIFF_LINES = 80
const INTERACTIVE_MIN_FILES = 4
const VERIFIER_MAX_TURNS = 8
const VERIFIER_SNIPPET_BYTES = 60_000

// Swappable dependencies for in-process review tests.
export const reviewHooks:{
    snapshot:((ctx:RunContext) => SnapshotDeps)|null;
    sleep?:Sleep;
} = { snapshot:null }

// Exit selection after a completed run (spec 01, 2.2): a finalize
// failure wins over the severity gate.
export function reviewExitError (
    finalErr:Error|null,
    gateRank:number,
    maxSev:number,
    partial:boolean
):Error|null {
    if (finalErr) return finalErr
    if (gateRank >= 0 && maxSev >= gateRank) return new ExitSignal(1)
    if (partial) return new ExitSignal(4)
    return null
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

// Config and role failures are usage errors carrying the config area's
// message.
function asUsage<T> (fn:() => T):T {
    try {
        return fn()
    } catch (err) {
        if (err instanceof UsageError) throw err
        throw new UsageError(message(err), { cause:err })
    }
}

function wrap (prefix:string, err:unknown):Error {
    return new Error(`${prefix}: ${message(err)}`, { cause:err })
}

function roleMeta (role:ResolvedRole, system:string):RoleMeta {
    return {
        profile:role.profile,
        base_url:role.baseURL,
        model:role.model,
        protocol:role.protocol,
        max_output_tokens:role.maxOutputTokens,
        session_header:role.sessionHeader,
        prompt_digest:digest(system),
    }
}

function clientConfig (
    name:string,
    role:ResolvedRole,
    capture:(raw:RawResponse) => Promise<void>,
    maxAttempts:number,
    requestTimeout:GoDuration,
    fetch:typeof globalThis.fetch
):ClientConfig {
    return {
        role:name,
        baseUrl:role.baseURL.replace(/\/+$/, ''),
        apiKey:role.apiKey,
        model:role.model,
        protocol:role.protocol as ''|Protocol,
        maxOutputTokens:role.maxOutputTokens,
        sessionHeader:role.sessionHeader,
        maxAttempts,
        requestTimeoutMs:toMillis(requestTimeout),
        captureResponse:capture,
        fetch,
    }
}

function newClient (
    config:ClientConfig,
    ledger:Ledger|null
):Client {
    return createClient(createModelClient(config), {
        ledger, sleep:reviewHooks.sleep,
    })
}

type Format = 'json'|'markdown'|'both'

function streams (ctx:RunContext):{ stdout:Writable, stderr:Writable } {
    return {
        stdout:ctx.stdout as Writable,
        stderr:ctx.stderr as Writable,
    }
}

function countNewlines (s:string):number {
    let n = 0
    for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++
    return n
}

function utf8Bytes (s:string):number {
    return Buffer.byteLength(s, 'utf8')
}

interface Roles {
    finder:ResolvedRole;
    verifier:ResolvedRole;
    doVerify:boolean;
}

function resolveRoles (
    cfg:ProjectConfig,
    f:ReviewFlags,
    ctx:RunContext
):Roles {
    return asUsage(() => {
        let finder = resolveRole(cfg, 'finder', ctx.env)
        let verifier = resolveRole(cfg, 'verifier', ctx.env)
        finder = applyRoleFlags('finder', finder, f.finder, ctx.env)
        verifier = applyRoleFlags('verifier', verifier, f.verifier, ctx.env)
        const flip = resolveFinderFlip(cfg, finder, f.authorModel, ctx.env)
        if (flip.note) logf(ctx.stderr, flip.note)
        if (flip.warn) logf(ctx.stderr, flip.warn)
        finder = flip.role
        validateRole('finder', finder)
        const doVerify = !f.quick && !f.noVerify
        if (doVerify) validateRole('verifier', verifier)
        return { finder, verifier, doVerify }
    })
}

export async function runReview (
    f:ReviewFlags,
    ctx:RunContext
):Promise<void> {
    const gateRank = validateReviewFlags(f)
    const gitOpts = { env:ctx.env as NodeJS.ProcessEnv, signal:ctx.signal }
    const cfg = await loadProjectConfig(f.config, ctx)
    const roles = resolveRoles(cfg, f, ctx)
    const { doVerify } = roles

    let repo:string
    try {
        repo = await gitRoot(ctx.cwd, gitOpts)
    } catch (err) {
        if (ctx.signal.aborted) throw err
        throw new UsageError(message(err), { cause:err })
    }
    await requireTrust(repo, cfg, ctx)

    const survey = f.scope === 'repo'
    const limits = cfg.limits ?? {}
    const excludes = [...(cfg.review.excludes ?? []), ...f.exclude]
    const maxDiff = configInt(limits.max_diff_bytes, f.quick ?
        QUICK_DIFF_BYTES : DEFAULT_LIMITS.max_diff_bytes)
    const buildOpts:BuildOpts = {
        base:f.base,
        uncommittedOnly:f.uncommittedOnly,
        stagedOnly:f.staged,
        paths:f.paths,
        excludes,
        includeVendored:f.includeVendored,
        scope:f.scope,
        maxFileDiffBytes:maxDiff,
        env:gitOpts.env,
    }
    let tree:Tree = LIVE_TREE
    if (f.staged) {
        try {
            tree = await pinIndexTree(repo, ctx.signal, { env:gitOpts.env })
        } catch (err) {
            if (ctx.signal.aborted) throw err
            throw wrap('pin staged tree', err)
        }
        buildOpts.stagedTreeOID = tree.oid
    }
    let sc = await build(repo, buildOpts, ctx.signal)
    for (const note of sc.notes) logf(ctx.stderr, note)

    if (isEmpty(sc)) {
        writeReport(streams(ctx), f.format as Format, f.showDropped, {
            result:{
                assessment:'NO_DIFF', findings:[], dropped:[], notes:[],
            },
            mode:'code',
            filesReviewed:[],
            task:f.task,
        })
        return
    }

    const inputKind = survey ? 'manifest' : 'diff'
    const reviewedInput = survey ?
        Buffer.from(sc.manifest, 'utf8') :
        sc.diffBytes
    const runId = newRunId()
    const indexTree = tree.oid
    let pin:WorktreePin = null
    if (!sc.staged) {
        pin = await pinOrLive(repo, ctx)
        if (pin) tree = pinnedWorktree(pin.tree)
    }
    const snapDeps = reviewHooks.snapshot?.(ctx) ??
        defaultSnapshotDeps(gitOpts)
    const snap = await captureSnapshot(snapshotEnabled(cfg), repo, runId,
        sc, indexTree, pin, snapDeps)
    // Until the run record exists, any exit drops the captured ref so
    // no orphan is left; after that the snapshot is durable.
    let durable = false
    try {
        const ground = newQuoteGrounder(repo, tree, sc.diffBytes, gitOpts)
        const originalDiffBytes = sc.diffBytes.length
        const maxFileContext = configInt(limits.max_file_ctx_bytes, f.quick ?
            QUICK_FILE_CTX_BYTES : DEFAULT_LIMITS.max_file_ctx_bytes)
        const fitted = fit(sc, maxDiff)
        sc = fitted.scope
        const breakdown = fitted.breakdown ?? []

        let mode = f.mode
        if (mode === 'auto') mode = classifyMode([...sc.files])
        if (!['code', 'prose', 'mixed'].includes(mode)) {
            throw new UsageError(`invalid --mode ${JSON.stringify(f.mode)}`)
        }
        const langs = resolveLangs(f.lang, [...sc.files], mode)
        const overrides = cfg.prompts ?? {}
        const finderPrompt = (mode === 'prose' ?
            overrides.finder_prose :
            overrides.finder_code) ?? ''
        let interactive = f.interactive && !f.quick
        let maxTurns = f.maxTurns ?? DEFAULT_MAX_TURNS
        if (survey) {
            interactive = true
            if (f.maxTurns === undefined) maxTurns = SURVEY_MAX_TURNS
        }
        if (interactive && !survey) {
            const minLines = configInt(cfg.interactive?.min_diff_lines,
                INTERACTIVE_MIN_DIFF_LINES)
            const minFiles = configInt(cfg.interactive?.min_files,
                INTERACTIVE_MIN_FILES)
            if (countNewlines(sc.diff) < minLines &&
                sc.files.length < minFiles) {
                logf(ctx.stderr,
                    'diff is small; using a single structured finder call')
                interactive = false
            }
        }
        const system = await finderSystem(mode, f.scope, f.quick, langs,
            promptPath(cfg, finderPrompt), interactive)
        const verifierPrompt = await verifierSystem(
            promptPath(cfg, overrides.verifier ?? ''))
        const user = survey ?
            renderFinderUser({
                task:f.task,
                survey:true,
                manifest:sc.manifest,
                diff:'',
                fileContext:'',
            }) :
            renderFinderUser({
                task:f.task,
                survey:false,
                diff:sc.diff,
                fileContext:await buildFileContext(repo, sc.files,
                    maxFileContext, tree, gitOpts),
                manifest:'',
            })

        const maxTokensTotal = flagOrConfig(f.maxTokensTotal,
            limits.max_total_tokens, DEFAULT_LIMITS.max_total_tokens)
        const maxVerified = flagOrConfig(f.maxVerified, limits.max_verified,
            DEFAULT_LIMITS.max_verified)
        const requestTimeout = flagOrConfig(f.requestTimeout,
            limits.request_timeout,
            parseGoDuration(DEFAULT_LIMITS.request_timeout))
        const maxAttempts = flagOrConfig(f.maxAttempts, limits.max_attempts,
            DEFAULT_LIMITS.max_attempts)
        const ledger = newLedger(maxTokensTotal)
        const deadlineDuration = flagOrConfig(f.deadline, limits.deadline,
            parseGoDuration(survey ? SURVEY_DEADLINE : DEFAULT_LIMITS.deadline))
        const deadline = deadlineDuration > 0n ?
            Date.now() + toMillis(deadlineDuration) :
            undefined
        const promptCeiling = configInt(limits.max_prompt_bytes,
            DEFAULT_LIMITS.max_prompt_bytes)
        const budgets:Record<string, unknown> = {
            deadline_duration:formatGoDuration(deadlineDuration),
            request_timeout:formatGoDuration(requestTimeout),
            max_total_tokens:maxTokensTotal,
            verifier_cap:maxVerified,
            max_turns:maxTurns,
            max_attempts:maxAttempts,
            max_prompt_bytes:promptCeiling,
        }
        const tools:readonly Tool[] = interactive ?
            explorationTools(repo, tree, { env:gitOpts.env }) :
            []
        const floor = f.quick ?
            cfg.review.quick_confidence_floor :
            cfg.review.confidence_floor
        const promptBytes = utf8Bytes(system) + utf8Bytes(user)
        if (promptBytes > promptCeiling) {
            throw new UsageError(`finder prompt is ${promptBytes} bytes, ` +
                `over the ${promptCeiling}-byte ceiling; narrow the review ` +
                'scope or adjust limits.max_diff_bytes, ' +
                'limits.max_file_ctx_bytes, or ' +
                'limits.max_prompt_bytes in the project config')
        }

        const meta:Meta = {
            run_id:runId,
            ts:rfc3339NanoUTC(new Date()),
            repo,
            argv:[...ctx.argv],
            roast:{ version:buildInfo.version, commit:buildInfo.commit },
            scope:{
                kind:f.scope,
                base:sc.base,
                uncommitted_only:f.uncommittedOnly,
                staged_only:f.staged,
                include_vendored:f.includeVendored,
                paths:[...f.paths],
                excludes:[...excludes],
                base_oid:snap.meta.base ?? '',
                merge_base_oid:'',
                head_oid:sc.headOID || (snap.meta.head ?? ''),
                survey:sc.survey,
                staged:sc.staged,
                files:[...sc.files],
            },
            derived:{
                mode,
                langs:[...langs],
                quick:f.quick,
                interactive,
                max_turns:maxTurns,
                confidence_floor:floor,
                do_verify:doVerify,
                task:f.task,
                max_severity:f.maxSeverity,
                max_diff_bytes:maxDiff,
                max_file_ctx_bytes:maxFileContext,
            },
            roles:{
                finder:roleMeta(roles.finder, system),
                verifier:roleMeta(roles.verifier, verifierPrompt),
            },
            snapshot:snap.meta,
            digests:{
                input_kind:inputKind,
                input:digest(reviewedInput),
                input_bytes:reviewedInput.length,
                system_prompt:digest(system),
                user_prompt:digest(user),
            },
            budgets,
            env_names_only:captureEnv(ctx.env as NodeJS.ProcessEnv,
                credentialEnvNames(cfg)),
            caveats:snap.caveats,
        }
        const records = await recordDir(repo, gitOpts)
        await initializeRun(records, meta, {
            input:reviewedInput,
            finder_system:system,
            finder_user:user,
            verifier_system:verifierPrompt,
        })
        durable = true

        const recorder = new ResponseRecorder(records, runId)
        const capture = (raw:RawResponse):Promise<void> => recorder.append(
            raw.role, raw.protocol, raw.model, raw.contentType, raw.body)
        const finder = newClient(clientConfig('finder', roles.finder, capture,
            maxAttempts, requestTimeout, ctx.fetch), ledger)
        logf(ctx.stderr, `finder=${roles.finder.model} ` +
            `profile=${roles.finder.profile} ` +
            `protocol=${roles.finder.protocol} ` +
            `endpoint=${roles.finder.baseURL}`)
        const spill = await openFindingSpill(records, runId)
        const spilled:Promise<void>[] = []
        let found:Result
        try {
            found = await find(finder, {
                system,
                user,
                quick:f.quick,
                confidenceFloor:floor,
                interactive,
                tools,
                maxTurns,
                ground,
                deadline,
                survey,
                capture:spill ?
                    (w:WireFinding) => { spilled.push(spill(w)) } :
                    undefined,
            }, ctx.signal)
        } finally {
            await Promise.all(spilled)
        }

        const usage:Record<string, RecordUsage> = { finder:finder.usage() }
        let partial = found.incomplete === true
        let result:VerifiedResult = found
        if (doVerify && found.findings.length > 0) {
            const verifier = newClient(clientConfig('verifier',
                roles.verifier, capture, maxAttempts, requestTimeout,
                ctx.fetch), ledger)
            logf(ctx.stderr, `verifying ${found.findings.length} ` +
                `finding(s) with ${roles.verifier.model} ` +
                `(profile=${roles.verifier.profile} ` +
                `protocol=${roles.verifier.protocol})`)
            result = await verify(ctx.signal, verifier, found, {
                systemPrompt:verifierPrompt,
                userPrompt:finding => verifierUser(repo, tree, finding,
                    gitOpts),
                tools:explorationTools(repo, tree, { env:gitOpts.env }),
                maxTurns:VERIFIER_MAX_TURNS,
                maxVerified,
                ledger,
                log:line => { ctx.stderr.write(line + '\n') },
            })
            usage.verifier = verifier.usage()
            if (result.findings.some(x => x.verdict?.undecided)) {
                partial = true
            }
        }

        let reviewKind:''|'survey_triage' = ''
        let completion = ''
        let stopReason = ''
        if (survey) {
            reviewKind = 'survey_triage'
            const r = result.stopReason ?? ''
            if (result.incomplete || ['deadline', 'token_budget',
                'budget_exhausted'].includes(r)) {
                completion = 'partial'
                stopReason = r || 'incomplete_no_submission'
            } else {
                completion = 'complete'
                stopReason = 'converged'
                if (result.assessment === 'NO_FINDINGS') {
                    result.assessment = 'NO_FINDINGS_IN_SAMPLED_AREAS'
                }
            }
        }
        const { spent, limit } = committed(ledger)
        if (limit > 0) budgets.ledger_committed_tokens = spent
        const report:Report = {
            result,
            mode,
            filesReviewed:[...sc.files],
            task:f.task,
            runId,
            budgets,
            quick:f.quick,
            verified:doVerify,
            diffTruncated:breakdown.length > 0,
            originalDiffBytes,
            sizeBreakdown:breakdown.map(e => ({ path:e.path, bytes:e.bytes })),
            usage,
            promptPacks:langs,
            reviewKind,
            completion,
            manifestFileCount:sc.files.length,
            stopReason,
        }
        report.prior = await priorNotes(records, repo, result)
        writeReport(streams(ctx), f.format as Format, f.showDropped, report)

        meta.usage = usageMeta(usage)
        meta.budgets = budgets
        let finalErr:Error|null = null
        try {
            await finalizeRun(records, meta, report, repo)
            const file = await reportPath(records, runId).catch(() => '')
            if (file) logf(ctx.stderr, `run ${runId} \u00b7 report ${file}`)
        } catch (err) {
            if (ctx.signal.aborted) throw err
            finalErr = err as Error
        }
        const exit = reviewExitError(finalErr, gateRank, maxSeverity(result),
            partial)
        if (exit) throw exit
    } finally {
        if (snap.meta.captured && !durable) {
            await deleteSnapshot(repo, runId, { env:gitOpts.env })
                .catch(() => {})
        }
    }
}

// The worktree pin every reader uses; null (read live, guarded by the
// context area) when it fails.
async function pinOrLive (
    repo:string,
    ctx:RunContext
):Promise<WorktreePin> {
    try {
        return await pinWorktree(repo, {
            env:ctx.env as NodeJS.ProcessEnv, signal:ctx.signal,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        logf(ctx.stderr, `could not pin the working tree (${message(err)}); ` +
            'reading it live with .git, ignored, and denylisted paths ' +
            'blocked')
        return null
    }
}

async function initializeRun (
    records:string,
    meta:Meta,
    artifacts:Record<string, string|Uint8Array>
):Promise<void> {
    try {
        try {
            await writeMeta(records, meta)
        } catch (err) {
            throw wrap('initialize run record', err)
        }
        for (const [name, content] of Object.entries(artifacts)) {
            try {
                await writeArtifact(records, meta.run_id, name, content)
            } catch (err) {
                throw wrap(`initialize run artifact ${name}`, err)
            }
        }
    } catch (err) {
        if (records) await removeRun(records, meta.run_id).catch(() => {})
        throw err
    }
}

async function finalizeRun (
    records:string,
    meta:Meta,
    report:Report,
    repo:string
):Promise<void> {
    try {
        await writeArtifact(records, meta.run_id, 'result.json',
            toJSON(report))
    } catch (err) {
        throw wrap('finalize run result', err)
    }
    try {
        await writeRunReport(records, meta.run_id, toMarkdown(report, true))
    } catch (err) {
        throw wrap('finalize run report', err)
    }
    try {
        await writeMeta(records, meta)
    } catch (err) {
        throw wrap('finalize run metadata', err)
    }
    let runDir:string
    try {
        runDir = await resolveRunDir(records, meta.run_id)
    } catch (err) {
        throw wrap('resolve run bundle directory', err)
    }
    try {
        buildBundle(runDir)
    } catch (err) {
        throw wrap('build local run bundle', err)
    }
    await appendRunLine(records, report, repo, meta.argv ?? null)
        .catch(() => {})
}

function usageMeta (
    usage:Record<string, RecordUsage>
):NonNullable<Meta['usage']> {
    const out:NonNullable<Meta['usage']> = {}
    for (const [role, u] of Object.entries(usage)) {
        out[role] = {
            uncached_input_tokens:u.uncached_input_tokens,
            cached_input_tokens:u.cached_input_tokens,
            cache_write_tokens:u.cache_write_tokens,
            output_tokens:u.output_tokens,
            calls:u.calls,
        }
    }
    return out
}

function lineRange (lines:readonly number[]|null):string {
    if (!lines?.length) return '?'
    if (lines.length === 1) return String(lines[0])
    return `${lines[0]}-${lines[lines.length - 1]}`
}

// The per-finding verifier message: the claim and the cited file, never
// the finder's reasoning.
async function verifierUser (
    repo:string,
    tree:Tree,
    f:Finding,
    opts:{ env:NodeJS.ProcessEnv, signal:AbortSignal }
):Promise<string> {
    return renderVerifierUser({
        severity:f.severity,
        confidence:f.confidence,
        file:f.file,
        lines:lineRange(f.lines),
        description:f.description,
        codeQuote:f.code_quote,
        fixedCode:f.fixed_code,
        fileSnippet:await numberedSnippet(repo, f.file,
            VERIFIER_SNIPPET_BYTES, tree, opts),
    })
}

async function priorNotes (
    records:string,
    repo:string,
    result:Pick<Result, 'findings'>
):Promise<Map<string, string>|null> {
    const seen = await seenBefore(records, repo, result.findings, 3)
        .catch(() => new Map())
    if (seen.size === 0) return null
    const out = new Map<string, string>()
    for (const [fp, sighting] of seen) {
        let note = `seen previously in run ${sighting.runTS}`
        if (sighting.dropReason) note += ` (dropped: ${sighting.dropReason})`
        out.set(fp, note)
    }
    return out
}

async function insideRepository (ctx:RunContext):Promise<boolean> {
    try {
        await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
        return true
    } catch (err) {
        if (ctx.signal.aborted) throw err
        return false
    }
}

async function reviewHandler (
    args:CommandArgs,
    ctx:RunContext
):Promise<void> {
    await maybeBootstrapGate(ctx)
    const explicit = ctx.path.length > 0
    if (!explicit && !(await insideRepository(ctx))) {
        ctx.stderr.write('roast: not in a Git repository; cd into one to ' +
            'review, or try `roast doctor` / `roast --help`\n')
        ctx.stdout.write(await ctx.rootHelp())
        return
    }
    await runReview(parseReviewFlags(args, ctx.argv), ctx)
}

export const reviewCommand:CommandDef = {
    command:['review', '$0'],
    describe:'Review the current changes (the default command)',
    builder:reviewBuilder,
    handler:reviewHandler,
}
