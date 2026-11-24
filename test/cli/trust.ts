// `roast trust` (spec 03, 2.7, 2.9, 5.4) run in-process.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test, type CleanupTest } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { tempDir, tempRepo, type TempDir } from '../helpers/repo.js'

const GATEWAY = 'https://gw.example/v1'

// A config with a custom finder, a routed profile, a built-in verifier,
// and two prompt overrides.
const CUSTOM = {
    version:1,
    inference_profiles:{
        gateway_profile:{
            model:'m',
            endpoint:GATEWAY,
            protocol:'chat',
            api_key_env:'GW_KEY',
        },
        routed_profile:{
            model:'m',
            endpoint:'https://routed.example/v2',
            protocol:'responses',
        },
        claude_profile:{ model:'m', protocol:'anthropic' },
    },
    roles:{
        finder:{
            profile:'gateway_profile',
            author_routes:{ openai:'routed_profile' },
        },
        verifier:{ profile:'claude_profile' },
    },
    prompts:{ finder_code:'prompts/code.md', verifier:'verify.md' },
}

const BUILTIN = {
    version:1,
    inference_profiles:{
        o:{ model:'m' },
        a:{ model:'m', protocol:'anthropic' },
    },
    roles:{
        finder:{ profile:'o', author_routes:{ openai:'a' } },
        verifier:{ profile:'a' },
    },
}

function repoWith (t:CleanupTest, cfg:unknown):TempDir {
    const r = tempRepo()
    t.cleanup(r.remove)
    const body = typeof cfg === 'string' ? cfg : JSON.stringify(cfg)
    fs.writeFileSync(path.join(r.dir, '.roast.json'), body)
    return r
}

function stateDir (r:TempDir):string {
    return path.join(r.dir, '.git', 'roast')
}

function approved (r:TempDir):string[] {
    const file = path.join(stateDir(r), 'trust.json')
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8')).approved
}

function trust (
    r:TempDir,
    args:string[] = [],
    stdin:string|NodeJS.ReadableStream = ''
) {
    return runRoast(['trust', ...args], { cwd:r.dir, env:r.env, stdin })
}

test('trust on a built-in-only config needs no approval', async t => {
    const r = repoWith(t, BUILTIN)
    const res = await trust(r)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.ok(!fs.existsSync(stateDir(r)), 'no state directory')
})

test('trust summary names every security-relevant value', async t => {
    const r = repoWith(t, CUSTOM)
    const res = await trust(r, ['--yes'])
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    for (const value of [
        'gateway_profile', 'routed_profile', 'claude_profile',
        GATEWAY, 'https://routed.example/v2', 'https://api.anthropic.com/v1',
        'chat', 'responses', 'anthropic',
        'GW_KEY', 'ANTHROPIC_API_KEY',
        'prompts/code.md', 'verify.md',
        'roles.finder.author_routes.openai',
    ]) {
        t.ok(res.stdout.includes(value), `names ${value}`)
    }
    t.equal(approved(r).length, 1, 'approval recorded')
})

// Bytes 0x00-0x08, 0x0b-0x1f, and 0x7f; newline is the only allowed
// control character in the summary.
function hasRawControl (s:string):boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if ((c < 0x20 && c !== 0x0a) || c === 0x7f) return true
    }
    return false
}

test('trust summary escapes control characters', async t => {
    const r = repoWith(t, `{
  "version": 1,
  "inference_profiles": {
    "evil\\u001b[2J\\nINJECTED": {"endpoint": "https://gw.example/v1",
      "model": "m", "protocol": "chat", "api_key_env": "GW_KEY"}
  },
  "roles": {
    "finder": {"profile": "evil\\u001b[2J\\nINJECTED",
      "author_routes": {"x\\u0007\\nINJECTED": "evil\\u001b[2J\\nINJECTED"}},
    "verifier": {"profile": "evil\\u001b[2J\\nINJECTED"}
  },
  "prompts": {"verifier": "prompt\\r\\nINJECTED\\u0007"}
}`)
    const res = await trust(r, [], 'n\n')
    t.equal(res.code, 2, `declined exits 2 ${res.stderr}`)
    t.ok(res.stdout.includes('evil'), 'summary printed')
    t.ok(!hasRawControl(res.stdout), 'no raw control characters')
    const lines = res.stdout.split('\n')
    t.ok(!lines.some(l => l.trimStart().startsWith('INJECTED')),
        'no config value starts its own line')
})

test('trust usage errors exit 2', async t => {
    const outside = tempDir()
    t.cleanup(outside.remove)
    fs.writeFileSync(path.join(outside.dir, '.roast.json'),
        JSON.stringify(CUSTOM))
    const res = await runRoast(['trust', '--yes'],
        { cwd:outside.dir, env:outside.env })
    t.equal(res.code, 2, 'outside a repository')

    const r = repoWith(t, CUSTOM)
    t.equal((await trust(r, ['--yes', 'extra'])).code, 2, 'extra argument')
    t.deepEqual(approved(r), [], 'extra argument records nothing')

    const none = tempRepo()
    t.cleanup(none.remove)
    const noConfig = await runRoast(['trust', '--yes'],
        { cwd:none.dir, env:none.env })
    t.equal(noConfig.code, 2, 'no config')

    const bad = repoWith(t, { version:1, bogus:true })
    t.equal((await trust(bad, ['--yes'])).code, 2, 'invalid config')
    t.ok(!fs.existsSync(stateDir(bad)), 'nothing written')
})

test('trust records approval only on yes', async t => {
    for (const answer of ['', '\n', 'n\n', 'no\n', 'yy\n', 'sure\n']) {
        const r = repoWith(t, CUSTOM)
        const res = await trust(r, [], answer)
        t.equal(res.code, 2, `${JSON.stringify(answer)} exits 2`)
        t.ok(res.stdout.includes('[y/N]'), 'asks')
        t.ok(!fs.existsSync(stateDir(r)), 'records nothing')
    }
    for (const answer of ['y\n', 'Y\n', 'yes\n', 'y']) {
        const r = repoWith(t, CUSTOM)
        const res = await trust(r, [], answer)
        t.equal(res.code, 0, `${JSON.stringify(answer)} exits 0`)
        t.equal(approved(r).length, 1, 'records one approval')
    }
})

test('trust --yes records approval without reading stdin', async t => {
    let reads = 0
    const stdin = new Readable({
        read () {
            reads++
            this.destroy(new Error('stdin must not be read'))
        },
    })
    const r = repoWith(t, CUSTOM)
    const res = await trust(r, ['--yes'], stdin)
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(reads, 0, 'stdin never read')
    t.equal(approved(r).length, 1, 'approval recorded')
    const again = await trust(r, ['--yes'], stdin)
    t.equal(again.code, 0, 'approving again exits 0')
    t.equal(approved(r).length, 1, 'still one approval')
})

test('trust reports a stdin read error as a non-usage error', async t => {
    const stdin = new Readable({
        read () {
            this.destroy(new Error('broken stdin'))
        },
    })
    const r = repoWith(t, CUSTOM)
    const res = await trust(r, [], stdin)
    t.equal(res.code, 4, 'exits 4')
    t.ok(!fs.existsSync(stateDir(r)), 'records nothing')
})
