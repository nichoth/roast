// pattern: Functional Core
import { builtinProviders } from '../config/provider.js'

export const PROJECT_CREDENTIALS_FILE = '.env.roast'
export const PROJECT_CREDENTIALS_TEMP_PREFIX = '.env.roast.tmp-'

const ASSIGNMENT =
    /^([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s'"]+))\s*(?:#.*)?$/

const providers = builtinProviders()

export function decodeDotenv (body:string):Map<string, string> {
    const keys = new Map<string, string>()
    for (const [index, raw] of body.split('\n').entries()) {
        const line = raw.trim()
        if (line === '' || line.startsWith('#')) continue
        const match = ASSIGNMENT.exec(line)
        const provider = providers.find(p => p.keyEnv === match?.[1])
        const key = match?.[2] ?? match?.[3] ?? match?.[4] ?? ''
        if (!provider || key.trim() === '' || keys.has(provider.name)) {
            throw new Error('invalid credential assignment on line ' +
                (index + 1))
        }
        keys.set(provider.name, key)
    }
    return keys
}

function quoteKey (key:string):string {
    if (/^[A-Za-z0-9_.-]+$/.test(key)) return key
    if (!key.includes('\n') && !key.includes('\r')) {
        if (!key.includes("'")) return `'${key}'`
        if (!key.includes('"')) return `"${key}"`
    }
    throw new Error('credential cannot be stored as a dotenv value')
}

export function encodeDotenv (keys:ReadonlyMap<string, string>):string {
    return providers.map(({ name, keyEnv }) => {
        const key = keys.get(name)
        return key === undefined ? '' : `${keyEnv}=${quoteKey(key)}\n`
    }).join('')
}
