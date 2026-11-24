// Project config discovery and loading (spec 02, 2.2 to 2.4 and 2.8).
import fs from 'node:fs'
import path from 'node:path'
import type { z } from 'zod'
import { type GoDuration, parseGoDuration } from '../gocompat/duration.js'
import { DEFAULT_PROTOCOL, endpointProblem } from './endpoint.js'
import type { StoredCredentials } from './credential.js'
import { canonicalFamily } from './family.js'
import { defaultBaseURL } from './provider.js'
import {
    type JsonObject,
    type JsonValue,
    isJsonObject,
    newObject,
    parseJsonc,
    setKey,
} from './jsonc.js'
import {
    ConfigSchema,
    type RawConfig,
    type RawProfile,
    type RawRole,
    SEVERITIES,
} from './schema.js'

import {
    DEFAULT_CONFIDENCE_FLOOR, DEFAULT_QUICK_CONFIDENCE_FLOOR,
    DEFAULT_SNAPSHOT, DEFAULT_GATE_OFFER,
} from './defaults.js'
export {
    DEFAULT_CONFIDENCE_FLOOR, DEFAULT_QUICK_CONFIDENCE_FLOOR,
} from './defaults.js'

export type { StoredCredentials }

export const PROJECT_CONFIG_NAME = '.roast.json'

// Every config discovery, parse, and validation failure. The CLI wraps
// it as a usage error.
export class ConfigError extends Error {
    constructor (message:string, opts?:{ cause?:unknown }) {
        super(message, opts)
        this.name = 'ConfigError'
    }
}

function causeText (err:unknown):string {
    return err instanceof Error ? err.message : String(err)
}

function findError (err:unknown):ConfigError {
    return new ConfigError(`find project config: ${causeText(err)}`,
        { cause:err })
}

function isNotFound (err:unknown):boolean {
    const code = (err as NodeJS.ErrnoException|undefined)?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
}

// The nearest .roast.json at or above `start`, never looking above
// `stop`, or '' when there is none. Directories compare by realpath (on
// macOS a temp dir is /var/... while git prints /private/var/...), but
// the returned path is spelled through `start`.
export function findConfig (start:string, stop:string):string {
    let dir = path.resolve(start)
    let stopCanonical:string
    try {
        stopCanonical = fs.realpathSync(path.resolve(stop))
    } catch (err) {
        throw findError(err)
    }
    for (;;) {
        const candidate = path.join(dir, PROJECT_CONFIG_NAME)
        try {
            if (!fs.statSync(candidate).isDirectory()) return candidate
        } catch (err) {
            if (!isNotFound(err)) throw findError(err)
        }
        let canonical:string
        try {
            canonical = fs.realpathSync(dir)
        } catch (err) {
            throw findError(err)
        }
        const parent = path.dirname(dir)
        if (canonical === stopCanonical || parent === dir) return ''
        dir = parent
    }
}

export const CURRENT_VERSION = 1
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768
const MAX_SESSION_HEADER_LENGTH = 64

export interface NormalizedProfile extends RawProfile {
    protocol:string;
    max_output_tokens:number;
}

export interface NormalizedLimits extends Omit<
    NonNullable<RawConfig['limits']>, 'deadline'|'request_timeout'
> {
    deadline?:GoDuration;
    request_timeout?:GoDuration;
}

export interface NormalizedConfig extends Omit<
    RawConfig, 'inference_profiles'|'roles'|'limits'
> {
    inference_profiles:Record<string, NormalizedProfile>;
    roles:{ finder?:RawRole, verifier?:RawRole };
    review:NonNullable<RawConfig['review']>&{
        confidence_floor:number;
        quick_confidence_floor:number;
    };
    limits?:NormalizedLimits;
}

export interface ProjectConfig extends NormalizedConfig {
    // The directory holding the config file; '' when not loaded from one.
    readonly dir:string;
    readonly stored?:StoredCredentials;
}

type Path = readonly (string|number)[]

function dotted (at:Path):string {
    return at.map(String).join('.')
}

// Step 2: the value is an object whose version is 1.
function checkVersion (value:JsonValue):asserts value is JsonObject {
    if (!isJsonObject(value)) {
        const got = Array.isArray(value) ? 'array' : typeof value
        throw new ConfigError(`config must be a JSON object (got ${got})`)
    }
    const version = Object.hasOwn(value, 'version') ?
        value.version :
        null
    if (version === null) {
        throw new ConfigError('version is required (set "version": 1)')
    }
    if (typeof version !== 'number' || !Number.isInteger(version)) {
        throw new ConfigError(
            `version must be an integer (got ${JSON.stringify(version)})`)
    }
    if (version !== CURRENT_VERSION) {
        throw new ConfigError(`unsupported config version ${version} ` +
            `(this build supports version ${CURRENT_VERSION})`)
    }
}

// Step 3: a profile never holds a credential.
function rejectLiteralCredentials (value:JsonObject):void {
    const profiles = value.inference_profiles
    if (!isJsonObject(profiles)) return
    for (const [name, profile] of Object.entries(profiles)) {
        if (isJsonObject(profile) && Object.hasOwn(profile, 'api_key')) {
            throw new ConfigError(`inference_profiles.${name}.api_key is ` +
                'not allowed: a project config never holds a credential; ' +
                'name its environment variable with api_key_env')
        }
    }
}

// Maps whose values are objects or strings: a null value there is the
// zero value, not an absent key (Go map decoding).
const MAP_ZERO:Record<string, () => JsonValue> = {
    inference_profiles:newObject,
    roles:newObject,
    author_routes:() => '',
}

// Step 4: Go parity for null. In fixed-shape objects a null property is
// deleted; in maps a null value becomes the zero value; a null array
// element becomes "".
function nullsAsUnset (value:JsonValue, mapKey?:string):JsonValue {
    if (Array.isArray(value)) {
        return value.map(v => v === null ? '' : nullsAsUnset(v))
    }
    if (!isJsonObject(value)) return value
    const out = newObject()
    const zero = mapKey === undefined ? undefined : MAP_ZERO[mapKey]
    for (const [key, v] of Object.entries(value)) {
        if (v === null) {
            if (zero) setKey(out, key, zero())
            continue
        }
        // inference_profiles and roles hold objects, whose own keys are
        // fixed-shape again; author_routes is a map at any depth.
        const childMap = zero ? undefined : (key in MAP_ZERO ? key : undefined)
        setKey(out, key, nullsAsUnset(v, childMap))
    }
    return out
}

function hasLoneSurrogate (s:string):boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(i + 1)
            if (next >= 0xdc00 && next <= 0xdfff) {
                i++
                continue
            }
            return true
        }
        if (c >= 0xdc00 && c <= 0xdfff) return true
    }
    return false
}

// Step 5a: every key and string is well-formed UTF-16, so the trust hash
// is always defined.
function rejectLoneSurrogates (value:JsonValue, at:Path = []):void {
    if (typeof value === 'string') {
        if (hasLoneSurrogate(value)) {
            throw new ConfigError(`${dotted(at) || 'config'}: string ` +
                'contains a lone UTF-16 surrogate')
        }
        return
    }
    if (Array.isArray(value)) {
        value.forEach((v, i) => rejectLoneSurrogates(v, [...at, i]))
        return
    }
    if (!isJsonObject(value)) return
    for (const [key, v] of Object.entries(value)) {
        if (hasLoneSurrogate(key)) {
            throw new ConfigError(`${dotted(at) || 'config'}: key ` +
                'contains a lone UTF-16 surrogate')
        }
        rejectLoneSurrogates(v, [...at, key])
    }
}

interface ZodDefLike {
    type:string;
    innerType?:ZodLike;
    shape?:Record<string, ZodLike>;
    valueType?:ZodLike;
    element?:ZodLike;
    format?:string;
}

interface ZodLike {
    _zod:{ def:ZodDefLike };
}

// Whether `at` names an integer field of the schema.
function isIntegerField (at:Path):boolean {
    let s:ZodLike|undefined = ConfigSchema as unknown as ZodLike
    let i = 0
    while (s) {
        const def:ZodDefLike = s._zod.def
        if (def.type === 'optional') {
            s = def.innerType
            continue
        }
        if (i === at.length) {
            // `version` is the integer literal 1.
            return (def.type === 'number' && def.format === 'safeint') ||
                def.type === 'literal'
        }
        const key = at[i++]
        if (def.type === 'object') s = def.shape?.[String(key)]
        else if (def.type === 'record') s = def.valueType
        else if (def.type === 'array') s = def.element
        else return false
    }
    return false
}

function issueMessage (issue:z.core.$ZodIssue):string {
    const at = dotted(issue.path as Path)
    if (issue.code === 'unrecognized_keys') {
        const key = issue.keys[0]
        if (at === 'roles') {
            return `roles.${key} is not a role (finder or verifier)`
        }
        return `${at ? `${at}: ` : ''}unknown field ${JSON.stringify(key)}`
    }
    return `${at || 'config'}: ${issue.message}`
}

// Parses and structurally validates config text (spec 02, section 3,
// steps 1 to 5). Errors are thrown as ConfigError without a path prefix.
export function decode (text:string):RawConfig {
    let parsed:ReturnType<typeof parseJsonc>
    try {
        parsed = parseJsonc(text)
    } catch (err) {
        throw new ConfigError((err as Error).message, { cause:err })
    }
    const { value, nonIntegerLexemes } = parsed
    checkVersion(value)
    rejectLiteralCredentials(value)
    const cleaned = nullsAsUnset(value)
    rejectLoneSurrogates(cleaned)
    const result = ConfigSchema.safeParse(cleaned)
    if (!result.success) {
        throw new ConfigError(issueMessage(result.error.issues[0]))
    }
    for (const at of nonIntegerLexemes) {
        if (isIntegerField(at)) {
            throw new ConfigError(`${dotted(at)}: expected an integer ` +
                'without a fraction or exponent')
        }
    }
    // zod's output object would turn a `__proto__` key into a prototype,
    // so the validated input (null-prototype objects) is the config.
    return cleaned as RawConfig
}

function isTokenChar (c:number):boolean {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) ||
        (c >= 48 && c <= 57) || "!#$%&'*+-.^_`|~".includes(
        String.fromCharCode(c))
}

const RESERVED_SESSION_HEADERS = [
    'Authorization', 'X-Api-Key', 'Proxy-Authorization', 'Cookie', 'Host',
    'Content-Type', 'Content-Length', 'Content-Encoding',
    'Transfer-Encoding', 'Connection', 'Keep-Alive', 'Proxy-Connection',
    'TE', 'Trailer', 'Upgrade', 'Expect', 'Accept', 'Accept-Encoding',
    'User-Agent', 'X-Agent-Session-Id', 'Anthropic-Version',
    'Anthropic-Beta', 'Anthropic-Workspace-Id', 'OpenAI-Organization',
    'OpenAI-Project',
].map(h => h.toLowerCase())

function checkSessionHeader (field:string, name:string):void {
    let ok = name.length <= MAX_SESSION_HEADER_LENGTH
    for (let i = 0; ok && i < name.length; i++) {
        ok = isTokenChar(name.charCodeAt(i))
    }
    if (!ok) {
        throw new ConfigError(`${field} must be an HTTP header name of at ` +
            `most ${MAX_SESSION_HEADER_LENGTH} letters, digits, or ` +
            "!#$%&'*+-.^_`|~ characters")
    }
    const lower = name.toLowerCase()
    if (lower.startsWith('x-stainless-') ||
        RESERVED_SESSION_HEADERS.includes(lower)) {
        throw new ConfigError(`${field} cannot be ${JSON.stringify(name)}, ` +
            'which is reserved for credentials, request framing, or a ' +
            'header Roast or the provider SDK sets')
    }
}

const API_KEY_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/

function normalizeProfile (name:string, p:RawProfile):NormalizedProfile {
    if (name.trim() === '') {
        throw new ConfigError('inference profile names cannot be empty')
    }
    const field = `inference_profiles.${name}`
    const out:NormalizedProfile = {
        ...p,
        protocol:p.protocol || DEFAULT_PROTOCOL,
        max_output_tokens:p.max_output_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
    }
    if (p.api_key_env && !API_KEY_ENV.test(p.api_key_env)) {
        throw new ConfigError(`${field}.api_key_env is not a valid ` +
            'environment variable name')
    }
    const problem = endpointProblem(field,
        p.endpoint || defaultBaseURL(out.protocol), out.protocol,
        out.max_output_tokens)
    if (problem) throw new ConfigError(problem)
    if (p.session_header) {
        checkSessionHeader(`${field}.session_header`, p.session_header)
    }
    return out
}

function normalizeRole (
    name:string,
    role:RawRole,
    profiles:Record<string, NormalizedProfile>
):RawRole {
    if (!role.profile) {
        throw new ConfigError(`roles.${name}.profile is required`)
    }
    if (!Object.hasOwn(profiles, role.profile)) {
        throw new ConfigError(`roles.${name}.profile references unknown ` +
            `inference profile ${JSON.stringify(role.profile)}`)
    }
    if (!role.author_routes) return role
    const routes = newObject<string>()
    for (const [rawKey, target] of Object.entries(role.author_routes)) {
        const key = canonicalFamily(rawKey.trim().toLowerCase())
        if (key === '') {
            throw new ConfigError(`roles.${name}.author_routes contains ` +
                'empty model family')
        }
        if (!Object.hasOwn(profiles, target)) {
            throw new ConfigError(`roles.${name}.author_routes.${key} ` +
                'references unknown inference profile ' +
                JSON.stringify(target))
        }
        if (Object.hasOwn(routes, key)) {
            throw new ConfigError(`roles.${name}.author_routes contains ` +
                `duplicate family ${JSON.stringify(key)}`)
        }
        setKey(routes, key, target)
    }
    return { ...role, author_routes:routes }
}

function checkFloor (key:string, v:number|undefined):void {
    if (v !== undefined && (v < 0 || v > 1)) {
        throw new ConfigError(`${key} must be between 0 and 1 (got ${v})`)
    }
}

function parseDuration (key:string, s:string|undefined):GoDuration|undefined {
    if (s === undefined) return undefined
    let d:GoDuration
    try {
        d = parseGoDuration(s)
    } catch (err) {
        throw new ConfigError(`${key}: invalid duration ${JSON.stringify(s)}`,
            { cause:err })
    }
    if (d < 0n) throw new ConfigError(`${key} cannot be negative`)
    return d
}

// Settings checks in Go's fixed order (spec 02, 2.4).
function validateSettings (raw:RawConfig):void {
    const ints:[string, number|undefined, number][] = [
        ['limits.max_total_tokens', raw.limits?.max_total_tokens, 0],
        ['limits.max_diff_bytes', raw.limits?.max_diff_bytes, 1],
        ['limits.max_prompt_bytes', raw.limits?.max_prompt_bytes, 1],
        ['limits.max_file_ctx_bytes', raw.limits?.max_file_ctx_bytes, 1],
        ['limits.max_attempts', raw.limits?.max_attempts, 1],
        ['limits.max_verified', raw.limits?.max_verified, 0],
        ['interactive.min_files', raw.interactive?.min_files, 0],
        ['interactive.min_diff_lines', raw.interactive?.min_diff_lines, 0],
        ['gate.timeout_seconds', raw.gate?.timeout_seconds, 0],
    ]
    for (const [key, v, min] of ints) {
        if (v !== undefined && v < min) {
            throw new ConfigError(
                `${key} must be an integer >= ${min} (got ${v})`)
        }
    }
    parseDuration('limits.deadline', raw.limits?.deadline)
    parseDuration('limits.request_timeout', raw.limits?.request_timeout)
    const severity = raw.gate?.severity
    if (severity &&
        !(SEVERITIES as readonly string[]).includes(severity.toUpperCase())) {
        throw new ConfigError('gate.severity must be INFO, LOW, MEDIUM, ' +
            `HIGH, or CRITICAL (got ${JSON.stringify(severity)})`)
    }
}

// Applies defaults and the checks zod does not express, in Go's order:
// profiles, roles, confidence floors, then settings.
export function normalize (raw:RawConfig, dir:string):ProjectConfig {
    const profiles = newObject<NormalizedProfile>()
    for (const [name, p] of Object.entries(raw.inference_profiles ?? {})) {
        setKey(profiles, name, normalizeProfile(name, p))
    }
    const roles:NormalizedConfig['roles'] = {}
    for (const name of Object.keys(raw.roles ?? {})) {
        const role = raw.roles?.[name as 'finder'|'verifier']
        if (role) {
            roles[name as 'finder'|'verifier'] =
                normalizeRole(name, role, profiles)
        }
    }
    const review = raw.review ?? {}
    checkFloor('confidence_floor', review.confidence_floor)
    checkFloor('quick_confidence_floor', review.quick_confidence_floor)
    validateSettings(raw)
    const limits:NormalizedLimits|undefined = raw.limits && {
        ...raw.limits,
        deadline:parseDuration('limits.deadline', raw.limits.deadline),
        request_timeout:parseDuration('limits.request_timeout',
            raw.limits.request_timeout),
    }
    if (limits?.deadline === undefined) delete limits?.deadline
    if (limits?.request_timeout === undefined) delete limits?.request_timeout
    return {
        ...raw,
        inference_profiles:profiles,
        roles,
        review:{
            ...review,
            confidence_floor:review.confidence_floor ||
                DEFAULT_CONFIDENCE_FLOOR,
            quick_confidence_floor:review.quick_confidence_floor ||
                DEFAULT_QUICK_CONFIDENCE_FLOOR,
        },
        limits,
        dir,
    }
}

// Reads, parses, and validates the config at `file`.
export function loadConfig (file:string):ProjectConfig {
    let text:string
    try {
        text = fs.readFileSync(file, 'utf8')
    } catch (err) {
        throw new ConfigError(`open config ${file}: ${causeText(err)}`,
            { cause:err })
    }
    let raw:RawConfig
    try {
        raw = decode(text)
    } catch (err) {
        throw new ConfigError(`parse config ${file}: ${causeText(err)}`,
            { cause:err })
    }
    return normalize(raw, path.resolve(path.dirname(file)))
}

export function withStoredCredentials (
    cfg:ProjectConfig,
    stored:StoredCredentials
):ProjectConfig {
    return { ...cfg, stored }
}

// The file a prompt override names: relative paths resolve against the
// config file's directory, so the same file is read wherever Roast runs.
export function promptPath (cfg:ProjectConfig, p:string):string {
    if (p === '' || path.isAbsolute(p) || cfg.dir === '') return p
    return path.join(cfg.dir, p)
}

// Every credential variable a profile names, in document order.
export function credentialEnvNames (cfg:ProjectConfig):string[] {
    return Object.values(cfg.inference_profiles)
        .map(p => p.api_key_env ?? '')
        .filter(name => name !== '')
}

export function snapshotEnabled (cfg:ProjectConfig):boolean {
    return cfg.review.snapshot ?? DEFAULT_SNAPSHOT
}

export function gateOffers (cfg:ProjectConfig):boolean {
    return cfg.gate?.offer ?? DEFAULT_GATE_OFFER
}
