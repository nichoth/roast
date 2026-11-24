// How the CLI finds and loads the project config (spec 02, 2.2). Every
// command loads it through loadProjectConfig; failures are usage errors.
import { gitRoot } from '../git/git.js'
import { openCredentialStore } from '../credentials/credentials.js'
import {
    type ProjectConfig,
    findConfig,
    loadConfig,
    withStoredCredentials,
} from '../config/load.js'
import type { RunContext } from './command.js'
import { UsageError } from './errors.js'

export const NO_PROJECT_CONFIG = 'no project config (.roast.json) found ' +
    'between here and the Git toplevel; run `npx roast init` to create one'

export const NO_GATE_CONFIG = 'the pre-commit gate runs from the Git ' +
    'toplevel and finds no .roast.json there; put the project config at ' +
    'the toplevel (`npx roast init`) before enabling the gate'

type ConfigContext = Pick<RunContext, 'cwd'|'env'|'signal'>

function usage (err:unknown):UsageError {
    const message = err instanceof Error ? err.message : String(err)
    return new UsageError(message, { cause:err })
}

// The config path: `explicit` (--config) unchanged when set, else the
// nearest .roast.json from the working directory up to the Git toplevel
// (the working directory itself outside a repository). '' when none.
export async function projectConfigPath (
    explicit:string,
    ctx:ConfigContext
):Promise<string> {
    if (explicit !== '') return explicit
    let stop = ctx.cwd
    try {
        stop = await gitRoot(ctx.cwd, {
            env:ctx.env as NodeJS.ProcessEnv,
            signal:ctx.signal,
        })
    } catch (err) {
        if (ctx.signal.aborted) throw err
    }
    return findConfig(ctx.cwd, stop)
}

// The config the pre-commit hook sees: only <toplevel>/.roast.json.
export function gateConfigPath (repo:string):string {
    return findConfig(repo, repo)
}

export async function loadProjectConfig (
    explicit:string,
    ctx:ConfigContext
):Promise<ProjectConfig> {
    let file:string
    try {
        file = await projectConfigPath(explicit, ctx)
    } catch (err) {
        if (ctx.signal.aborted) throw err
        throw usage(err)
    }
    if (file === '') throw new UsageError(NO_PROJECT_CONFIG)
    let cfg:ProjectConfig
    try {
        cfg = loadConfig(file)
    } catch (err) {
        throw usage(err)
    }
    // Every loaded config carries the stored-credentials store for the
    // working directory; roles read its files only when they reach the
    // stored step.
    const stored = await openCredentialStore(ctx.cwd, ctx.env,
        { signal:ctx.signal })
    return withStoredCredentials(cfg, stored)
}
