// pattern: Imperative Shell
import fs from 'node:fs/promises'
import path from 'node:path'
import {
    starter, starterFromModels, UnplaceableModelError,
    choiceFromModel, otherProvider, placeModel,
    isCustomChoice,
    type RoleChoice, type CustomChoice, type StarterChoice,
} from '../config/starter.js'
import { roleKeyVar } from '../config/credential.js'
import { endpointProblem, PROTOCOLS } from '../config/endpoint.js'
import { SUGGESTED_MODELS } from '../config/defaults.js'
import { PROJECT_CONFIG_NAME } from '../config/load.js'
import {
    addProjectIgnoreEntries, PROJECT_IGNORE_ENTRY,
} from '../credentials/project-ignore.js'
import { gitRoot } from '../git/git.js'
import { goTrimSpace } from '../gocompat/strings.js'
import type { CommandDef, RunContext } from './command.js'
import { loadProjectConfig } from './config.js'
import { UsageError } from './errors.js'
import { ensureStateIgnored, STATE_IGNORE_ENTRY } from './ignore.js'
import {
    loginPath, loginProvider, providersNeedingLogin,
} from './login.js'
import {
    requiresApproval, trustProjection,
    trustHash,
} from '../config/trust.js'
import { approve } from '../trust/trust.js'
import { writeTrustSummary } from './trust.js'
import {
    interactiveTerminals, promptYesDefault, promptNoDefault,
    type LineReader,
} from './terminal.js'

async function ignoreProjectFiles (
    repo:string, ctx:RunContext
):Promise<void> {
    const state = await ensureStateIgnored(repo)
    if (state.added) {
        ctx.stdout.write(`added ${STATE_IGNORE_ENTRY} to ${state.path}\n`)
    }
    const credentials = await addProjectIgnoreEntries(repo)
    if (credentials.added) {
        ctx.stdout.write(`added ${PROJECT_IGNORE_ENTRY} rules to ` +
            `${credentials.path}\n`)
    }
}

export async function offerLogin (
    file:string, ctx:RunContext
):Promise<void> {
    try {
        const cfg = await loadProjectConfig(file, ctx)
        const providers = providersNeedingLogin(cfg, ctx.env)
        if (providers.length === 0) return
        if (!interactiveTerminals(ctx.stdin, ctx.stderr)) {
            ctx.stderr.write('run `npx roast login` to store an API key ' +
                'for each provider the config uses\n')
            return
        }
        const target = await loginPath(false, ctx)
        for (const provider of providers) {
            const yes = await promptYesDefault(ctx.stderr, ctx.lines,
                `Log in to ${provider.name} now?`)
            if (!yes) continue
            try {
                await loginProvider(provider,
                    { global:false, noBrowser:false }, target, ctx)
            } catch (err) {
                ctx.stderr.write(`login to ${provider.name} failed: ` +
                    `${String(err)}\n`)
            }
        }
    } catch (err) {
        ctx.stderr.write(`skipping login: ${String(err)}\n`)
    }
}

const CUSTOM_ENTRY = 'custom'

const PROVIDER_MENU = [
    { num:'1', name:'anthropic' },
    { num:'2', name:'openai' },
    { num:'3', name:'openrouter' },
    { num:'4', name:CUSTOM_ENTRY },
]

function suggestedModel (
    provider:string,
    otherChoice?:RoleChoice
):string {
    if (provider === 'openrouter') {
        return otherChoice?.provider === 'anthropic' ?
            SUGGESTED_MODELS.openrouter[1] :
            SUGGESTED_MODELS.openrouter[0]
    }
    return SUGGESTED_MODELS[
        provider as 'anthropic'|'openai'
    ] ?? ''
}

function defaultProvider (
    role:'finder'|'verifier',
    otherChoice?:StarterChoice
):string {
    if (role === 'finder') return 'openai'
    if (otherChoice && isCustomChoice(otherChoice)) {
        return CUSTOM_ENTRY
    }
    return otherChoice ?
        otherProvider(
            (otherChoice as RoleChoice).provider
        ) : 'anthropic'
}

function parseProviderInput (input:string):string|null {
    const trimmed = goTrimSpace(input).toLowerCase()
    if (trimmed === '') return null
    const byNum = PROVIDER_MENU.find(p => p.num === trimmed)
    if (byNum) return byNum.name
    const byName = PROVIDER_MENU.find(p => p.name === trimmed)
    if (byName) return byName.name
    return null
}

async function promptProvider (
    out:NodeJS.WritableStream,
    lines:LineReader,
    role:'finder'|'verifier',
    otherChoice?:StarterChoice
):Promise<string|null> {
    const def = defaultProvider(role, otherChoice)
    const menu = PROVIDER_MENU.map(p =>
        `  ${p.num}. ${p.name}${p.name === def ?
            ' (default)' : ''}`
    ).join('\n')
    for (;;) {
        out.write(
            `\n${role} provider:\n${menu}\n` +
            `Choose [${def}]: `
        )
        const answer = await lines.readLine()
        if (answer === null) return null
        const trimmed = goTrimSpace(answer)
        if (trimmed === '') return def
        const provider = parseProviderInput(trimmed)
        if (provider) return provider
        out.write(
            'invalid choice; enter a number (1-' +
            `${PROVIDER_MENU.length}) or a provider name\n`
        )
    }
}

async function promptModel (
    out:NodeJS.WritableStream,
    lines:LineReader,
    role:'finder'|'verifier',
    provider:string,
    otherChoice?:RoleChoice
):Promise<string|null> {
    const suggested = suggestedModel(provider, otherChoice)
    for (;;) {
        out.write(`${role} model [${suggested}]: `)
        const answer = await lines.readLine()
        if (answer === null) return null
        const trimmed = goTrimSpace(answer)
        if (trimmed === '') return suggested
        const placed = placeModel(trimmed)
        if (placed === provider) return trimmed
        out.write(
            `model does not place onto ${provider}; ` +
            'use a model ID for that provider\n'
        )
    }
}

function hasWhitespaceOrControl (s:string):boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c <= 0x20 || c === 0x7f) return true
    }
    return false
}

const KEY_VAR_RE = /^[A-Z_][A-Z0-9_]*$/

async function promptCustomEndpoint (
    out:NodeJS.WritableStream,
    lines:LineReader,
    role:'finder'|'verifier',
    otherChoice?:StarterChoice
):Promise<CustomChoice|null> {
    const defaults = otherChoice &&
        isCustomChoice(otherChoice) ? otherChoice : null

    let endpoint:string
    const defEndpoint = defaults?.endpoint ?? ''
    for (;;) {
        const hint = defEndpoint ?
            ` [${defEndpoint}]` : ''
        out.write(`endpoint URL${hint}: `)
        const answer = await lines.readLine()
        if (answer === null) return null
        const trimmed = goTrimSpace(answer)
        if (trimmed === '' && defEndpoint) {
            endpoint = defEndpoint
            break
        }
        const problem = endpointProblem(
            role, trimmed, 'chat', 1
        )
        if (!problem) { endpoint = trimmed; break }
        out.write(problem + '\n')
    }

    let protocol:string
    const defProtocol = defaults?.protocol ?? 'chat'
    for (;;) {
        out.write(`protocol [${defProtocol}]: `)
        const answer = await lines.readLine()
        if (answer === null) return null
        const trimmed = goTrimSpace(answer)
        if (trimmed === '') { protocol = defProtocol; break }
        if ((PROTOCOLS as readonly string[]).includes(
            trimmed
        )) {
            protocol = trimmed
            break
        }
        out.write(
            'protocol must be chat, responses, ' +
            'or anthropic\n'
        )
    }

    let apiKeyEnv:string
    const defKey = defaults?.apiKeyEnv ?? ''
    const keyHint = defKey ? ` [${defKey}]` : ''
    for (;;) {
        out.write(
            `key variable name${keyHint} ` +
            '(blank for role default): '
        )
        const answer = await lines.readLine()
        if (answer === null) return null
        const trimmed = goTrimSpace(answer)
        if (trimmed === '' && defKey) {
            apiKeyEnv = defKey; break
        }
        if (trimmed === '') { apiKeyEnv = ''; break }
        if (KEY_VAR_RE.test(trimmed)) {
            apiKeyEnv = trimmed; break
        }
        out.write(
            'key variable must match ' +
            '[A-Z_][A-Z0-9_]*\n'
        )
    }

    let model:string
    for (;;) {
        out.write(`${role} model: `)
        const modelAnswer = await lines.readLine()
        if (modelAnswer === null) return null
        const trimmed = goTrimSpace(modelAnswer)
        if (trimmed === '') { model = ''; break }
        if (hasWhitespaceOrControl(trimmed)) {
            out.write(
                'model must not contain whitespace ' +
                'or control characters\n'
            )
            continue
        }
        model = trimmed
        break
    }

    return {
        kind:'custom',
        endpoint,
        protocol,
        apiKeyEnv,
        model,
    }
}

async function promptRoleChoice (
    out:NodeJS.WritableStream,
    lines:LineReader,
    role:'finder'|'verifier',
    otherChoice?:StarterChoice
):Promise<StarterChoice|null> {
    const provider = await promptProvider(
        out, lines, role, otherChoice
    )
    if (provider === null) return null
    if (provider === CUSTOM_ENTRY) {
        return promptCustomEndpoint(
            out, lines, role, otherChoice
        )
    }
    const model = await promptModel(
        out, lines, role, provider,
        otherChoice && !isCustomChoice(otherChoice) ?
            otherChoice : undefined
    )
    if (model === null) return null
    return { provider, model }
}

function sameSetup (
    a:StarterChoice, b:StarterChoice
):boolean {
    if (a.model !== b.model) return false
    if (isCustomChoice(a) && isCustomChoice(b)) {
        return a.endpoint === b.endpoint &&
            a.protocol === b.protocol
    }
    if (isCustomChoice(a) || isCustomChoice(b)) return false
    return a.provider === b.provider
}

async function offerTrust (
    file:string, repo:string, ctx:RunContext
):Promise<void> {
    try {
        const cfg = await loadProjectConfig(file, ctx)
        const p = trustProjection(cfg)
        if (!requiresApproval(p)) return
        if (!interactiveTerminals(ctx.stdin, ctx.stderr)) {
            ctx.stderr.write(
                'run `npx roast trust` to approve ' +
                'the config\n'
            )
            return
        }
        writeTrustSummary(ctx.stderr, p)
        if (!await promptNoDefault(
            ctx.stderr, ctx.lines,
            'Trust this project config?'
        )) {
            ctx.stderr.write(
                'run `npx roast trust` later to ' +
                'approve\n'
            )
            return
        }
        await approve(repo, trustHash(p), {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
        ctx.stderr.write(
            'Approved for this clone.\n'
        )
    } catch (err) {
        ctx.stderr.write(
            `trust: ${String(err)}\n`
        )
    }
}

export async function writeStarterFromChoices (
    cwd:string,
    finder:StarterChoice,
    verifier:StarterChoice
):Promise<string> {
    const file = path.resolve(cwd, PROJECT_CONFIG_NAME)
    const body = starter(finder, verifier)
    let handle:fs.FileHandle
    try {
        handle = await fs.open(file, 'wx', 0o644)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new UsageError(`${file} already exists; edit it, ` +
                'or remove it to start over', { cause:err })
        }
        throw new Error(`create ${file}: ${String(err)}`, { cause:err })
    }
    try {
        await handle.writeFile(body)
    } catch (err) {
        await handle.close().catch(() => {})
        throw new Error(`write ${file}: ${String(err)}`, { cause:err })
    }
    try {
        await handle.close()
    } catch (err) {
        throw new Error(`close ${file}: ${String(err)}`, { cause:err })
    }
    return file
}

export async function writeStarter (
    cwd:string, finderModel:string, verifierModel:string
):Promise<string> {
    const file = path.resolve(cwd, PROJECT_CONFIG_NAME)
    let body:string
    try {
        body = starterFromModels(finderModel, verifierModel)
    } catch (err) {
        if (!(err instanceof UnplaceableModelError)) throw err
        throw new UsageError(`--${err.role}-model: ${err.message}`,
            { cause:err })
    }
    let handle:fs.FileHandle
    try {
        handle = await fs.open(file, 'wx', 0o644)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new UsageError(`${file} already exists; edit it, ` +
                'or remove it to start over', { cause:err })
        }
        throw new Error(`create ${file}: ${String(err)}`, { cause:err })
    }
    try {
        await handle.writeFile(body)
    } catch (err) {
        await handle.close().catch(() => {})
        throw new Error(`write ${file}: ${String(err)}`, { cause:err })
    }
    try {
        await handle.close()
    } catch (err) {
        throw new Error(`close ${file}: ${String(err)}`, { cause:err })
    }
    return file
}

export const initCommand:CommandDef = {
    command:'init',
    describe:'Write a starter .roast.jsonc in the working directory',
    builder:y => y
        .option('finder-model', {
            type:'string',
            default:'',
            describe:'Finder model ID (default: a placeholder to edit)'
        })
        .option('verifier-model', {
            type:'string',
            default:'',
            describe:'Verifier model ID (default: a placeholder to edit)'
        })
        .option('no-login', {
            type:'boolean',
            default:false,
            describe:'Do not offer to log in to the config providers'
        }),
    handler:async (args, ctx) => {
        let repo:string
        try {
            repo = await gitRoot(ctx.cwd, {
                env:ctx.env as NodeJS.ProcessEnv, signal:ctx.signal,
            })
        } catch (err) {
            if (ctx.signal.aborted) throw err
            throw new UsageError(String(err), { cause:err })
        }
        const configPath = path.resolve(
            ctx.cwd, PROJECT_CONFIG_NAME
        )
        try {
            await fs.access(configPath)
            throw new UsageError(
                `${configPath} already exists; edit it, ` +
                'or remove it to start over'
            )
        } catch (err) {
            if (err instanceof UsageError) throw err
        }
        const finderFlag = goTrimSpace(
            args['finder-model'] as string
        )
        const verifierFlag = goTrimSpace(
            args['verifier-model'] as string
        )
        const interactive = interactiveTerminals(
            ctx.stdin, ctx.stderr
        )
        const needFinderPrompt = !finderFlag && interactive
        const needVerifierPrompt = !verifierFlag && interactive
        if (!interactive && (!finderFlag || !verifierFlag)) {
            const hints:string[] = []
            if (!finderFlag) hints.push('--finder-model')
            if (!verifierFlag) hints.push('--verifier-model')
            ctx.stderr.write(
                'no interactive terminal; pass ' +
                hints.join(' and ') +
                ' to set models\n'
            )
        }
        let finderChoice:StarterChoice
        let verifierChoice:StarterChoice
        if (needFinderPrompt || needVerifierPrompt) {
            if (needFinderPrompt) {
                const choice = await promptRoleChoice(
                    ctx.stderr, ctx.lines, 'finder'
                )
                if (choice === null) return
                finderChoice = choice
            } else {
                try {
                    finderChoice = choiceFromModel(
                        'finder', finderFlag
                    )
                } catch (err) {
                    if (err instanceof UnplaceableModelError) {
                        throw new UsageError(
                            `--finder-model: ${err.message}`,
                            { cause:err }
                        )
                    }
                    throw err
                }
            }
            if (needVerifierPrompt) {
                const choice = await promptRoleChoice(
                    ctx.stderr, ctx.lines, 'verifier',
                    finderChoice!
                )
                if (choice === null) return
                verifierChoice = choice
            } else {
                try {
                    const other = isCustomChoice(finderChoice!) ?
                        undefined : finderChoice! as RoleChoice
                    verifierChoice = choiceFromModel(
                        'verifier', verifierFlag, other
                    )
                } catch (err) {
                    if (err instanceof UnplaceableModelError) {
                        throw new UsageError(
                            '--verifier-model: ' +
                            err.message,
                            { cause:err }
                        )
                    }
                    throw err
                }
            }
            if (sameSetup(finderChoice!, verifierChoice!)) {
                ctx.stderr.write(
                    '\nnote: both roles use the same model' +
                    ' -- verification adds little in ' +
                    'that setup\n'
                )
            }
            const file = await writeStarterFromChoices(
                ctx.cwd, finderChoice!, verifierChoice!
            )
            ctx.stdout.write(`wrote ${file}\n`)
            await ignoreProjectFiles(repo, ctx)
            for (const [role, choice] of [
                ['finder', finderChoice!],
                ['verifier', verifierChoice!],
            ] as const) {
                if (isCustomChoice(choice)) {
                    const varName = choice.apiKeyEnv ||
                        roleKeyVar(role)
                    ctx.stderr.write(
                        `export ${varName} to supply ` +
                        `the ${role} credential\n`
                    )
                }
            }
            if (!args['no-login']) {
                await offerLogin(file, ctx)
            }
            await offerTrust(file, repo, ctx)
        } else {
            let file:string
            try {
                file = await writeStarter(
                    ctx.cwd, finderFlag, verifierFlag
                )
            } catch (err) {
                if (err instanceof UsageError) throw err
                throw err
            }
            ctx.stdout.write(`wrote ${file}\n`)
            await ignoreProjectFiles(repo, ctx)
            if (!args['no-login']) {
                await offerLogin(file, ctx)
            }
        }
    },
}
