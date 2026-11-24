// Fixtures for end-to-end review tests (Go settingsRepo, loginRepo):
// a temporary Git repository with a committed file and an uncommitted
// change, a project config pointing at a fake chat server, and helpers
// that read the run record a review wrote.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { CleanupTest } from './test.js'
import { tempRepo, type TempDir } from './repo.js'
import { runRoast, type RunRoastResult } from './run.js'
import {
    type InferenceServer,
    type RecordedRequest,
    type Script,
    startInferenceServer,
} from './inference-server.js'

export const FINDER_KEY = 'finder-secret-key-do-not-print'
export const VERIFIER_KEY = 'verifier-secret-key-do-not-print'

export interface ReviewRepo extends TempDir {
    server:InferenceServer;
    // Runs roast in the repository against the fake server.
    roast (args:string[], opts?:{
        cwd?:string,
        stdin?:string|NodeJS.ReadableStream,
        signal?:AbortSignal,
    }):Promise<RunRoastResult>;
}

export function gitIn (r:TempDir, args:string[], cwd = r.dir):string {
    return execFileSync('git', args, { cwd, env:r.env }).toString()
}

export type Wire = {
    severity:string;
    confidence:number;
    file:string;
    lines:number[];
    code_quote:string;
    fixed_code:string;
    description:string;
    reasoning:string;
    cwe:string;
    frontend_category:string;
}

export function finding (over:Partial<Wire> = {}):Wire {
    return {
        reasoning:'The guard is missing.',
        severity:'HIGH',
        confidence:0.9,
        cwe:'',
        description:'Missing guard',
        file:'main.go',
        lines:[3],
        code_quote:'return value',
        fixed_code:'return value + 1',
        frontend_category:'',
        ...over,
    }
}

type Call = { name:string, args:unknown }

// A chat completion whose single choice calls `calls`.
export function chatCalls (calls:Call[], model = 'finder-model') {
    return {
        id:'c1',
        model,
        choices:[{
            index:0,
            finish_reason:calls.length ? 'tool_calls' : 'stop',
            message:{
                role:'assistant',
                content:calls.length ? '' : 'done',
                tool_calls:calls.map((c, i) => ({
                    id:`call-${i}`,
                    type:'function',
                    function:{
                        name:c.name, arguments:JSON.stringify(c.args),
                    },
                })),
            },
        }],
        usage:{ prompt_tokens:100, completion_tokens:20, total_tokens:120 },
    }
}

// A complete Responses API response whose output calls `calls`; `extra`
// overrides top-level fields (usage, status, incomplete_details).
export function responsesCalls (
    calls:Call[],
    model = 'finder-model',
    extra:Record<string, unknown> = {}
) {
    return {
        id:'resp_1',
        object:'response',
        model,
        status:'completed',
        output:calls.map((c, i) => ({
            type:'function_call',
            id:`fc_${i}`,
            call_id:`call-${i}`,
            name:c.name,
            arguments:JSON.stringify(c.args),
            status:'completed',
        })),
        usage:{ input_tokens:100, output_tokens:20, total_tokens:120 },
        ...extra,
    }
}

// The structured finder answer (one `findings` tool call).
export function findingsReply (findings:Wire[] = []) {
    return {
        stream:chatCalls([{
            name:'findings',
            args:{
                assessment:findings.length ?
                    'FINDINGS_PRESENT' :
                    'NO_FINDINGS',
                findings,
            },
        }]),
    }
}

// `findingsReply` in the `responses` format.
export function responsesFindingsReply (
    findings:Wire[] = [],
    extra:Record<string, unknown> = {}
) {
    return {
        stream:responsesCalls([{
            name:'findings',
            args:{
                assessment:findings.length ?
                    'FINDINGS_PRESENT' :
                    'NO_FINDINGS',
                findings,
            },
        }], 'finder-model', extra),
    }
}

// The tools a chat, responses, or anthropic request offers (the final
// tool is 'findings' for a structured call, 'submit_findings' for an
// interactive one).
export function toolNames (req:RecordedRequest):string[] {
    const body = req.body as {
        tools?:{ name?:string, function?:{ name:string } }[],
    }
    return (body?.tools ?? []).map(t => t.function?.name ?? t.name ?? '')
}

// A finder that answers every structured call with `findings`.
export function finderScript (findings:Wire[] = []):Script {
    return () => findingsReply(findings)
}

export function profileConfig (url:string, over:object = {}) {
    return {
        version:1,
        inference_profiles:{
            fake:{
                model:'finder-model',
                endpoint:`${url}/v1`,
                protocol:'chat',
                api_key_env:'ROAST_FINDER_API_KEY',
                max_output_tokens:4096,
            },
        },
        roles:{ finder:{ profile:'fake' }, verifier:{ profile:'fake' } },
        review:{ snapshot:false },
        ...over,
    }
}

// `profileConfig` with the profile on the `responses` protocol.
export function responsesProfileConfig (url:string) {
    const cfg = profileConfig(url)
    cfg.inference_profiles.fake.protocol = 'responses'
    return cfg
}

// `profileConfig` with the `fake` profile on the `anthropic` protocol.
export function anthropicProfileConfig (
    url:string,
    over:object = {},
    profile:object = {}
) {
    const base = profileConfig(url)
    return {
        ...base,
        inference_profiles:{
            fake:{
                ...base.inference_profiles.fake,
                model:'claude-test',
                protocol:'anthropic',
                ...profile,
            },
        },
        ...over,
    }
}

export function writeConfig (dir:string, cfg:object, name = '.roast.json') {
    fs.mkdirSync(dir, { recursive:true })
    fs.writeFileSync(path.join(dir, name), JSON.stringify(cfg, null, 2))
}

const ORIGINAL = 'package main\n\nfunc f(value int) int {\n' +
    '\treturn value\n}\n'
const CHANGED = 'package main\n\nfunc f(value int) int {\n' +
    '\tif value < 0 {\n\t\treturn 0\n\t}\n\treturn value\n}\n'

// Go settingsRepo: a repository with one commit and an uncommitted
// change to main.go, a config on a fake chat server, and finder and
// verifier keys in the environment. The process chdirs into the
// repository so nothing leaks into this checkout.
export async function settingsRepo (
    t:CleanupTest,
    script:Script = finderScript(),
    opts:{ config?:object|null, approve?:boolean } = {}
):Promise<ReviewRepo> {
    const r = tempRepo('roast-review-')
    t.cleanup(r.remove)
    const cwd = process.cwd()
    process.chdir(r.dir)
    t.cleanup(() => process.chdir(cwd))
    const server = await startInferenceServer(script)
    t.cleanup(() => server.close())
    r.env.ROAST_FINDER_API_KEY = FINDER_KEY
    r.env.ROAST_VERIFIER_API_KEY = VERIFIER_KEY
    fs.writeFileSync(path.join(r.dir, 'main.go'), ORIGINAL)
    gitIn(r, ['add', 'main.go'])
    gitIn(r, ['commit', '-q', '-m', 'initial'])
    fs.writeFileSync(path.join(r.dir, 'main.go'), CHANGED)
    if (opts.config !== null) {
        writeConfig(r.dir, opts.config ?? profileConfig(server.url))
    }
    const repo:ReviewRepo = {
        ...r,
        server,
        roast:(args, o = {}) => runRoast(args, {
            cwd:o.cwd ?? r.dir,
            env:r.env,
            stdin:o.stdin,
            signal:o.signal,
            redirectTo:server.url,
        }),
    }
    if (opts.approve !== false && opts.config !== null) {
        await approveProjectConfig(repo)
    }
    return repo
}

// `roast trust --yes` for the discovered (or given) config.
export async function approveProjectConfig (
    r:ReviewRepo,
    args:string[] = [],
    cwd = r.dir
):Promise<void> {
    const res = await runRoast(['trust', '--yes', ...args],
        { cwd, env:r.env })
    if (res.code !== 0) throw new Error(`trust failed: ${res.stderr}`)
}

// Inference requests the fake server received (it serves nothing else).
export function requestRecorder (r:ReviewRepo):() => RecordedRequest[] {
    const start = r.server.requests.length
    return () => r.server.requests.slice(start)
}

export function runsDir (r:TempDir):string {
    return path.join(r.dir, '.roast', 'runs')
}

// The run directories a review wrote, sorted.
export function runDirs (r:TempDir):string[] {
    const dir = runsDir(r)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes:true })
        .filter(e => e.isDirectory())
        .map(e => path.join(dir, e.name))
        .sort()
}

// The parsed meta.json of the only run.
export function reviewMeta (r:TempDir):Record<string, any> {
    const dirs = runDirs(r)
    if (dirs.length !== 1) {
        throw new Error(`expected one run, found ${dirs.length}`)
    }
    return JSON.parse(fs.readFileSync(path.join(dirs[0], 'meta.json'),
        'utf8'))
}

export function readGz (file:string):string {
    return gunzipSync(fs.readFileSync(file)).toString('utf8')
}

// Every file under `dir`, recursively.
export function filesUnder (dir:string):string[] {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes:true, recursive:true })
        .filter(e => e.isFile())
        .map(e => path.join(e.parentPath, e.name))
}
