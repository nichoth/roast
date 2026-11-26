// `review` flags (spec 01, 2.6), their value syntax (2.11), and the raw
// validation that runs before any config is read (2.7).
import type { Argv } from 'yargs'
import { Parser } from 'yargs/helpers'
import { parseGoDuration, type GoDuration } from '../gocompat/duration.js'
import { goTrimSpace } from '../gocompat/strings.js'
import { parseSeverity, severityRank } from '../review/types.js'
import {
    DEFAULT_LIMITS,
    DEFAULT_REVIEW_MAX_TURNS,
    SURVEY_DEADLINE,
    SURVEY_MAX_TURNS,
} from '../config/defaults.js'
import type { CommandArgs } from './command.js'
import { UsageError } from './errors.js'

export interface RoleFlags {
    baseUrl?:string;
    model?:string;
    protocol?:string;
    maxOutputTokens?:number;
}

// Optional fields are undefined when the flag was not given ("changed"
// in Go terms); the documented default applies later.
export interface ReviewFlags {
    config:string;
    base:string;
    uncommittedOnly:boolean;
    staged:boolean;
    task:string;
    format:string;
    maxSeverity:string;
    paths:string[];
    exclude:string[];
    includeVendored:boolean;
    mode:string;
    quick:boolean;
    noVerify:boolean;
    interactive:boolean;
    maxTurns?:number;
    deadline?:GoDuration;
    requestTimeout?:GoDuration;
    maxTokensTotal?:number;
    maxVerified?:number;
    maxAttempts?:number;
    showDropped:boolean;
    lang:string[];
    scope:string;
    authorModel:string;
    finder:RoleFlags;
    verifier:RoleFlags;
}

export const DEFAULT_MAX_TURNS = DEFAULT_REVIEW_MAX_TURNS
export { SURVEY_MAX_TURNS }
export const DEFAULT_TASK = '(not provided)'

const BOOLEANS = [
    'uncommitted-only', 'staged', 'include-vendored', 'quick', 'no-verify',
    'interactive', 'show-dropped',
] as const

const STRINGS = [
    'config', 'base', 'task', 'format', 'max-severity', 'mode', 'scope',
    'author-model', 'max-turns', 'deadline', 'request-timeout',
    'max-tokens-total', 'max-verified', 'max-attempts',
    'finder-base-url', 'finder-model', 'finder-protocol',
    'finder-max-output-tokens', 'verifier-base-url', 'verifier-model',
    'verifier-protocol', 'verifier-max-output-tokens', 'error-format',
] as const

const SLICES = ['paths', 'exclude', 'lang'] as const

export interface FlagHelpDefaults {
    limits:{
        deadline:string;
        request_timeout:string;
        max_total_tokens:number;
        max_verified:number;
        max_attempts:number;
    };
    maxTurns:number;
    surveyMaxTurns:number;
    surveyDeadline:string;
}

const HELP_DEFAULTS:FlagHelpDefaults = {
    limits:DEFAULT_LIMITS,
    maxTurns:DEFAULT_REVIEW_MAX_TURNS,
    surveyMaxTurns:SURVEY_MAX_TURNS,
    surveyDeadline:SURVEY_DEADLINE,
}

// Help text for every review flag, its defaults read from `d`.
export function describeReviewFlags (
    d:FlagHelpDefaults = HELP_DEFAULTS
):Record<string, string> {
    const l = d.limits
    const out:Record<string, string> = {
        config:'Project config path (default: nearest .roast.jsonc up ' +
            'to the Git toplevel)',
        base:'Diff base ref',
        'uncommitted-only':'Review only uncommitted changes',
        staged:'Review exactly the staged set',
        task:'What the builder was asked to do',
        format:'Output format (json|markdown|both)',
        'max-severity':'Exit 1 when a finding reaches this severity ' +
            '(INFO|LOW|MEDIUM|HIGH|CRITICAL)',
        paths:'Limit the review to these Git pathspecs',
        exclude:'Exclude these Git pathspecs',
        'include-vendored':'Review vendored and generated files',
        mode:'Review mode (code|prose|mixed|auto)',
        quick:'Single-shot finder, no verification',
        'no-verify':'Skip verification',
        interactive:'Let the finder navigate the checkout',
        'max-turns':`Max interactive finder turns (default ${d.maxTurns}, ` +
            `${d.surveyMaxTurns} with --scope repo)`,
        deadline:`Finder work deadline (default ${l.deadline}, ` +
            `${d.surveyDeadline} with --scope repo; 0 disables)`,
        'request-timeout':'Per inference request timeout (default ' +
            `${l.request_timeout}; 0 disables)`,
        'max-tokens-total':'Shared token ceiling (default ' +
            `${l.max_total_tokens}; 0 disables)`,
        'max-verified':'Max findings sent to the verifier (default ' +
            `${l.max_verified})`,
        'max-attempts':'Provider and structured-output attempts ' +
            `(default ${l.max_attempts})`,
        'show-dropped':'Render malformed and refuted candidates',
        lang:'Prompt packs (go|react|frontend|web); none disables',
        scope:'Review scope (diff|repo)',
        'author-model':'Model or family that wrote the change',
    }
    for (const role of ['finder', 'verifier']) {
        out[`${role}-base-url`] = `${role} endpoint override`
        out[`${role}-model`] = `${role} model override`
        out[`${role}-protocol`] =
            `${role} protocol override (chat|responses|anthropic)`
        out[`${role}-max-output-tokens`] = `${role} output token ceiling`
    }
    return out
}

const DESCRIBE = describeReviewFlags()

const DEFAULTS:Record<string, string|boolean> = {
    config:'',
    base:'',
    task:DEFAULT_TASK,
    format:'both',
    'max-severity':'',
    mode:'auto',
    scope:'diff',
    'author-model':'',
}

// Declares every review flag on `y`. Flags whose "changed" state matters
// have no yargs default.
export function reviewBuilder (y:Argv):Argv {
    let b = y
    for (const name of BOOLEANS) {
        b = b.option(name, {
            type:'boolean', default:false, describe:DESCRIBE[name],
        })
    }
    for (const name of STRINGS) {
        if (name === 'error-format') continue
        b = b.option(name, {
            type:'string',
            describe:DESCRIBE[name],
            ...(name in DEFAULTS ? { default:DEFAULTS[name] } : {}),
        })
    }
    for (const name of SLICES) {
        b = b.option(name, {
            type:'string', array:true, nargs:1, describe:DESCRIBE[name],
        })
    }
    return b
}

// yargs keeps only the last occurrence of a repeated flag, so slice
// flags are read again from argv with occurrences appended.
function sliceValues (argv:readonly string[]):Record<string, string[]> {
    const parsed = Parser([...argv], {
        boolean:[...BOOLEANS, 'help', 'version'],
        string:[...STRINGS],
        array:[...SLICES],
        narg:{ paths:1, exclude:1, lang:1 },
        configuration:{
            'boolean-negation':false,
            'camel-case-expansion':false,
            'dot-notation':false,
            'parse-numbers':false,
            'parse-positional-numbers':false,
            'duplicate-arguments-array':true,
            'flatten-duplicate-arrays':true,
            'greedy-arrays':false,
        },
    })
    const out:Record<string, string[]> = {}
    for (const name of SLICES) {
        const raw:unknown = parsed[name]
        const list = raw === undefined ? [] :
            Array.isArray(raw) ? raw : [raw]
        out[name] = list.flatMap(v => String(v).split(','))
    }
    return out
}

function str (args:CommandArgs, name:string):string|undefined {
    const v = args[name]
    if (v === undefined) return undefined
    return String(Array.isArray(v) ? v[v.length - 1] : v)
}

// Decimal integers only, optional sign (spec 2.11).
export function parseIntFlag (name:string, value:string):number {
    if (!/^[+-]?[0-9]+$/.test(value)) {
        throw new UsageError(`invalid argument ${JSON.stringify(value)} ` +
            `for "--${name}" flag: invalid syntax`)
    }
    const n = Number(value)
    if (!Number.isSafeInteger(n)) {
        throw new UsageError(`invalid argument ${JSON.stringify(value)} ` +
            `for "--${name}" flag: value out of range`)
    }
    return n
}

function intFlag (args:CommandArgs, name:string):number|undefined {
    const v = str(args, name)
    return v === undefined ? undefined : parseIntFlag(name, v)
}

function durationFlag (
    args:CommandArgs,
    name:string
):GoDuration|undefined {
    const v = str(args, name)
    if (v === undefined) return undefined
    try {
        return parseGoDuration(v)
    } catch (err) {
        throw new UsageError(`invalid argument ${JSON.stringify(v)} for ` +
            `"--${name}" flag: ${(err as Error).message}`, { cause:err })
    }
}

function roleFlags (args:CommandArgs, role:string):RoleFlags {
    return {
        baseUrl:str(args, `${role}-base-url`),
        model:str(args, `${role}-model`),
        protocol:str(args, `${role}-protocol`),
        maxOutputTokens:intFlag(args, `${role}-max-output-tokens`),
    }
}

// Reads the parsed flags; malformed values are usage errors.
export function parseReviewFlags (
    args:CommandArgs,
    argv:readonly string[]
):ReviewFlags {
    const slices = sliceValues(argv)
    const bool = (name:string):boolean => args[name] === true
    return {
        config:str(args, 'config') ?? '',
        base:str(args, 'base') ?? '',
        uncommittedOnly:bool('uncommitted-only'),
        staged:bool('staged'),
        task:str(args, 'task') ?? DEFAULT_TASK,
        format:str(args, 'format') ?? 'both',
        maxSeverity:str(args, 'max-severity') ?? '',
        paths:slices.paths,
        exclude:slices.exclude,
        includeVendored:bool('include-vendored'),
        mode:str(args, 'mode') ?? 'auto',
        quick:bool('quick'),
        noVerify:bool('no-verify'),
        interactive:bool('interactive'),
        maxTurns:intFlag(args, 'max-turns'),
        deadline:durationFlag(args, 'deadline'),
        requestTimeout:durationFlag(args, 'request-timeout'),
        maxTokensTotal:intFlag(args, 'max-tokens-total'),
        maxVerified:intFlag(args, 'max-verified'),
        maxAttempts:intFlag(args, 'max-attempts'),
        showDropped:bool('show-dropped'),
        lang:slices.lang,
        scope:str(args, 'scope') ?? 'diff',
        authorModel:str(args, 'author-model') ?? '',
        finder:roleFlags(args, 'finder'),
        verifier:roleFlags(args, 'verifier'),
    }
}

// Spec 2.7, in order. Returns the --max-severity gate rank (-1: none).
export function validateReviewFlags (f:ReviewFlags):number {
    if (f.staged && f.uncommittedOnly) {
        throw new UsageError(
            '--staged and --uncommitted-only cannot be combined')
    }
    if (!['json', 'markdown', 'both'].includes(f.format)) {
        throw new UsageError(`invalid --format ${JSON.stringify(f.format)}`)
    }
    if ((f.maxTurns ?? DEFAULT_MAX_TURNS) < 1) {
        throw new UsageError('max-turns must be positive')
    }
    if ((f.deadline ?? 0n) < 0n) {
        throw new UsageError('deadline cannot be negative')
    }
    if ((f.requestTimeout ?? 0n) < 0n) {
        throw new UsageError('request-timeout cannot be negative')
    }
    if ((f.maxTokensTotal ?? 0) < 0) {
        throw new UsageError('max-tokens-total cannot be negative')
    }
    if ((f.maxVerified ?? 0) < 0) {
        throw new UsageError('max-verified cannot be negative')
    }
    if ((f.maxAttempts ?? 1) < 1) {
        throw new UsageError('max-attempts must be positive')
    }
    if (f.scope !== 'diff' && f.scope !== 'repo') {
        throw new UsageError(
            `invalid --scope ${JSON.stringify(f.scope)} (diff|repo)`)
    }
    const survey = f.scope === 'repo'
    if (survey && f.quick) {
        throw new UsageError(
            '--quick cannot run a repository survey; drop --quick')
    }
    if (survey && (f.staged || f.uncommittedOnly || f.base !== '')) {
        throw new UsageError('--scope repo cannot be combined with ' +
            '--staged, --uncommitted-only, or --base')
    }
    if (f.maxSeverity === '') return -1
    const sev = parseSeverity(goTrimSpace(f.maxSeverity.toUpperCase()))
    if (sev === null) {
        throw new UsageError(
            `invalid --max-severity ${JSON.stringify(f.maxSeverity)}`)
    }
    return severityRank(sev)
}
