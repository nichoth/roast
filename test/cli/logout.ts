import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { tempDir, tempRepo } from '../helpers/repo.js'
import { runRoast } from '../helpers/run.js'
import { providerServer } from '../helpers/provider-server.js'
import { loadProjectConfig } from '../../src/cli/config.js'
import { resolveRole } from '../../src/config/role.js'
import {
    loadCredentials,
    saveCredential,
} from '../../src/credentials/credentials.js'

test('logout removes only the named project key from role resolution',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        const server = await providerServer()
        t.cleanup(() => server.close())
        const file = path.join(repo.dir, '.git', 'roast', 'credentials.json')
        await saveCredential(file, 'anthropic', 'sk-anthropic', new Date())
        await saveCredential(file, 'openai', 'sk-openai', new Date())
        fs.writeFileSync(path.join(repo.dir, '.roast.jsonc'), JSON.stringify({
            version:1,
            inference_profiles:{
                a:{ protocol:'anthropic', model:'claude-x' },
            },
            roles:{ finder:{ profile:'a' }, verifier:{ profile:'a' } },
        }))
        const result = await runRoast(['logout', 'anthropic'], {
            cwd:repo.dir, env:repo.env, redirectTo:server.url,
        })
        t.equal(result.code, 0, 'logout succeeds without terminal')
        const entries = await loadCredentials(file)
        t.equal(entries.has('anthropic'), false, 'named key removed')
        t.equal(entries.get('openai')?.key, 'sk-openai', 'other key kept')
        const cfg = await loadProjectConfig('', {
            cwd:repo.dir,
            env:repo.env,
            signal:new AbortController().signal,
        })
        t.equal(resolveRole(cfg, 'finder', repo.env).apiKey, '',
            'later role resolution has no credential')
        t.equal(server.requests.length, 0, 'no credential sent')
    })

test('logout with nothing stored succeeds without creating files',
    async t => {
        for (const outside of [false, true]) {
            const repo = outside ? tempDir() : tempRepo()
            t.cleanup(repo.remove)
            for (const args of [[], ['anthropic'], ['--global'],
                ['openai', '--global']]) {
                if (outside && !args.includes('--global')) continue
                const result = await runRoast(['logout', ...args], {
                    cwd:repo.dir, env:repo.env,
                })
                t.equal(result.code, 0, 'empty scope succeeds')
                t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                    'no project state created')
                t.ok(!fs.existsSync(path.join(repo.env.XDG_CONFIG_HOME,
                    'roast')), 'no user state created')
            }
        }
    })

test('logout usage errors preserve stored keys and send no requests',
    async t => {
        const server = await providerServer()
        t.cleanup(() => server.close())
        for (const outside of [false, true]) {
            const repo = outside ? tempDir() : tempRepo()
            t.cleanup(repo.remove)
            const file = path.join(repo.env.XDG_CONFIG_HOME, 'roast',
                'credentials.json')
            await saveCredential(file, 'anthropic', 'sk-keep', new Date())
            const before = fs.readFileSync(file, 'utf8')
            for (const args of [['unknown'], ['Anthropic', '--global'],
                ['anthropic', 'openai'], ['--no-browser'],
                ...(outside ? [[], ['anthropic']] : [])]) {
                const result = await runRoast(['logout', ...args], {
                    cwd:repo.dir, env:repo.env, redirectTo:server.url,
                })
                t.equal(result.code, 2, 'invalid logout is usage error')
                t.equal(fs.readFileSync(file, 'utf8'), before,
                    'user credentials unchanged')
                t.ok(!fs.existsSync(path.join(repo.dir, '.git', 'roast')),
                    'no project state created')
            }
        }
        t.equal(server.requests.length, 0, 'no network requests')
    })

test('logout deletes named or all providers only in the selected scope',
    async t => {
        for (const global of [false, true]) {
            for (const name of ['anthropic', undefined]) {
                const repo = tempRepo()
                t.cleanup(repo.remove)
                const project = path.join(repo.dir, '.git', 'roast',
                    'credentials.json')
                const user = path.join(repo.env.XDG_CONFIG_HOME, 'roast',
                    'credentials.json')
                for (const file of [project, user]) {
                    for (const provider of ['openai', 'anthropic',
                        'openrouter']) {
                        await saveCredential(file, provider,
                            `sk-${provider}`, new Date())
                    }
                }
                const other = global ? project : user
                const before = fs.readFileSync(other, 'utf8')
                const result = await runRoast(['logout',
                    ...(name ? [name] : []),
                    ...(global ? ['--global'] : []),
                ], { cwd:repo.dir, env:repo.env })
                t.equal(result.code, 0, 'logout succeeds')
                const entries = await loadCredentials(global ? user : project)
                t.deepEqual([...entries.keys()],
                    name ? ['openai', 'openrouter'] : [],
                    'only selected providers removed')
                t.equal(fs.readFileSync(other, 'utf8'), before,
                    'other scope unchanged byte for byte')
            }
        }
    })
