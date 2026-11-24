import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The test bundle lives in test/, so the repository root is one up.
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export interface SpawnResult {
    code:number|null;
    stdout:string;
    stderr:string;
}

// Runs a command to completion and collects its output.
export function run (
    command:string,
    args:string[],
    opts:{ cwd?:string, env?:NodeJS.ProcessEnv } = {}
):Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd:opts.cwd ?? ROOT,
            env:opts.env ?? process.env,
            stdio:['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.on('error', reject)
        child.on('close', code => resolve({ code, stdout, stderr }))
    })
}
