// pattern: Functional Core
import { canonicalFamily, inferFamily } from './family.js'
import { lookupProvider } from './provider.js'
import { goQuote, goTrimSpace } from '../gocompat/strings.js'
import {
    DEFAULT_CONFIDENCE_FLOOR, DEFAULT_QUICK_CONFIDENCE_FLOOR,
    DEFAULT_SNAPSHOT, DEFAULT_GATE_OFFER, DEFAULT_LIMITS,
    GATE_DEFAULT_TIMEOUT, GATE_DEFAULT_SEVERITY,
    SUGGESTED_MODELS,
} from './defaults.js'
export { isPlaceholderModel } from './role.js'

export const SCHEMA_REF =
    './node_modules/@substrate-system/roast/roast.schema.json'
export const PLACEHOLDER_FINDER_MODEL = '<finder-model>'
export const PLACEHOLDER_VERIFIER_MODEL = '<verifier-model>'

export interface RoleChoice {
    readonly provider:string;
    readonly model:string;
}

export interface CustomChoice {
    readonly kind:'custom';
    readonly endpoint:string;
    readonly protocol:string;
    readonly apiKeyEnv:string;
    readonly model:string;
}

export type StarterChoice = RoleChoice|CustomChoice

export function isCustomChoice (
    c:StarterChoice
):c is CustomChoice {
    return 'kind' in c && c.kind === 'custom'
}

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
    return lookupProvider(family) && !isFamilyName(model) ?
        family : null
}

export class UnplaceableModelError extends Error {
    readonly role:'finder'|'verifier'
    readonly model:string

    constructor (role:'finder'|'verifier', model:string) {
        super(
            `${role} model ${goQuote(model)} is not a ` +
            'model ID init can place: use a bare OpenAI or ' +
            `Anthropic model ID (${SUGGESTED_MODELS.anthropic})` +
            ', or OpenRouter\'s <vendor>/<model> form ' +
            `(${SUGGESTED_MODELS.openrouter[0]}). For another` +
            ' provider, edit inference_profiles in .roast.jsonc'
        )
        this.role = role
        this.model = model
    }
}

export function otherProvider (provider:string):string {
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

function customProfile (
    name:string, c:CustomChoice, model:string
):string {
    const lines = [
        `    ${JSON.stringify(name)}: {`,
        `      "endpoint": ${JSON.stringify(c.endpoint)},`,
        `      "protocol": ${JSON.stringify(c.protocol)},`,
    ]
    if (c.apiKeyEnv !== '') {
        lines.push(
            '      "api_key_env": ' +
            `${JSON.stringify(c.apiKeyEnv)},`
        )
    }
    lines.push(
        `      "model": ${JSON.stringify(model)}`,
        '    }'
    )
    return lines.join('\n')
}

function sameCustom (a:CustomChoice, b:CustomChoice):boolean {
    return a.endpoint === b.endpoint &&
        a.protocol === b.protocol &&
        a.apiKeyEnv === b.apiKeyEnv
}

function renderProfile (
    name:string, choice:StarterChoice, model:string
):string {
    if (isCustomChoice(choice)) {
        return customProfile(name, choice, model)
    }
    return starterProfile(name, choice.provider, model)
}

function profileNames (
    finder:StarterChoice,
    verifier:StarterChoice,
    finderModel:string,
    verifierModel:string
):[string, string] {
    const fCustom = isCustomChoice(finder)
    const vCustom = isCustomChoice(verifier)
    if (fCustom && vCustom) {
        const same = sameCustom(finder, verifier)
        if (same && finderModel === verifierModel) {
            return ['custom', 'custom']
        }
        if (same) {
            return ['custom-finder', 'custom-verifier']
        }
        return ['custom-finder', 'custom-verifier']
    }
    if (fCustom) {
        return ['custom', (verifier as RoleChoice).provider]
    }
    if (vCustom) {
        return [(finder as RoleChoice).provider, 'custom']
    }
    const fAt = (finder as RoleChoice).provider
    const vAt = (verifier as RoleChoice).provider
    const separate = fAt === vAt &&
        finderModel !== verifierModel
    return [
        fAt + (separate ? '-finder' : ''),
        vAt + (separate ? '-verifier' : ''),
    ]
}

export function starter (
    finder:StarterChoice, verifier:StarterChoice
):string {
    const finderModel = finder.model || PLACEHOLDER_FINDER_MODEL
    const verifierModel = verifier.model ||
        PLACEHOLDER_VERIFIER_MODEL
    const [fName, vName] = profileNames(
        finder, verifier, finderModel, verifierModel
    )
    const profiles = [
        renderProfile(fName, finder, finderModel),
    ]
    if (fName !== vName) {
        profiles.push(
            renderProfile(vName, verifier, verifierModel)
        )
    }
    return TEMPLATE
        .replace('__SCHEMA__', JSON.stringify(SCHEMA_REF))
        .replace('__PROFILES__', profiles.join(',\n'))
        .replace('__FINDER_PROFILE__', JSON.stringify(fName))
        .replace('__VERIFIER_PROFILE__', JSON.stringify(vName))
}

export function choiceFromModel (
    role:'finder'|'verifier',
    model:string,
    otherChoice?:RoleChoice
):RoleChoice {
    model = goTrimSpace(model)
    if (!model) {
        const fallback = role === 'finder' ? 'openai' : 'anthropic'
        const provider = otherChoice ?
            otherProvider(otherChoice.provider) : fallback
        return { provider, model:'' }
    }
    const provider = placeModel(model)
    if (!provider) throw new UnplaceableModelError(role, model)
    return { provider, model }
}

export function starterFromModels (
    finderModel:string, verifierModel:string
):string {
    const finder = choiceFromModel('finder', finderModel)
    const verifier = choiceFromModel(
        'verifier', verifierModel, finder
    )
    const resolvedFinder = !goTrimSpace(finderModel) &&
        goTrimSpace(verifierModel) ?
        {
            provider:otherProvider(verifier.provider),
            model:finder.model,
        } : finder
    return starter(resolvedFinder, verifier)
}
