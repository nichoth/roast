// pattern: Functional Core
import { canonicalFamily, inferFamily } from './family.js'
import { lookupProvider } from './provider.js'
import { goQuote, goTrimSpace } from '../gocompat/strings.js'
import {
    DEFAULT_CONFIDENCE_FLOOR, DEFAULT_QUICK_CONFIDENCE_FLOOR,
    DEFAULT_SNAPSHOT, DEFAULT_GATE_OFFER, DEFAULT_LIMITS,
    GATE_DEFAULT_TIMEOUT, GATE_DEFAULT_SEVERITY,
} from './defaults.js'
export { isPlaceholderModel } from './role.js'

export const SCHEMA_REF =
    './node_modules/@substrate-system/roast/roast.schema.json'
export const PLACEHOLDER_FINDER_MODEL = '<finder-model>'
export const PLACEHOLDER_VERIFIER_MODEL = '<verifier-model>'

const TEMPLATE =
    `// Roast project config. Commit this file. It holds every setting except
// credentials, which come from "npx roast login" or environment variables.
{
  "$schema": __SCHEMA__,
  "version": 1,

  // Each profile names a model, its endpoint and protocol, and the
  // environment variable that holds its credential. These use built-in
  // provider endpoints with the standard key variables, so they need no
  // \`npx roast trust\` approval.
  "inference_profiles": {
__PROFILES__
  },

  // The finder proposes defects; the verifier checks each one. Using
  // different model families keeps the two independent.
  "roles": {
    "finder": {"profile": __FINDER_PROFILE__},
    "verifier": {"profile": __VERIFIER_PROFILE__}
  },

  // Review defaults.
  // "review": {
  //   "confidence_floor": ${JSON.stringify(DEFAULT_CONFIDENCE_FLOOR)},
  //   "quick_confidence_floor": ${
    JSON.stringify(DEFAULT_QUICK_CONFIDENCE_FLOOR)
},
  //   "excludes": [],
  //   "snapshot": ${JSON.stringify(DEFAULT_SNAPSHOT)}
  // },

  // Per-review limits. Durations are strings such as "90s" or "10m".
  // "limits": {
  //   "deadline": ${JSON.stringify(DEFAULT_LIMITS.deadline)},
  //   "request_timeout": ${JSON.stringify(DEFAULT_LIMITS.request_timeout)},
  //   "max_total_tokens": ${JSON.stringify(DEFAULT_LIMITS.max_total_tokens)},
  //   "max_diff_bytes": ${JSON.stringify(DEFAULT_LIMITS.max_diff_bytes)},
  //   "max_prompt_bytes": ${JSON.stringify(DEFAULT_LIMITS.max_prompt_bytes)},
  //   "max_file_ctx_bytes": ${
    JSON.stringify(DEFAULT_LIMITS.max_file_ctx_bytes)
},
  //   "max_attempts": ${JSON.stringify(DEFAULT_LIMITS.max_attempts)},
  //   "max_verified": ${JSON.stringify(DEFAULT_LIMITS.max_verified)}
  // },

  // The pre-commit gate.
  // "gate": {
  //   "timeout_seconds": ${JSON.stringify(GATE_DEFAULT_TIMEOUT)},
  //   "severity": ${JSON.stringify(GATE_DEFAULT_SEVERITY)},
  //   "offer": ${JSON.stringify(DEFAULT_GATE_OFFER)}
  // },
}
`

function isFamilyName (model:string):boolean {
    const family = inferFamily(model)
    return family !== '' && family === canonicalFamily(model)
}

export function placeModel (model:string):string|null {
    const slash = new RegExp(
        '^[a-z0-9][a-z0-9._-]*/([a-z0-9][a-z0-9._-]*)' +
        '(:[a-z0-9][a-z0-9._-]*)?$'
    ).exec(model)
    if (slash) {
        return slash[2] === ':api' || isFamilyName(slash[1]!) ?
            null : 'openrouter'
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(model)) return null
    const family = inferFamily(model)
    return lookupProvider(family) && !isFamilyName(model) ? family : null
}

export class UnplaceableModelError extends Error {
    readonly role:'finder'|'verifier'
    readonly model:string

    constructor (role:'finder'|'verifier', model:string) {
        super(`${role} model ${goQuote(model)} is not a model ID init ` +
            'can place: use a bare OpenAI or Anthropic model ID ' +
            '(claude-opus-5-5), or OpenRouter\'s <vendor>/<model> form ' +
            '(anthropic/claude-opus-5-5). For another provider, edit ' +
            'inference_profiles in .roast.json')
        this.role = role
        this.model = model
    }
}

function otherProvider (provider:string):string {
    if (provider === 'openrouter') return 'openrouter'
    return provider === 'openai' ? 'anthropic' : 'openai'
}

function starterProfile (
    name:string, provider:string, model:string
):string {
    const p = lookupProvider(provider)!
    return `    ${JSON.stringify(name)}: {\n` +
        `      "endpoint": ${JSON.stringify(p.endpoint)},\n` +
        `      "protocol": ${JSON.stringify(p.protocols[0])},\n` +
        `      "api_key_env": ${JSON.stringify(p.keyEnv)},\n` +
        `      "model": ${JSON.stringify(model)}\n` +
        '    }'
}

export function starter (finderModel:string, verifierModel:string):string {
    finderModel = goTrimSpace(finderModel)
    verifierModel = goTrimSpace(verifierModel)
    const finderAt = finderModel ? placeModel(finderModel) : 'openai'
    if (!finderAt) throw new UnplaceableModelError('finder', finderModel)
    const verifierAt = verifierModel ? placeModel(verifierModel) : 'anthropic'
    if (!verifierAt) {
        throw new UnplaceableModelError('verifier', verifierModel)
    }
    const fAt = !finderModel && verifierModel ?
        otherProvider(verifierAt) : finderAt
    const vAt = !verifierModel && finderModel ?
        otherProvider(finderAt) : verifierAt
    finderModel ||= PLACEHOLDER_FINDER_MODEL
    verifierModel ||= PLACEHOLDER_VERIFIER_MODEL
    const separate = fAt === vAt && finderModel !== verifierModel
    const fName = fAt + (separate ? '-finder' : '')
    const vName = vAt + (separate ? '-verifier' : '')
    const profiles = [starterProfile(fName, fAt, finderModel)]
    if (fName !== vName) {
        profiles.push(starterProfile(vName, vAt, verifierModel))
    }
    return TEMPLATE.replace('__SCHEMA__', JSON.stringify(SCHEMA_REF))
        .replace('__PROFILES__', profiles.join(',\n'))
        .replace('__FINDER_PROFILE__', JSON.stringify(fName))
        .replace('__VERIFIER_PROFILE__', JSON.stringify(vName))
}
