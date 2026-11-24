// The per-repository enrollment decision in local git config (spec 12,
// 2.3). Only --local counts: a global value never enrolls a repo.
import {
    CONFIG_KEY_DECISION,
    CONFIG_KEY_NOTICE,
} from './constants.js'
import { configGet, configSet, configUnset, type Env } from './git-config.js'

export type Decision = 'none'|'enabled'|'declined'

// The values the hook script also accepts as consent.
const ENABLED = ['enabled', 'enable', 'true', 'yes', 'on', '1']
const DECLINED = ['declined', 'disabled', 'false', 'no', 'off', '0']

// An unrecognized value reads as 'none': a typo means "unanswered".
export async function readDecision (repo:string, env:Env):Promise<Decision> {
    const v = (await configGet(repo, CONFIG_KEY_DECISION, env))
        .trim().toLowerCase()
    if (ENABLED.includes(v)) return 'enabled'
    if (DECLINED.includes(v)) return 'declined'
    return 'none'
}

// Records a decision and clears the hint marker, which exists only for
// the undecided state.
export async function recordDecision (
    repo:string,
    d:Decision,
    env:Env
):Promise<void> {
    await configUnset(repo, CONFIG_KEY_NOTICE, env)
    if (d === 'none') {
        await configUnset(repo, CONFIG_KEY_DECISION, env)
        return
    }
    await configSet(repo, CONFIG_KEY_DECISION, d, env)
}

// Remembers that the "how to enable" hint was printed for this repo.
export function recordNotice (repo:string, env:Env):Promise<void> {
    return configSet(repo, CONFIG_KEY_NOTICE, 'sent', env)
}
