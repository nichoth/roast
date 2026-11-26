// pattern: Imperative Shell
// Sequential setup diagnostics, with network probes gated by clone trust.
import { buildInfo, formatBuildInfo } from '../buildinfo.js'
import path from 'node:path'
import { z } from 'zod'
import { createClient, createModelClient } from '../llm/client.js'
import { hasSentinel } from '../llm/errors.js'
import { newSessionId } from '../llm/session.js'
import { loadProjectConfig, projectConfigPath, NO_PROJECT_CONFIG }
    from './config.js'
import { trustProjection, requiresApproval, trustHash }
    from '../config/trust.js'
import { isApproved } from '../trust/trust.js'
import { gitRoot } from '../git/git.js'
import type { ProjectConfig } from '../config/load.js'
import {
    resolveRole, validateRole, type RoleName, type ResolvedRole,
} from '../config/role.js'
import { describeSource } from '../config/credential.js'
import { goTrimSpace } from '../gocompat/strings.js'
import { abortable } from '../llm/capture.js'
import { lstat } from 'node:fs/promises'
import { openCredentialStore, loadCredentials }
    from '../credentials/credentials.js'
import { inspect as inspectGate, summary, isActive } from '../gate/hook.js'
import {
    inspect as inspectSkill, installationTargets,
    type InstallationTarget
} from '../skill/skill.js'
import type { CommandDef, RunContext } from './command.js'

export type DoctorStatus = 'pass'|'warn'|'fail'

export interface DoctorResult {
    name:string;
    status:DoctorStatus;
    detail:string;
}

export const doctorHooks = {
    timeout:(ms:number):AbortSignal => AbortSignal.timeout(ms),
}

function message (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

async function doctorTrustCheck (
    cfg:ProjectConfig,
    ctx:RunContext
):Promise<DoctorResult> {
    const projection = trustProjection(cfg)
    const name = 'config-trust'
    if (!requiresApproval(projection)) {
        return {
            name,
            status:'pass',
            detail:'no approval required ' +
                '(default provider endpoints and key variables only)'
        }
    }
    let repo:string
    try {
        repo = await gitRoot(ctx.cwd, ctx)
    } catch {
        return {
            name,
            status:'fail',
            detail:'approval required but not ' +
                'granted: not inside a Git repository'
        }
    }
    try {
        const state = await isApproved(repo, trustHash(projection), ctx)
        if (state === 'approved') {
            return {
                name,
                status:'pass',
                detail:'approval required and ' +
                    'granted for this clone'
            }
        }
        const why = state === 'legacy' ?
            'approval required; approved by an older Roast' :
            'approval required and not granted'
        return {
            name,
            status:'fail',
            detail:why +
                '; endpoint probes skipped; run `npx roast trust`'
        }
    } catch (err) {
        return {
            name,
            status:'fail',
            detail:'approval required; could ' +
                `not read approvals: ${message(err)}`
        }
    }
}

async function discardModelsBody (
    response:Response,
    signal:AbortSignal
):Promise<void> {
    if (!response.body) return
    const reader = response.body.getReader()
    let size = 0
    try {
        while (size < 32 * 1024) {
            const chunk = await abortable(reader.read(), signal)
            if (chunk.done) return
            size += chunk.value.byteLength
        }
    } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

export async function doctorEndpointCheck (
    name:RoleName,
    resolved:ResolvedRole,
    ctx:RunContext
):Promise<DoctorResult> {
    const url = resolved.baseURL.replace(/\/+$/, '') + '/models'
    const result:DoctorResult = {
        name:`${name}-endpoint`, status:'fail', detail:'',
    }
    if (!URL.canParse(url)) {
        return { ...result, detail:'invalid models endpoint: invalid URL' }
    }
    const signal = AbortSignal.any([
        ctx.signal, doctorHooks.timeout(5000),
    ])
    try {
        const response = await ctx.fetch(url, {
            method:'GET',
            redirect:'manual',
            signal,
            headers:resolved.protocol === 'anthropic' ? {
                'x-api-key':resolved.apiKey,
                'anthropic-version':'2023-06-01',
            } : { Authorization:`Bearer ${resolved.apiKey}` },
        })
        await discardModelsBody(response, signal)
        const status = `HTTP ${response.status} ${response.statusText}`.trim()
        if (response.ok) {
            result.status = 'pass'
            result.detail = `GET ${url}: ${status}`
        } else if (response.status >= 300 && response.status < 400) {
            result.detail = `GET ${url}: redirect refused (${status})`
        } else if (response.status === 401 || response.status === 403) {
            result.detail = `credential rejected by ${url}: ${status}`
        } else if (response.status >= 500) {
            result.detail = `${url} returned ${status}`
        } else {
            result.status = 'warn'
            result.detail = 'endpoint is reachable but model listing ' +
                `returned ${status}`
        }
    } catch (err) {
        if (ctx.signal.aborted) throw err
        result.detail = `GET ${url}: ${message(err)}`
    }
    if (resolved.apiKey) {
        result.detail = result.detail.replaceAll(resolved.apiKey,
            '[redacted]')
    }
    return result
}

const probeResult = z.object({ ok:z.boolean(), token:z.string() })

export async function doctorRoundtripCheck (
    name:RoleName,
    resolved:ResolvedRole,
    ctx:RunContext
):Promise<DoctorResult> {
    const result:DoctorResult = {
        name:`${name}-roundtrip`, status:'fail', detail:'',
    }
    const signal = AbortSignal.any([
        ctx.signal, doctorHooks.timeout(35000),
    ])
    try {
        const protocol = resolved.protocol
        if (protocol !== 'chat' && protocol !== 'responses' &&
            protocol !== 'anthropic') {
            throw new Error(`unsupported inference protocol "${protocol}"`)
        }
        const limit = resolved.maxOutputTokens
        const client = createClient(createModelClient({
            role:name,
            baseUrl:resolved.baseURL,
            apiKey:resolved.apiKey,
            model:resolved.model,
            protocol,
            maxOutputTokens:limit > 0 && limit <= 512 ? limit : 512,
            sessionHeader:resolved.sessionHeader,
            maxAttempts:1,
            requestTimeoutMs:15000,
            fetch:ctx.fetch,
        }))
        const token = `roast-doctor-${newSessionId().slice(6)}`
        let looked = false
        const output = await client.converse(
            'This is a connectivity check. Call doctor_lookup once, then ' +
                'call doctor_probe with ok=true and the token ' +
                'doctor_lookup returned.',
            'Run the check now.', {
                tools:[{
                    name:'doctor_lookup',
                    description:'Return the diagnostic token.',
                    schema:{
                        type:'object',
                        properties:{},
                        additionalProperties:false,
                    },
                    run:() => {
                        looked = true
                        return { token }
                    },
                }, {
                    name:'doctor_probe',
                    description:'Return the diagnostic result.',
                    schema:{
                        type:'object',
                        properties:{
                            ok:{ type:'boolean' }, token:{ type:'string' },
                        },
                        required:['ok', 'token'],
                        additionalProperties:false,
                    },
                }],
                finalTool:'doctor_probe',
                final:{ decode:value => probeResult.parse(value) },
                maxTurns:2,
            }, signal)
        if (!output.ok) {
            result.detail = 'doctor_probe returned ok=false'
        } else if (!looked || output.token !== token) {
            result.detail = 'doctor_probe did not return the token from ' +
                'doctor_lookup; the tool result did not round-trip'
        } else {
            result.status = 'pass'
            result.detail = `${resolved.model} via ${resolved.protocol} ` +
                '(two-turn tool loop)'
        }
    } catch (err) {
        if (ctx.signal.aborted) throw err
        result.detail = hasSentinel(err, 'auth') ?
            'credential rejected by the configured inference route' :
            `${resolved.protocol}/${resolved.model} two-turn tool probe ` +
                `failed: ${message(err)}`
    }
    if (resolved.apiKey) {
        result.detail = result.detail.replaceAll(resolved.apiKey,
            '[redacted]')
    }
    return result
}

async function doctorRoleChecks (
    cfg:ProjectConfig,
    trusted:boolean,
    ctx:RunContext
):Promise<DoctorResult[]> {
    const results:DoctorResult[] = []
    for (const name of ['finder', 'verifier'] as const) {
        let resolved:ResolvedRole
        try {
            resolved = resolveRole(cfg, name, ctx.env)
        } catch (err) {
            results.push({
                name:`${name}-profile`, status:'fail', detail:message(err),
            })
            continue
        }
        const source = describeSource(resolved.credential)
        results.push({
            name:`${name}-credential`,
            status:goTrimSpace(resolved.apiKey) ? 'pass' : 'fail',
            detail:source,
        })
        try {
            validateRole(name, resolved)
        } catch (err) {
            results.push({
                name:`${name}-profile`, status:'fail', detail:message(err),
            })
            continue
        }
        results.push({
            name:`${name}-profile`,
            status:'pass',
            detail:`${resolved.profile}: ${resolved.model} via ` +
                `${resolved.protocol} at ${resolved.baseURL} with ` +
                `credential ${source}` + (resolved.sessionHeader ?
                `, session header ${resolved.sessionHeader}` : ''),
        })
        if (!trusted) continue
        results.push(await doctorEndpointCheck(name, resolved, ctx))
        results.push(await doctorRoundtripCheck(name, resolved, ctx))
    }
    return results
}

export async function doctorChecks (
    explicit:string,
    ctx:RunContext
):Promise<DoctorResult[]> {
    const results:DoctorResult[] = [{
        name:'build',
        status:buildInfo.version === 'dev' ? 'warn' : 'pass',
        detail:formatBuildInfo(buildInfo) +
            (buildInfo.version === 'dev' ? '; development build' : ''),
    }]
    let file = ''
    try {
        file = await projectConfigPath(explicit, ctx)
        if (!file) throw new Error(NO_PROJECT_CONFIG)
        results.push({ name:'config-file', status:'pass', detail:file })
    } catch (err) {
        results.push({
            name:'config-file',
            status:'fail',
            detail:message(err)
        })
    }
    let cfg:ProjectConfig|undefined
    if (file) {
        try {
            cfg = await loadProjectConfig(path.resolve(ctx.cwd, file), ctx)
            results.push({
                name:'config',
                status:'pass',
                detail:`schema version ${cfg.version}`
            })
        } catch (err) {
            results.push({
                name:'config',
                status:'fail',
                detail:message(err)
            })
        }
    }
    if (cfg) {
        const trust = await doctorTrustCheck(cfg, ctx)
        results.push(trust)
        results.push(...await doctorRoleChecks(cfg,
            trust.status === 'pass', ctx))
    }
    let repo = ''
    try {
        repo = await gitRoot(ctx.cwd, ctx)
        results.push({ name:'git', status:'pass', detail:repo })
    } catch (err) {
        if (ctx.signal.aborted) throw err
        results.push({
            name:'git',
            status:'warn',
            detail:'not inside a Git repository'
        })
    }
    if (repo) {
        try {
            const gate = await inspectGate(repo, ctx.env)
            results.push({
                name:'git-gate',
                status:gate.stale ||
                    (gate.decision === 'enabled' && !isActive(gate)) ?
                    'warn' : 'pass',
                detail:summary(gate)
            })
        } catch (err) {
            results.push({
                name:'git-gate',
                status:'warn',
                detail:message(err)
            })
        }
    }
    const store = await openCredentialStore(ctx.cwd, ctx.env, ctx)
    for (const scope of ['project', 'user'] as const) {
        const file = store.paths[scope]
        if (!file) continue
        try {
            await lstat(file)
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
            // Let the credential loader report other filesystem errors.
        }
        const name = `${scope}-credentials`
        try {
            const entries = await loadCredentials(file)
            const providers = [...entries.keys()].sort().join(', ')
            results.push({
                name,
                status:'pass',
                detail:`${file} (${providers || 'none stored'})`
            })
        } catch (err) {
            results.push({ name, status:'fail', detail:message(err) })
        }
    }
    const variable = ctx.env.HTTPS_PROXY ? 'HTTPS_PROXY' :
        ctx.env.https_proxy ? 'https_proxy' : ''
    const honored = ctx.env.NODE_USE_ENV_PROXY === '1'
    results.push({
        name:'proxy-env',
        status:variable && !honored ? 'warn' : 'pass',
        detail:!variable ? 'no proxy configured' : honored ?
            'proxy variables honored (NODE_USE_ENV_PROXY=1)' :
            `${variable} is set but NODE_USE_ENV_PROXY is not; ` +
                'Node ignores proxy variables unless NODE_USE_ENV_PROXY=1',
    })
    let targets:InstallationTarget[] = []
    try {
        targets = await installationTargets('', '', { env:ctx.env })
    } catch (err) {
        results.push({
            name:'agent-skills',
            status:'warn',
            detail:message(err)
        })
    }
    for (const target of targets) {
        const name = `${target.harness}-skill`
        try {
            const skill = await inspectSkill(target.path)
            switch (skill.state) {
                case 'not_installed':
                    results.push({
                        name,
                        status:'warn',
                        detail:'not installed; run ' +
                            '`roast skill install --global`'
                    })
                    break
                case 'stale':
                    results.push({
                        name,
                        status:'warn',
                        detail:'stale; run ' +
                            '`roast skill install --global --force`'
                    })
                    break
                default:
                    results.push({
                        name,
                        status:'pass',
                        detail:target.path +
                            (skill.state === 'symlink' ?
                                ' (development symlink)' : '')
                    })
            }
        } catch (err) {
            results.push({ name, status:'warn', detail:message(err) })
        }
    }
    return results
}

export const doctorCommand:CommandDef = {
    command:'doctor',
    describe:'Check configuration, providers, and local integration',
    builder:y => y
        .option('config', {
            type:'string',
            default:'',
            describe:'project config file (default: nearest .roast.jsonc ' +
                'up to the Git toplevel)',
        })
        .option('json', {
            type:'boolean', default:false, describe:'emit a JSON array',
        }),
    async handler (args, ctx) {
        const results = await doctorChecks(String(args.config), ctx)
        if (args.json) {
            ctx.stdout.write(JSON.stringify(results, null, 2) + '\n')
        } else {
            for (const result of results) {
                ctx.stdout.write(result.status.toUpperCase().padEnd(5) +
                    ` ${result.name.padEnd(18)} ${result.detail}\n`)
            }
        }
        if (results.some(result => result.status === 'fail')) {
            throw new Error('one or more doctor checks failed')
        }
    },
}
