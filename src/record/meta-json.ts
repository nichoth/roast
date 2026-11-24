// pattern: Functional Core
import type { Meta, RoleMeta } from './meta-types.js'
import { goStringify, sortedMap, compareBytes } from './json.js'
import { createHash } from 'node:crypto'

// Ordered field lists are the replay wire contract. A trailing ? means
// Go omitempty; required fields are retained even at their zero value.
export const META_FIELDS = [
    'run_id', 'replay_of?', 'ts', 'repo', 'invoke_dir?', 'argv?', 'roast',
    'scope', 'derived', 'roles', 'snapshot', 'digests', 'budgets?', 'usage?',
    'env_names_only?', 'caveats?',
]
export const FIELDS:Record<string, string[]> = {
    roast:['version', 'commit'],
    scope:[
        'kind', 'base?', 'uncommitted_only?', 'staged_only?',
        'include_vendored?', 'paths?', 'excludes?', 'base_oid?',
        'merge_base_oid?', 'head_oid?', 'survey?', 'staged?', 'files?',
    ],
    derived:[
        'mode', 'langs?', 'quick?', 'interactive', 'max_turns',
        'confidence_floor', 'do_verify', 'task?', 'max_severity?',
        'max_diff_bytes?', 'max_file_ctx_bytes?',
    ],
    role:[
        'profile?', 'base_url', 'model', 'protocol', 'api?',
        'max_output_tokens', 'session_header?', 'prompt_digest?',
    ],
    snapshot:[
        'captured', 'reason?', 'ref?', 'commit?', 'index_tree?',
        'worktree_tree?', 'base_tree?', 'head?', 'base?', 'diff_pair?',
        'file_modes?', 'excluded_paths?',
    ],
    digests:[
        'input_kind', 'input', 'input_bytes', 'system_prompt?', 'user_prompt?',
    ],
    usage:[
        'uncached_input_tokens', 'cached_input_tokens', 'cache_write_tokens',
        'output_tokens', 'calls',
    ],
}

export function wireProtocol (role:RoleMeta):string {
    return role.protocol || role.api || ''
}

export function captureEnv (
    env:NodeJS.ProcessEnv,
    extraSecrets:readonly string[] = []
):string[] {
    const secrets = new Set(extraSecrets)
    return Object.keys(env).filter(name => env[name] !== undefined &&
        name.startsWith('ROAST_') && !name.endsWith('_API_KEY') &&
        !secrets.has(name)).sort(compareBytes)
}

export function digest (x:string|Uint8Array):string {
    return createHash('sha256').update(x).digest('hex')
}

function empty (v:unknown):boolean {
    if (!v) return true
    return typeof v === 'object' && Object.keys(v).length === 0
}

export function ordered (
    value:object,
    fields:readonly string[]
):Record<string, unknown> {
    const out:Record<string, unknown> = {}
    for (const field of fields) {
        const key = field.replace(/\?$/, '')
        const v:unknown = Reflect.get(value, key)
        if (!field.endsWith('?') || !empty(v)) out[key] = v
    }
    return out
}

export function orderedMap (
    value:Record<string, object>,
    fields:readonly string[]
):Record<string, unknown> {
    return Object.fromEntries(Object.keys(value).sort(compareBytes)
        .map(key => [key, ordered(value[key], fields)]))
}

export function serializeMeta (meta:Meta):string {
    const out = ordered(meta, META_FIELDS)
    for (const key of ['roast', 'scope', 'derived', 'snapshot', 'digests']) {
        out[key] = ordered(Reflect.get(meta, key), FIELDS[key])
    }
    out.roles = orderedMap(meta.roles, FIELDS.role)
    if (!empty(meta.budgets)) out.budgets = sortedMap(meta.budgets)
    if (!empty(meta.usage)) out.usage = orderedMap(meta.usage!, FIELDS.usage)
    return goStringify(out, 2) + '\n'
}
