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
import { SUGGESTED_MODELS } from '../../src/config/defaults.js'
import { lookupProvider } from '../../src/config/provider.js'
import { roleKeyVar } from '../../src/config/credential.js'
import {
    requiresApproval, trustProjection, trustHash,
} from '../../src/config/trust.js'
import { isApproved } from '../../src/trust/trust.js'

async function initLoginRepo (t:CleanupTest, terminals:boolean) {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const server = await providerServer()
    t.cleanup(() => server.close())
    simulateTerminals(t, terminals)
    const opened = captureBrowser(t)
    const project = path.join(repo.dir, '.env.roast')
    const user = path.join(repo.env.XDG_CONFIG_HOME!, 'roast/credentials.json')
    const run = (stdin:string, args:Array<string> = [],
        env = repo.env) => runRoast(['init', ...args], {
        cwd:repo.dir, env, stdin, redirectTo:server.url,
    })
    return { repo, server, opened, project, user, run }
}

test('init rejects existing config before any other work', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    fs.writeFileSync(
        path.join(repo.dir, '.roast.jsonc'),
        '{"version":1}'
    )
    const original = fs.readFileSync(
        path.join(repo.dir, '.roast.jsonc')
    )
    const result = await runRoast(['init', '--no-login'], {
        cwd:repo.dir, env:repo.env,
    })
    t.equal(result.code, 2, 'exit code is usage error')
    t.ok(
        result.stderr.includes('already exists'),
        'mentions already exists'
    )
    t.deepEqual(
        fs.readFileSync(path.join(repo.dir, '.roast.jsonc')),
        original,
        'file unchanged'
    )
    t.ok(
        !fs.existsSync(path.join(repo.dir, '.gitignore')),
        'no gitignore added'
    )
})

test('init rejects unplaceable models before writing anything', async t => {
    for (const role of ['finder', 'verifier']) {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const result = await runRoast(['init', `--${role}-model`,
            'unknown-model'], { cwd:repo.dir, env:repo.env })
        t.equal(result.code, 2)
        t.ok(result.stderr.includes(`--${role}-model`))
        t.ok(!fs.existsSync(path.join(repo.dir, '.roast.jsonc')))
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
        const file = path.join(repo.dir, '.roast.jsonc')
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
    const cfg = loadConfig(path.join(repo.dir, '.roast.jsonc'))
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
        t.ok(fs.existsSync(path.join(cwd, '.roast.jsonc')))
        t.ok(!fs.existsSync(path.join(repo.dir, '.roast.jsonc')))
        t.equal(fs.readFileSync(path.join(repo.dir, '.gitignore'), 'utf8'),
            'existing\n/.roast/\n/.env.roast\n/.env.roast.tmp-*\n')
        t.ok(!fs.existsSync(path.join(cwd, '.gitignore')))
    })

test('init outside Git writes nothing', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const result = await runRoast(['init'], { cwd:dir.dir, env:dir.env })
    t.equal(result.code, 2)
    t.ok(!fs.existsSync(path.join(dir.dir, '.roast.jsonc')))
    t.ok(!fs.existsSync(path.join(dir.dir, '.gitignore')))
})

test('init schema reference points into the installed package', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const result = await runRoast(['init', '--no-login'], {
        cwd:repo.dir, env:repo.env,
    })
    t.equal(result.code, 0)
    const cfg = loadConfig(path.join(repo.dir, '.roast.jsonc'))
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
    const result = await r.run('n\nn\n', [
        '--finder-model', 'claude-opus-5-5',
        '--verifier-model', 'gpt-5',
    ])
    t.equal(result.code, 0)
    t.ok(!fs.existsSync(r.project))
    t.ok(!fs.existsSync(r.user))
    t.equal(r.server.requests.length, 0)
    t.deepEqual(r.opened, [])
})

test('init no-login and nonterminal runs never offer login', async t => {
    const modelFlags = [
        '--finder-model', 'claude-opus-5-5',
        '--verifier-model', 'gpt-5',
    ]
    for (const terminals of [false, true]) {
        const r = await initLoginRepo(t, terminals)
        const result = await r.run('y\nunused-key\ny\nunused-key\n',
            terminals ?
                ['--no-login', ...modelFlags] : modelFlags)
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
        const result = await r.run(
            'y\nwrong1\nwrong2\nwrong3\nn\n', [
                '--finder-model', 'gpt-5',
                '--verifier-model', 'claude-opus-5-5',
            ])
        t.equal(result.code, 0)
        t.ok(fs.existsSync(path.join(r.repo.dir, '.roast.jsonc')))
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
            'y\nsk-second\n', [
            '--finder-model', 'gpt-5',
            '--verifier-model', 'claude-opus-5-5',
        ])
        t.equal(result.code, 0)
        const stored = await loadCredentials(r.project)
        t.ok(!stored.has('openai'))
        t.equal(stored.get('anthropic')?.key, 'sk-second')
        t.equal(r.server.requests.length, 4)
        t.ok(!fs.existsSync(r.user))
    })

test('init skips offers when roles already have credentials', async t => {
    const r = await initLoginRepo(t, true)
    const result = await r.run('y\nunused\n', [
        '--finder-model', 'claude-opus-5-5',
        '--verifier-model', 'gpt-5',
    ], {
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

// -- Ticket 02: interactive provider and model prompts --

test('init prompts provider by number and accepts suggested model',
    async t => {
        // Provider menu: 1=Anthropic, 2=OpenAI, 3=OpenRouter
        const providers = [
            {
                num:'1',
                name:'anthropic',
                key:'ANTHROPIC_API_KEY',
            },
            {
                num:'2',
                name:'openai',
                key:'OPENAI_API_KEY',
            },
            {
                num:'3',
                name:'openrouter',
                key:'OPENROUTER_API_KEY',
            },
        ] as const
        for (const p of providers) {
            const repo = tempRepo()
            t.cleanup(repo.remove)
            simulateTerminals(t, true)
            const otherNum = p.num === '1' ? '2' :
                p.num === '2' ? '1' : '3'
            const stdin = `${p.num}\n\n${otherNum}\n\n`
            const result = await runRoast(
                ['init', '--no-login'], {
                    cwd:repo.dir, env:repo.env, stdin,
                })
            t.equal(result.code, 0,
                `exit 0 for provider ${p.name}`)
            const file = path.join(repo.dir, '.roast.jsonc')
            t.ok(fs.existsSync(file), 'config written')
            const cfg = loadConfig(file)
            const suggested = SUGGESTED_MODELS[
                p.name as keyof typeof SUGGESTED_MODELS
            ]
            const model = typeof suggested === 'string' ?
                suggested : suggested[0]
            const role = resolveRole(cfg, 'finder', {
                [p.key]:'test-key',
            })
            t.equal(role.model, model,
                `finder model is suggested for ${p.name}`)
            const prov = lookupProvider(p.name)!
            t.equal(role.baseURL, prov.endpoint,
                `finder endpoint matches ${p.name}`)
        }
    })

test('init prompts provider by name and accepts typed model',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        const stdin = 'anthropic\nclaude-opus-5-5\n' +
            'openai\ngpt-5\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            ANTHROPIC_API_KEY:'k',
        })
        t.equal(finder.model, 'claude-opus-5-5')
        t.equal(finder.baseURL,
            'https://api.anthropic.com/v1')
        const verifier = resolveRole(cfg, 'verifier', {
            OPENAI_API_KEY:'k',
        })
        t.equal(verifier.model, 'gpt-5')
        t.equal(verifier.baseURL,
            'https://api.openai.com/v1')
    })

test('init verifier default is otherProvider of finder choice',
    async t => {
        // Finder=Anthropic -> verifier default=OpenAI
        // Accept both defaults with empty lines
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // Choose anthropic for finder, accept defaults for rest
        const stdin = '1\n\n\n\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const verifier = resolveRole(cfg, 'verifier', {
            OPENAI_API_KEY:'k',
        })
        t.equal(verifier.baseURL,
            'https://api.openai.com/v1',
            'verifier on openai when finder is anthropic')
    })

test('init with --finder-model only prompts verifier',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // Only verifier prompt: pick anthropic, accept default
        const stdin = '1\n\n'
        const result = await runRoast(
            ['init', '--no-login',
                '--finder-model', 'gpt-5'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            OPENAI_API_KEY:'k',
        })
        t.equal(finder.model, 'gpt-5',
            'finder uses flag model')
        const verifier = resolveRole(cfg, 'verifier', {
            ANTHROPIC_API_KEY:'k',
        })
        t.equal(verifier.model, SUGGESTED_MODELS.anthropic,
            'verifier uses prompted model')
    })

test('init with both model flags reads no stdin', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    const result = await runRoast(
        ['init', '--no-login',
            '--finder-model', 'gpt-5',
            '--verifier-model', 'claude-opus-5-5'], {
            cwd:repo.dir, env:repo.env, stdin:'',
        })
    t.equal(result.code, 0)
    const cfg = loadConfig(
        path.join(repo.dir, '.roast.jsonc')
    )
    const finder = resolveRole(cfg, 'finder', {
        OPENAI_API_KEY:'k',
    })
    t.equal(finder.model, 'gpt-5')
    const verifier = resolveRole(cfg, 'verifier', {
        ANTHROPIC_API_KEY:'k',
    })
    t.equal(verifier.model, 'claude-opus-5-5')
})

test('init without interactive terminals writes placeholders',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, false)
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin:'',
            })
        t.equal(result.code, 0)
        t.ok(result.stderr.includes('--finder-model'),
            'hint mentions --finder-model')
        t.ok(result.stderr.includes('--verifier-model'),
            'hint mentions --verifier-model')
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {})
        t.ok(finder.model.startsWith('<'),
            'finder has placeholder')
    })

test('init invalid menu choice then valid succeeds', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    // "9" is invalid, then "1" for anthropic, accept model,
    // accept verifier defaults
    const stdin = '9\n1\n\n\n\n'
    const result = await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.equal(result.code, 0)
    t.ok(fs.existsSync(path.join(repo.dir, '.roast.jsonc')))
})

test('init model mismatch then valid model succeeds',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // Choose anthropic, type an openai model (mismatch),
        // then valid anthropic model
        const stdin = '1\ngpt-5\nclaude-opus-5-5\n\n\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        t.ok(result.stderr.includes(
            'does not place onto anthropic'))
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            ANTHROPIC_API_KEY:'k',
        })
        t.equal(finder.model, 'claude-opus-5-5')
    })

test('init EOF partway through writes nothing', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    // Provide just the provider answer, then EOF
    const stdin = '1\n'
    await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.ok(!fs.existsSync(path.join(repo.dir, '.roast.jsonc')),
        'no config written')
    t.ok(!fs.existsSync(path.join(repo.dir, '.gitignore')),
        'no gitignore')
})

test('init existing config rejected before any stdin read',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        fs.writeFileSync(
            path.join(repo.dir, '.roast.jsonc'),
            '{"version":1}'
        )
        const result = await runRoast(['init'], {
            cwd:repo.dir, env:repo.env, stdin:'',
        })
        t.equal(result.code, 2)
        t.ok(result.stderr.includes('already exists'))
    })

test('init same model note when both roles use same model',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // Choose openai for both, same model
        const stdin = '2\ngpt-5\n2\ngpt-5\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        t.ok(result.stderr.includes('verification adds little'),
            'same-model note printed')
    })

test('init same provider different model has no note',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        const stdin = '2\ngpt-5\n2\ngpt-6.1-terra\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        t.ok(!result.stderr.includes('verification adds little'),
            'no note for different models')
    })

test('init login offer runs after interactive prompts',
    async t => {
        const r = await initLoginRepo(t, true)
        // Choose openai for finder (2), accept default model,
        // accept verifier defaults (anthropic), accept default model,
        // then answer login offers
        const stdin = '2\n\n\n\n' +
            'y\nsk-anthropic\ny\nsk-openai\n'
        const result = await r.run(stdin)
        t.equal(result.code, 0)
        const stored = await loadCredentials(r.project)
        t.ok(
            stored.has('anthropic') || stored.has('openai'),
            'at least one credential stored'
        )
    })

// -- Ticket 03: custom endpoint choice --

test('init custom endpoint with key variable resolves correctly',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // finder: custom (4), endpoint, protocol (default),
        // key var, model
        // verifier: anthropic (1), accept default model
        const stdin = [
            '4',
            'http://openai.api.tiiny/v1',
            '',
            'TIINY_KEY',
            'Qwen/Qwen3.6-35B-A3B',
            '1',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0, 'exit 0')
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            TIINY_KEY:'my-key',
        })
        t.equal(finder.baseURL,
            'http://openai.api.tiiny/v1')
        t.equal(finder.protocol, 'chat')
        t.equal(finder.model, 'Qwen/Qwen3.6-35B-A3B')
        t.equal(finder.apiKey, 'my-key')
        t.equal(finder.credential.env, 'TIINY_KEY')
    })

test('init custom endpoint blank key variable uses role key var',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        const stdin = [
            '4',
            'http://openai.api.tiiny/v1',
            '',
            '',
            'openai/gpt-oss-20b',
            '1',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const rVar = roleKeyVar('finder')
        const finder = resolveRole(cfg, 'finder', {
            [rVar]:'role-key',
        })
        t.equal(finder.apiKey, 'role-key')
        t.equal(finder.credential.env, rVar)
    })

test('init custom default protocol resolves as chat',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        const stdin = [
            '4',
            'http://localhost:8080/v1',
            '',
            'MY_KEY',
            'my-model',
            '2',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            MY_KEY:'k',
        })
        t.equal(finder.protocol, 'chat')
    })

test('init both roles custom accepting verifier defaults',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // finder: custom endpoint
        // verifier: custom (default because finder was custom),
        //   accept endpoint/protocol/key defaults, type model
        const stdin = [
            '4',
            'http://openai.api.tiiny/v1',
            '',
            'TIINY_KEY',
            'Qwen/Qwen3.6-35B-A3B',
            '',
            '',
            '',
            '',
            'openai/gpt-oss-20b',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            TIINY_KEY:'k',
        })
        const verifier = resolveRole(cfg, 'verifier', {
            TIINY_KEY:'k',
        })
        t.equal(finder.baseURL, verifier.baseURL,
            'same endpoint')
        t.equal(finder.protocol, verifier.protocol,
            'same protocol')
        t.equal(finder.credential.env,
            verifier.credential.env,
            'same credential variable')
    })

test('init custom model with slash stays on custom endpoint',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        const stdin = [
            '4',
            'http://openai.api.tiiny/v1',
            '',
            'TIINY_KEY',
            'Qwen/Qwen3.6-35B-A3B',
            '1',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            TIINY_KEY:'k',
        })
        t.equal(finder.baseURL,
            'http://openai.api.tiiny/v1',
            'on custom endpoint, not openrouter')
        t.equal(finder.model, 'Qwen/Qwen3.6-35B-A3B')
    })

test('init custom blank model writes placeholder', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    const stdin = [
        '4',
        'http://localhost:8080/v1',
        '',
        'MY_KEY',
        '',
        '1',
        '',
    ].join('\n') + '\n'
    const result = await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.equal(result.code, 0)
    const cfg = loadConfig(
        path.join(repo.dir, '.roast.jsonc')
    )
    const finder = resolveRole(cfg, 'finder', {
        MY_KEY:'k',
    })
    t.ok(finder.model.startsWith('<'),
        'placeholder model')
})

test('init invalid endpoint then valid succeeds', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    const stdin = [
        '4',
        'not-a-url',
        'http://localhost:8080/v1',
        '',
        'MY_KEY',
        'my-model',
        '1',
        '',
    ].join('\n') + '\n'
    const result = await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.equal(result.code, 0)
    const cfg = loadConfig(
        path.join(repo.dir, '.roast.jsonc')
    )
    const finder = resolveRole(cfg, 'finder', {
        MY_KEY:'k',
    })
    t.equal(finder.baseURL, 'http://localhost:8080/v1')
})

test('init invalid key variable then valid succeeds',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        const stdin = [
            '4',
            'http://localhost:8080/v1',
            '',
            '1BAD',
            'GOOD_KEY',
            'my-model',
            '1',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            GOOD_KEY:'k',
        })
        t.equal(finder.credential.env, 'GOOD_KEY')
    })

test('init custom model rejects whitespace and control chars',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // custom finder: bad model with space, then bad with
        // tab, then valid model; verifier: openai default
        const stdin = [
            '4',
            'http://localhost:8080/v1',
            '',
            'MY_KEY',
            'my model',
            'my\tmodel',
            'good-model',
            '2',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0, 'succeeds after valid input')
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const finder = resolveRole(cfg, 'finder', {
            MY_KEY:'k',
        })
        t.equal(finder.model, 'good-model',
            'model is the valid one, not the rejected ones')
    })

test('init custom role gets no login offer', async t => {
    const r = await initLoginRepo(t, true)
    // finder: custom, verifier: anthropic with login
    const stdin = [
        '4',
        'http://openai.api.tiiny/v1',
        '',
        'TIINY_KEY',
        'my-model',
        '1',
        '',
        'n',
        'n',
    ].join('\n') + '\n'
    const result = await r.run(stdin)
    t.equal(result.code, 0)
    t.ok(!fs.existsSync(r.project),
        'no credentials stored')
})

test('init trust offer yes approves custom config', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    // custom finder, builtin verifier, then trust yes
    const stdin = [
        '4',
        'http://openai.api.tiiny/v1',
        '',
        'TIINY_KEY',
        'my-model',
        '1',
        '',
        'y',
    ].join('\n') + '\n'
    const result = await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.equal(result.code, 0)
    const cfg = loadConfig(
        path.join(repo.dir, '.roast.jsonc')
    )
    const p = trustProjection(cfg)
    t.ok(requiresApproval(p), 'config needs approval')
    const hash = trustHash(p)
    const state = await isApproved(repo.dir, hash, {
        env:repo.env as NodeJS.ProcessEnv,
    })
    t.equal(state, 'approved', 'trust recorded')
})

test('init trust offer no leaves unapproved', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    // custom finder, builtin verifier, then trust no
    const stdin = [
        '4',
        'http://openai.api.tiiny/v1',
        '',
        'TIINY_KEY',
        'my-model',
        '1',
        '',
        '',
    ].join('\n') + '\n'
    const result = await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.equal(result.code, 0)
    const cfg = loadConfig(
        path.join(repo.dir, '.roast.jsonc')
    )
    const p = trustProjection(cfg)
    t.ok(requiresApproval(p), 'config needs approval')
    const hash = trustHash(p)
    const state = await isApproved(repo.dir, hash, {
        env:repo.env as NodeJS.ProcessEnv,
    })
    t.equal(state, 'not-approved', 'not approved')
    t.ok(result.stderr.includes('npx roast trust'),
        'hint printed')
})

test('init openrouter suggests opposite vendor from other role',
    async t => {
        // Finder=OpenAI, verifier=OpenRouter: suggested model
        // should be the Anthropic slug (opposite vendor)
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // finder: openai (2), accept default model
        // verifier: openrouter (3), accept default model
        const stdin = '2\n\n3\n\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0)
        const cfg = loadConfig(
            path.join(repo.dir, '.roast.jsonc')
        )
        const verifier = resolveRole(cfg, 'verifier', {
            OPENROUTER_API_KEY:'k',
        })
        t.equal(
            verifier.model,
            SUGGESTED_MODELS.openrouter[0],
            'openrouter suggests anthropic slug when ' +
            'finder is openai'
        )
    })

test('init builtin-only config gets no trust offer', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    simulateTerminals(t, true)
    // Two built-in providers, no extra stdin for trust
    const stdin = '2\n\n1\n\n'
    const result = await runRoast(
        ['init', '--no-login'], {
            cwd:repo.dir, env:repo.env, stdin,
        })
    t.equal(result.code, 0, 'exits 0')
    const file = path.join(repo.dir, '.roast.jsonc')
    t.ok(fs.existsSync(file), 'config written')
    const cfg = loadConfig(file)
    const p = trustProjection(cfg)
    t.ok(!requiresApproval(p),
        'builtin config needs no approval')
    t.ok(!result.stderr.includes('Trust this'),
        'no trust prompt shown')
})

test('init EOF at trust offer leaves config not approved',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        simulateTerminals(t, true)
        // custom finder, builtin verifier, then EOF
        const stdin = [
            '4',
            'http://openai.api.tiiny/v1',
            '',
            'TIINY_KEY',
            'my-model',
            '1',
            '',
        ].join('\n') + '\n'
        const result = await runRoast(
            ['init', '--no-login'], {
                cwd:repo.dir, env:repo.env, stdin,
            })
        t.equal(result.code, 0, 'exits 0')
        const file = path.join(repo.dir, '.roast.jsonc')
        t.ok(fs.existsSync(file), 'config written')
        const cfg = loadConfig(file)
        const p = trustProjection(cfg)
        t.ok(requiresApproval(p),
            'config needs approval')
        const hash = trustHash(p)
        const state = await isApproved(repo.dir, hash, {
            env:repo.env as NodeJS.ProcessEnv,
        })
        t.equal(state, 'not-approved',
            'not approved after EOF')
    })
