import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { tempDir } from '../helpers/repo.js'
import {
    inspect,
    install,
    installationTargets,
    lookPath,
    skillHooks,
} from '../../src/skill/skill.js'

function scratch (t:{ cleanup (fn:() => void):void }):string {
    const dir = tempDir('roast-skill-')
    t.cleanup(dir.remove)
    return dir.dir
}

test('install then inspect is up_to_date; an edit makes it stale', async t => {
    const target = path.join(scratch(t), 'roast')
    let status = await inspect(target)
    t.equal(status.state, 'not_installed', 'nothing installed yet')

    status = await install(target, false)
    t.equal(status.state, 'up_to_date', 'install leaves it up to date')
    t.ok(fs.existsSync(path.join(target, 'SKILL.md')), 'SKILL.md written')

    fs.writeFileSync(path.join(target, 'SKILL.md'), 'local edit\n')
    status = await inspect(target)
    t.equal(status.state, 'stale', 'an edited file is stale')
    t.deepEqual(status.stale, ['SKILL.md'], 'the edited file is listed')

    let failed = false
    try {
        await install(target, false)
    } catch {
        failed = true
    }
    t.ok(failed, 'install without force refuses to overwrite')
    t.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'),
        'local edit\n', 'the edit is preserved')

    status = await install(target, true)
    t.equal(status.state, 'up_to_date', 'install with force restores it')
})

test('a bundled path that is a symlink in the target is refused', async t => {
    const root = scratch(t)
    const target = path.join(root, 'roast')
    fs.mkdirSync(target)
    const outside = path.join(root, 'outside')
    fs.writeFileSync(outside, 'do not replace')
    fs.symlinkSync(outside, path.join(target, 'SKILL.md'))

    let failed = false
    try {
        await install(target, true)
    } catch {
        failed = true
    }
    t.ok(failed, 'install refuses to follow the symlink')
    t.equal(fs.readFileSync(outside, 'utf8'), 'do not replace',
        'nothing was written through the symlink')
    t.ok(fs.lstatSync(path.join(target, 'SKILL.md')).isSymbolicLink(),
        'the symlink itself is left in place')
})

test('a symlinked target is a development install, never modified',
    async t => {
        const root = scratch(t)
        const source = path.join(root, 'source')
        fs.mkdirSync(source)
        const target = path.join(root, 'roast')
        fs.symlinkSync(source, target)

        let status = await inspect(target)
        t.equal(status.state, 'symlink', 'inspect reports symlink')
        status = await install(target, true)
        t.equal(status.state, 'symlink', 'install reports symlink')
        t.deepEqual(fs.readdirSync(source), [],
            'nothing written through the symlinked target')
    })

// Makes lookPath report exactly `found` until the test ends.
function stubLookPath (
    t:{ cleanup (fn:() => void):void },
    found:string[]
):void {
    const saved = skillHooks.lookPath
    skillHooks.lookPath = async name => found.includes(name)
    t.cleanup(() => { skillHooks.lookPath = saved })
}

test('installationTargets includes the harnesses lookPath detects',
    async t => {
        stubLookPath(t, ['claude', 'polytoken'])
        const home = path.join(scratch(t), 'home')
        const env = { HOME:home, PATH:'/usr/bin' }
        const targets = await installationTargets('', '', { env })
        const polytoken = path.join(home, '.config', 'polytoken', 'skills')
        t.deepEqual(targets, [
            {
                harness:'agents',
                parent:path.join(home, '.agents', 'skills'),
                path:path.join(home, '.agents', 'skills', 'roast'),
            },
            {
                harness:'claude',
                parent:path.join(home, '.claude', 'skills'),
                path:path.join(home, '.claude', 'skills', 'roast'),
            },
            {
                harness:'polytoken',
                parent:polytoken,
                path:path.join(polytoken, 'roast'),
            },
        ], 'agents, claude, and polytoken targets')
    })

test('installationTargets skips undetected harnesses', async t => {
    stubLookPath(t, [])
    const home = path.join(scratch(t), 'home')
    const targets = await installationTargets('', '', { env:{ HOME:home } })
    t.deepEqual(targets.map(x => x.harness), ['agents'], 'only agents')
})

test('installationTargets expands ~ in a configured root', async t => {
    stubLookPath(t, [])
    const home = path.join(scratch(t), 'home')
    const env = {
        HOME:home,
        CLAUDE_CONFIG_DIR:'~/claude-config',
        XDG_CONFIG_HOME:'~',
    }
    fs.mkdirSync(path.join(home, 'polytoken'), { recursive:true })
    const targets = await installationTargets('', '', { env })
    t.deepEqual(targets.map(x => x.parent), [
        path.join(home, '.agents', 'skills'),
        path.join(home, 'claude-config', 'skills'),
        path.join(home, 'polytoken', 'skills'),
    ], 'claude under ~/claude-config, polytoken under ~')
})

test('installationTargets: --dir is custom, a project root is local',
    async t => {
        stubLookPath(t, [])
        const root = scratch(t)
        const home = path.join(root, 'home')
        const custom = await installationTargets(path.join(root, 'p'), '',
            { env:{} })
        t.deepEqual(custom, [{
            harness:'custom',
            parent:path.join(root, 'p'),
            path:path.join(root, 'p', 'roast'),
        }], 'a parent needs no home')

        const project = path.join(root, 'project')
        fs.mkdirSync(path.join(project, '.claude'), { recursive:true })
        const local = await installationTargets('', project,
            { env:{ HOME:home } })
        t.deepEqual(local.map(x => x.parent), [
            path.join(project, '.agents', 'skills'),
            path.join(project, '.claude', 'skills'),
        ], 'project .agents, plus .claude when the project has one')

        let failed = false
        try {
            await installationTargets('', project, { env:{} })
        } catch {
            failed = true
        }
        t.ok(failed, 'a missing HOME is an error')
    })

test('lookPath finds executable regular files on an absolute PATH',
    async t => {
        const root = scratch(t)
        const bin = path.join(root, 'bin')
        fs.mkdirSync(path.join(bin, 'dir-tool'), { recursive:true })
        fs.writeFileSync(path.join(bin, 'tool'), '#!/bin/sh\n',
            { mode:0o755 })
        fs.writeFileSync(path.join(bin, 'plain'), 'x', { mode:0o644 })
        const env = { PATH:['relative', bin].join(path.delimiter) }
        t.equal(await lookPath('tool', env), true, 'executable found')
        t.equal(await lookPath('plain', env), false, 'not executable')
        t.equal(await lookPath('dir-tool', env), false, 'a directory')
        t.equal(await lookPath('absent', env), false, 'missing')
        t.equal(await lookPath('tool', { PATH:'' }), false, 'empty PATH')
    })
