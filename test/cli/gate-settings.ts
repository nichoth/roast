// The hidden `roast gate settings` (spec 12, 2.10): what the pre-commit
// hook reads from the toplevel config.
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { tempRepo, type TempDir } from '../helpers/repo.js'
import { UsageError } from '../../src/cli/errors.js'

function repo (t:CleanupTest, config?:string):TempDir {
    const r = tempRepo()
    t.cleanup(r.remove)
    if (config !== undefined) {
        fs.writeFileSync(path.join(r.dir, '.roast.json'), config)
    }
    return r
}

// The two lines `gate settings` prints, as a map.
function settings (stdout:string):Record<string, string> {
    const out:Record<string, string> = {}
    for (const line of stdout.split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
    }
    return out
}

test('gate settings come from the project config', async t => {
    const r = repo(t, `{"version": 1,
        "gate": {"timeout_seconds": 42, "severity": "medium"}}`)
    const res = await runRoast(['gate', 'settings'],
        { cwd:r.dir, env:r.env })
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.deepEqual(settings(res.stdout),
        { timeout_seconds:'42', severity:'MEDIUM' },
        'the configured timeout and the upper-cased severity')

    const withEnv = await runRoast(['gate', 'settings'], {
        cwd:r.dir,
        env:{
            ...r.env,
            ROAST_GATE_TIMEOUT:'7',
            ROAST_GATE_SEVERITY:'LOW',
        },
    })
    t.equal(withEnv.code, 0, 'exits 0 with the retired variables set')
    t.equal(withEnv.stdout, res.stdout, 'the environment changes nothing')
})

test('gate settings default when unset', async t => {
    const r = repo(t, '{"version": 1}')
    const res = await runRoast(['gate', 'settings'],
        { cwd:r.dir, env:r.env })
    t.equal(res.code, 0, 'exits 0')
    t.deepEqual(settings(res.stdout),
        { timeout_seconds:'180', severity:'HIGH' }, 'the defaults')
})

test('gate settings reads the nearest config from a subdirectory', async t => {
    const r = repo(t, '{"version": 1, "gate": {"timeout_seconds": 9}}')
    const sub = path.join(r.dir, 'a', 'b')
    fs.mkdirSync(sub, { recursive:true })
    const res = await runRoast(['gate', 'settings'], { cwd:sub, env:r.env })
    t.equal(res.code, 0, 'exits 0')
    t.equal(settings(res.stdout).timeout_seconds, '9', 'found upward')
})

test('gate settings --config names the file', async t => {
    const r = repo(t, '{"version": 1}')
    const other = path.join(r.dir, 'other.json')
    fs.writeFileSync(other, '{"version": 1, "gate": {"severity": "low"}}')
    const res = await runRoast(['gate', 'settings', '--config', other],
        { cwd:r.dir, env:r.env })
    t.equal(res.code, 0, 'exits 0')
    t.equal(settings(res.stdout).severity, 'LOW', 'the named config wins')
})

test('gate settings without a config is a usage error', async t => {
    const r = repo(t)
    // A user-level config must never be read.
    const userDir = path.join(r.env.XDG_CONFIG_HOME, 'roast')
    fs.mkdirSync(userDir, { recursive:true })
    for (const name of ['config.json', '.roast.json', 'config.jsonc']) {
        fs.writeFileSync(path.join(userDir, name), '{"version": 1}')
    }
    fs.writeFileSync(path.join(r.env.HOME, '.roast.json'), '{"version": 1}')
    const res = await runRoast(['gate', 'settings'],
        { cwd:r.dir, env:r.env })
    t.equal(res.code, 2, 'exits 2')
    t.ok(res.error instanceof UsageError, 'a usage error')
    t.equal(res.stdout, '', 'prints no settings')
    t.ok(res.stderr.includes('npx roast init'), 'names npx roast init')
})

test('gate settings rejects an invalid gate section', async t => {
    const cases = [
        '"severity": "SEVERE"',
        '"timeout_seconds": -1',
        '"offer": "no"',
    ]
    for (const body of cases) {
        const r = repo(t, `{"version": 1, "gate": {${body}}}`)
        const res = await runRoast(['gate', 'settings'],
            { cwd:r.dir, env:r.env })
        t.equal(res.code, 2, `${body} exits 2`)
        t.ok(res.error instanceof UsageError, 'a usage error')
        t.equal(res.stdout, '', 'prints no settings')
    }
})

test('gate settings is hidden from help', async t => {
    const res = await runRoast(['gate', '--help'])
    t.equal(res.code, 0, 'gate help exits 0')
    t.ok(!/\bsettings\b/.test(res.stdout), 'settings is not listed')
})
