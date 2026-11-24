import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { tempDir, tempRepo } from '../helpers/repo.js'
import { runRoast } from '../helpers/run.js'
import { loadConfig } from '../../src/config/load.js'
import { resolveRole, validateRole } from '../../src/config/role.js'
import { thrown } from '../config/helpers.js'
import { providerServer } from '../helpers/provider-server.js'
import { captureBrowser, simulateTerminals } from '../helpers/terminal.js'
import type { CleanupTest } from '../helpers/test.js'
import { loadCredentials } from '../../src/credentials/credentials.js'

async function initLoginRepo (t:CleanupTest, terminals:boolean) {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, terminals)
    const opened = captureBrowser(t)
    const project = path.join(repo.dir, '.git/roast/credentials.json')
    const user = path.join(repo.env.XDG_CONFIG_HOME!, 'roast/credentials.json')
    const run = (stdin:string, args:Array<string> = [],
        env = repo.env) => runRoast(['init', ...args], {
        cwd:repo.dir, env, stdin, redirectTo:server.url,
    })
    return { repo, server, opened, project, user, run }
}

test('init rejects unplaceable models before writing anything', async t => {
    for (const role of ['finder', 'verifier']) {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const result = await runRoast(['init', `--${role}-model`,
            'unknown-model'], { cwd:repo.dir, env:repo.env })
        t.equal(result.code, 2)
        t.ok(result.stderr.includes(`--${role}-model`))
        t.ok(!fs.existsSync(path.join(repo.dir, '.roast.json')))
        t.ok(!fs.existsSync(path.join(repo.dir, '.gitignore')))
    }
})

test('init writes usable model settings and preserves existing bytes',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const args = ['init', '--no-login', '--finder-model', 'gpt-5',
            '--verifier-model', 'claude-opus-5-5']
        const result = await runRoast(args, { cwd:repo.dir, env:repo.env })
        t.equal(result.code, 0)
        const file = path.join(repo.dir, '.roast.json')
        t.ok(result.stdout.includes(file), 'prints the absolute path')
        t.equal(fs.statSync(file).mode & 0o777, 0o644)
        const cfg = loadConfig(file)
        for (const [name, model, key] of [
            ['finder', 'gpt-5', 'openai-key'],
            ['verifier', 'claude-opus-5-5', 'anthropic-key'],
        ] as const) {
            const role = resolveRole(cfg, name, {
                OPENAI_API_KEY:'openai-key',
                ANTHROPIC_API_KEY:'anthropic-key',
            })
            t.equal(role.model, model)
            t.equal(role.apiKey, key)
        }
        const original = fs.readFileSync(file)
        const again = await runRoast(args, { cwd:repo.dir, env:repo.env })
        t.equal(again.code, 2)
        t.deepEqual(fs.readFileSync(file), original)
    })

test('init placeholders fail role validation', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const result = await runRoast(['init', '--no-login'], {
        cwd:repo.dir, env:repo.env,
    })
    t.equal(result.code, 0)
    const cfg = loadConfig(path.join(repo.dir, '.roast.json'))
    for (const name of ['finder', 'verifier'] as const) {
        const err = thrown(() => validateRole(name,
            resolveRole(cfg, name, {})))
        t.ok(err?.message.includes('placeholder'))
    }
})

test('init writes in cwd and ignores state at the repository toplevel',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const cwd = path.join(repo.dir, 'nested')
        fs.mkdirSync(cwd)
        fs.writeFileSync(path.join(repo.dir, '.gitignore'), 'existing')
        const result = await runRoast(['init', '--no-login'], {
            cwd, env:repo.env,
        })
        t.equal(result.code, 0)
        t.ok(fs.existsSync(path.join(cwd, '.roast.json')))
        t.ok(!fs.existsSync(path.join(repo.dir, '.roast.json')))
        t.equal(fs.readFileSync(path.join(repo.dir, '.gitignore'), 'utf8'),
            'existing\n/.roast/\n')
        t.ok(!fs.existsSync(path.join(cwd, '.gitignore')))
    })

test('init outside Git writes nothing', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const result = await runRoast(['init'], { cwd:dir.dir, env:dir.env })
    t.equal(result.code, 2)
    t.ok(!fs.existsSync(path.join(dir.dir, '.roast.json')))
    t.ok(!fs.existsSync(path.join(dir.dir, '.gitignore')))
})

test('init schema reference points into the installed package', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const result = await runRoast(['init', '--no-login'], {
        cwd:repo.dir, env:repo.env,
    })
    t.equal(result.code, 0)
    const cfg = loadConfig(path.join(repo.dir, '.roast.json'))
    t.ok(/^\.\/?node_modules\/@substrate-system\/roast\/[^/]+\.json$/
        .test(cfg.$schema ?? ''))
})

test('init offers each missing provider with shared prompt and key input',
    async t => {
        const r = await initLoginRepo(t, true)
        const result = await r.run('y\nsk-anthropic\ny\nsk-openai\n', [
            '--finder-model', 'claude-opus-5-5',
            '--verifier-model', 'gpt-5',
        ])
        t.equal(result.code, 0)
        const stored = await loadCredentials(r.project)
        t.equal(stored.get('anthropic')?.key, 'sk-anthropic')
        t.equal(stored.get('openai')?.key, 'sk-openai')
        t.ok(!fs.existsSync(r.user), 'no user-scope write')
        t.deepEqual(r.server.credentials,
            ['sk-anthropic', 'Bearer sk-openai'])
        t.equal(r.opened.length, 2)
    })

test('init declining both providers has no login side effects', async t => {
    const r = await initLoginRepo(t, true)
    const result = await r.run('n\nn\n')
    t.equal(result.code, 0)
    t.ok(!fs.existsSync(r.project))
    t.ok(!fs.existsSync(r.user))
    t.equal(r.server.requests.length, 0)
    t.deepEqual(r.opened, [])
})

test('init no-login and nonterminal runs never offer login', async t => {
    for (const terminals of [false, true]) {
        const r = await initLoginRepo(t, terminals)
        const result = await r.run('y\nunused-key\ny\nunused-key\n',
            terminals ? ['--no-login'] : [])
        t.equal(result.code, 0)
        t.ok(!result.stderr.includes('[Y/n]'), 'no login offer')
        t.ok(!fs.existsSync(r.project))
        t.ok(!fs.existsSync(r.user))
        t.equal(r.server.requests.length, 0)
        t.deepEqual(r.opened, [])
    }
})

test('init succeeds after three rejected keys and continues offering',
    async t => {
        const r = await initLoginRepo(t, true)
        r.server.hooks.answerModels = () => 401
        const result = await r.run('y\nwrong1\nwrong2\nwrong3\nn\n')
        t.equal(result.code, 0)
        t.ok(fs.existsSync(path.join(r.repo.dir, '.roast.json')))
        t.ok(!fs.existsSync(r.project))
        t.ok(!fs.existsSync(r.user))
        t.deepEqual(r.server.credentials,
            ['Bearer wrong1', 'Bearer wrong2', 'Bearer wrong3'])
        t.equal(result.stderr.split('[Y/n]').length - 1, 2,
            'failure still offers the next provider')
    })

test('init can store the second provider after the first login fails',
    async t => {
        const r = await initLoginRepo(t, true)
        r.server.hooks.answerModels = key =>
            key.startsWith('Bearer ') ? 403 : 200
        const result = await r.run('y\nwrong1\nwrong2\nwrong3\n' +
            'y\nsk-second\n')
        t.equal(result.code, 0)
        const stored = await loadCredentials(r.project)
        t.ok(!stored.has('openai'))
        t.equal(stored.get('anthropic')?.key, 'sk-second')
        t.equal(r.server.requests.length, 4)
        t.ok(!fs.existsSync(r.user))
    })

test('init skips offers when roles already have credentials', async t => {
    const r = await initLoginRepo(t, true)
    const result = await r.run('y\nunused\n', [], {
        ...r.repo.env,
        OPENAI_API_KEY:'available-openai',
        ANTHROPIC_API_KEY:'available-anthropic',
    })
    t.equal(result.code, 0)
    t.ok(!result.stderr.includes('[Y/n]'))
    t.deepEqual(r.opened, [])
    t.equal(r.server.requests.length, 0)
    t.ok(!fs.existsSync(r.project))
    t.ok(!fs.existsSync(r.user))
})
