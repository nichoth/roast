// The command registration API. Area tickets describe their commands as
// CommandDefs and list them in src/cli/commands.ts; tests add their own
// with registerCommand. run.ts builds the yargs tree from both.
import type { Argv, ArgumentsCamelCase } from 'yargs'
import type { ErrorFormat } from './errors.js'
import type { LineReader } from './terminal.js'

// Everything a command handler may touch. Handlers never read process
// globals: cwd, env, signal, and fetch come from here.
export interface RunContext {
    stdin:NodeJS.ReadableStream;
    stdout:NodeJS.WritableStream;
    stderr:NodeJS.WritableStream;
    env:Readonly<Record<string, string|undefined>>;
    cwd:string;
    signal:AbortSignal;
    fetch:typeof globalThis.fetch;
    // The one line reader every prompt in this invocation shares.
    lines:LineReader;
    errorFormat:ErrorFormat;
    // The command tokens that selected this handler, such as
    // ['gate', 'enable']; empty for bare `roast`.
    path:string[];
    // The argv given to run(), without the program name.
    argv:readonly string[];
    // Root help, for commands that print it.
    rootHelp ():Promise<string>;
}

export type CommandArgs = ArgumentsCamelCase<Record<string, unknown>>

export interface CommandDef {
    // A yargs command string, such as 'show <id>', or aliases.
    command:string|readonly string[];
    // Help description; false hides the command.
    describe:string|false;
    // Declares the command's flags and positionals.
    builder?:(y:Argv) => Argv;
    // Throws UsageError, ExitSignal, or any other error; never writes
    // the error itself. A command with subcommands and no handler
    // prints its help.
    handler?:(args:CommandArgs, ctx:RunContext) => void|Promise<void>;
    subcommands?:readonly CommandDef[];
}

const registered:CommandDef[] = []

// Adds a command to every later run; returns a function removing it.
export function registerCommand (def:CommandDef):() => void {
    registered.push(def)
    return () => {
        const i = registered.indexOf(def)
        if (i >= 0) registered.splice(i, 1)
    }
}

export function registeredCommands ():readonly CommandDef[] {
    return registered
}
