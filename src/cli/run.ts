// The CLI core: run(argv, io). It never reads process globals, never
// touches the real terminal, and never calls process.exit, so tests drive
// it in-process. It parses argv with yargs, runs the selected command,
// writes any error to io.stderr, and returns the exit code.
import yargs, { type Argv } from 'yargs'
import { Parser } from 'yargs/helpers'
import { buildInfo, formatBuildInfo } from '../buildinfo.js'
import {
    type CommandArgs,
    type CommandDef,
    type RunContext,
    registeredCommands,
} from './command.js'
import { builtinCommands } from './commands.js'
import {
    type ErrorFormat,
    UsageError,
    exitCode,
    writeError,
} from './errors.js'
import { LineReader } from './terminal.js'

export interface CliIO {
    stdin:NodeJS.ReadableStream;
    stdout:NodeJS.WritableStream;
    stderr:NodeJS.WritableStream;
    env:Readonly<Record<string, string|undefined>>;
    cwd:string;
    signal?:AbortSignal;
    fetch?:typeof globalThis.fetch;
}

export interface RunResult {
    code:number;
    error?:Error;
}

const PARSER_CONFIGURATION = {
    'boolean-negation':false, // --no-verify is a real flag
    'camel-case-expansion':false,
    'dot-notation':false,
    'parse-numbers':false, // integers are parsed by our own helper
    'parse-positional-numbers':false,
    'duplicate-arguments-array':false, // scalar flags: last wins
    'strip-aliased':true,
}

const ERROR_FORMATS:readonly string[] = ['text', 'json']

interface Selected {
    def:CommandDef;
    args:CommandArgs;
    path:string[];
}

function commandNames (def:CommandDef):string[] {
    const cmds = typeof def.command === 'string' ?
        [def.command] :
        [...def.command]
    return cmds.map(c => c.split(' ')[0])
}

// Registers `def` (and its subcommands) on `y`. The yargs handler only
// records the selection; run() calls the real handler after parsing, so
// parse errors and command errors stay apart.
function addCommand (
    y:Argv,
    def:CommandDef,
    parent:string[],
    select:(s:Selected) => void
):Argv {
    const names = commandNames(def)
    const name = names.find(n => n !== '$0') ?? '$0'
    return y.command(
        def.command as string|string[],
        def.describe as string,
        sub => {
            let b = def.builder ? def.builder(sub) : sub
            for (const child of def.subcommands ?? []) {
                b = addCommand(b, child, [...parent, name], select)
            }
            return b
        },
        args => {
            // A default command matched without its name in argv.
            const named = args._[parent.length] === name
            const path = named ? [...parent, name] : parent
            select({ def, args:args as CommandArgs, path })
        }
    )
}

function parser (select:(s:Selected) => void):Argv {
    let y:Argv = yargs()
        .scriptName('roast')
        .locale('en')
        .detectLocale(false) // English only, whatever LANG/LC_ALL say
        .parserConfiguration(PARSER_CONFIGURATION)
        .strict()
        .exitProcess(false)
        .showHelpOnFail(false)
        .fail((msg, err) => {
            throw new UsageError(msg ?? err?.message ?? 'invalid usage',
                { cause:err })
        })
        .usage('$0 [command] [flags]\n\nAdversarial cross-model code ' +
            'review. A finder proposes potential defects, then an ' +
            'independent verifier adjudicates each claim against the ' +
            'local checkout.')
        .option('error-format', {
            type:'string',
            default:'text',
            global:true,
            describe:'Error output format (text|json)',
        })
        .version(false) // root-only --version / -v is handled in run
        .option('version', {
            alias:'v',
            type:'boolean',
            global:false,
            describe:'Print the version and exit',
        })
        .help('help')
        .alias('help', 'h')
    for (const def of [...builtinCommands, ...registeredCommands()]) {
        y = addCommand(y, def, [], select)
    }
    return y
}

// Parses argv. Resolves with the selected command, or with help output
// when --help was given.
async function parse (
    argv:string[]
):Promise<{ selected?:Selected, output:string }> {
    let selected:Selected|undefined
    let output = ''
    await parser(s => { selected = s }).parseAsync(argv, {},
        (_err, _args, out) => { output = out ?? '' })
    return { selected, output }
}

async function helpFor (path:string[]):Promise<string> {
    const { output } = await parse([...path, '--help'])
    return output.endsWith('\n') ? output : `${output}\n`
}

// The --error-format yargs would parse from argv, for reporting a parse
// failure; text when absent or invalid.
function parsedErrorFormat (argv:string[]):ErrorFormat {
    const parsed = Parser(argv, {
        string:['error-format'],
        configuration:PARSER_CONFIGURATION,
    })
    const v = parsed['error-format']
    return v === 'json' ? 'json' : 'text'
}

// A root-level flag is one that no subcommand token precedes.
function hasRootFlag (argv:string[], names:string[]):boolean {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--' || !arg.startsWith('-')) return false
        if (names.includes(arg)) return true
        if (arg === '--error-format') i++ // skip its value
    }
    return false
}

function toError (e:unknown):Error {
    return e instanceof Error ? e : new Error(String(e))
}

export async function run (argv:string[], io:CliIO):Promise<RunResult> {
    const signal = io.signal ?? new AbortController().signal
    let format:ErrorFormat = 'text'
    try {
        if (hasRootFlag(argv, ['--version', '-v'])) {
            io.stdout.write(
                `roast version ${formatBuildInfo(buildInfo)}\n`)
            return { code:0 }
        }
        let parsed:Awaited<ReturnType<typeof parse>>
        try {
            parsed = await parse(argv)
        } catch (err) {
            format = parsedErrorFormat(argv)
            throw err
        }
        const { selected, output } = parsed
        if (!selected) {
            // --help (or a yargs-handled path with nothing to run).
            if (output) {
                io.stdout.write(output.endsWith('\n') ?
                    output :
                    `${output}\n`)
            }
            return { code:0 }
        }
        const errorFormat = String(selected.args['error-format'])
        if (!ERROR_FORMATS.includes(errorFormat)) {
            throw new UsageError(
                `invalid --error-format ${JSON.stringify(errorFormat)} ` +
                '(text|json)')
        }
        format = errorFormat as ErrorFormat
        const extra = selected.args._.slice(selected.path.length)
        if (extra.length > 0) {
            throw new UsageError(
                `unexpected argument ${JSON.stringify(String(extra[0]))}`)
        }
        const ctx:RunContext = {
            stdin:io.stdin,
            stdout:io.stdout,
            stderr:io.stderr,
            env:io.env,
            cwd:io.cwd,
            signal,
            fetch:io.fetch ?? globalThis.fetch,
            lines:new LineReader(io.stdin),
            errorFormat:format,
            path:selected.path,
            argv:[...argv],
            rootHelp:() => helpFor([]),
        }
        const { def } = selected
        if (def.handler) {
            await def.handler(selected.args, ctx)
        } else {
            io.stdout.write(await helpFor(selected.path))
        }
        return { code:0 }
    } catch (e) {
        const error = toError(e)
        const code = exitCode(error, signal)
        writeError(io.stderr, code, error, format, signal)
        return { code, error }
    }
}
