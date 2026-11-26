// loadProjectConfig attaches the stored-credentials store (spec 03, 2.13;
// spec 02, 2.6), so roles on a built-in endpoint resolve a stored key.
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { tempRepo } from '../helpers/repo.js'
import { loadProjectConfig } from '../../src/cli/config.js'
import { describeSource } from '../../src/config/credential.js'
import { resolveRole } from '../../src/config/role.js'
import { saveCredential } from '../../src/credentials/credentials.js'

const STORED = 'sk-ant-stored-0123'

// A temp repo whose .roast.jsonc puts the finder on Anthropic's default
// endpoint and the verifier on a custom endpoint with its own variable.
function storedRepo (t:CleanupTest) {
    const r = tempRepo()
    t.cleanup(r.remove)
    fs.writeFileSync(path.join(r.dir, '.roast.jsonc'), JSON.stringify({
        version:1,
        inference_profiles:{
            claude:{ protocol:'anthropic', model:'claude-x' },
            gateway:{
                protocol:'chat',
                endpoint:'https://gateway.example/v1',
                api_key_env:'GATEWAY_KEY',
                model:'m',
            },
        },
        roles:{
            finder:{ profile:'claude' },
            verifier:{ profile:'gateway' },
        },
    }))
    const project = path.join(r.dir, '.git', 'roast', 'credentials.json')
    const ctx = (env:Record<string, string> = {}) => ({
        cwd:r.dir,
        env:{ ...r.env, ...env },
        signal:new AbortController().signal,
    })
    return { ...r, project, ctx }
}

test('a loaded config resolves a project stored key', async t => {
    const r = storedRepo(t)
    await saveCredential(r.project, 'anthropic', STORED, new Date())
    const ctx = r.ctx()
    const cfg = await loadProjectConfig('', ctx)
    const role = resolveRole(cfg, 'finder', ctx.env)
    t.equal(role.apiKey, STORED, 'stored key resolved')
    t.equal(role.credential.kind, 'stored', 'stored source')
    t.equal(role.credential.scope, 'project', 'project scope')
    t.equal(role.credential.provider, 'anthropic', 'provider named')
    const shown = describeSource(role.credential)
    t.ok(shown.includes('project') && shown.includes('anthropic'),
        'description names scope and provider')
    t.ok(!shown.includes(STORED), 'description never shows the key')
    t.ok(!JSON.stringify(role).includes(STORED), 'role JSON omits the key')

    const envCtx = r.ctx({ ANTHROPIC_API_KEY:'sk-ant-env' })
    const envCfg = await loadProjectConfig('', envCtx)
    const envRole = resolveRole(envCfg, 'finder', envCtx.env)
    t.equal(envRole.apiKey, 'sk-ant-env', 'an env key wins')
    t.equal(envRole.credential.kind, 'provider_env', 'env source')
})

test('a role that never reaches the stored step ignores a broken file',
    async t => {
        const r = storedRepo(t)
        fs.mkdirSync(path.dirname(r.project), { recursive:true })
        fs.writeFileSync(r.project, 'not json', { mode:0o600 })
        const ctx = r.ctx({
            ANTHROPIC_API_KEY:'sk-ant-env',
            GATEWAY_KEY:'gw-key',
        })
        const cfg = await loadProjectConfig('', ctx)
        t.equal(resolveRole(cfg, 'finder', ctx.env).apiKey, 'sk-ant-env',
            'env key resolves')
        t.equal(resolveRole(cfg, 'verifier', ctx.env).apiKey, 'gw-key',
            'custom endpoint resolves')

        const bare = r.ctx()
        const bareCfg = await loadProjectConfig('', bare)
        let err:unknown
        try {
            resolveRole(bareCfg, 'finder', bare.env)
        } catch (e) {
            err = e
        }
        t.ok(err, 'a role reaching the broken file fails')
    })
