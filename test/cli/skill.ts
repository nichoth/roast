import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { tempDir, tempRepo, type TempDir } from '../helpers/repo.js'
import { UsageError } from '../../src/cli/errors.js'
import { skillHooks } from '../../src/skill/skill.js'

// Go isolateSkillHome: HOME is an empty temporary directory, the
// configured-root overrides are empty, and no harness binary is found
// on PATH (PATH itself stays, since the CLI runs git).
function isolateSkillHome (t:CleanupTest, dir:TempDir):string {
    const saved = skillHooks.lookPath
    skillHooks.lookPath = async () => false
    t.cleanup(() => { skillHooks.lookPath = saved })
    dir.env.CLAUDE_CONFIG_DIR = ''
    dir.env.XDG_CONFIG_HOME = ''
    return dir.env.HOME
}

function treeFiles (root:string):string[] {
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root, { recursive:true, withFileTypes:true })
        .filter(e => !e.isDirectory())
        .map(e => path.join(e.parentPath, e.name))
}

// Tab-separated status lines as [harness, state, path, stale?].
function statusLines (stdout:string):string[][] {
    return stdout.split('\n').filter(l => l !== '').map(l => l.split('\t'))
}

test('skill install --dir then status --dir is custom up_to_date',
    async t => {
        const repo = tempRepo()
        t.cleanup(repo.remove)
        isolateSkillHome(t, repo)
        const parent = tempDir('roast-skill-parent-')
        t.cleanup(parent.remove)
        const opts = { cwd:repo.dir, env:repo.env }

        const installed = await runRoast(
            ['skill', 'install', '--dir', parent.dir], opts)
        t.equal(installed.code, 0, 'install exits 0')
        t.ok(fs.existsSync(path.join(parent.dir, 'roast', 'SKILL.md')),
            'installed below --dir')

        const status = await runRoast(
            ['skill', 'status', '--dir', parent.dir], opts)
        t.equal(status.code, 0, 'status exits 0')
        t.deepEqual(statusLines(status.stdout), [
            ['custom', 'up_to_date', path.join(parent.dir, 'roast')],
        ], 'one custom up_to_date line')
    })

test('skill with no subcommand prints help and exits 0', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const res = await runRoast(['skill'], { cwd:dir.dir, env:dir.env })
    t.equal(res.code, 0, 'exits 0')
    t.ok(res.stdout.length > 0, 'help on stdout')
    t.equal(res.stderr, '', 'nothing on stderr')
})

// A temporary repository with HOME isolated and a nested working
// directory `pkg/nested`.
interface RepoSubdir {
    top:string;
    sub:string;
    home:string;
    env:Record<string, string>;
}

function repoSubdir (t:CleanupTest):RepoSubdir {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    const home = isolateSkillHome(t, repo)
    const sub = path.join(repo.dir, 'pkg', 'nested')
    fs.mkdirSync(sub, { recursive:true })
    return { top:repo.dir, sub, home, env:repo.env }
}

test('skill install from a subdirectory writes to the Git toplevel',
    async t => {
        const { top, sub, home, env } = repoSubdir(t)
        const res = await runRoast(['skill', 'install'], { cwd:sub, env })
        t.equal(res.code, 0, 'install exits 0')
        t.ok(fs.existsSync(
            path.join(top, '.agents', 'skills', 'roast', 'SKILL.md')),
        'installed under the toplevel .agents/skills')
        t.deepEqual(treeFiles(home), [], 'nothing written under HOME')
        t.deepEqual(treeFiles(path.join(top, 'pkg')), [],
            'nothing written under the working subdirectory')
    })

test('project skill status goes from not_installed to up_to_date',
    async t => {
        const { top, sub, env } = repoSubdir(t)
        const projectPath = path.join(top, '.agents', 'skills', 'roast')
        const before = await runRoast(['skill', 'status'], { cwd:sub, env })
        t.equal(before.code, 0, 'status exits 0')
        t.deepEqual(statusLines(before.stdout),
            [['agents', 'not_installed', projectPath]],
            'agents not_installed at the toplevel')

        const res = await runRoast(['skill', 'install'], { cwd:sub, env })
        t.equal(res.code, 0, 'install exits 0')

        const after = await runRoast(['skill', 'status'], { cwd:sub, env })
        t.equal(after.code, 0, 'status exits 0')
        t.deepEqual(statusLines(after.stdout),
            [['agents', 'up_to_date', projectPath]],
            'agents up_to_date at the toplevel')
    })

test('outside Git, skill commands need --global or --dir', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const home = isolateSkillHome(t, dir)
    for (const sub of ['install', 'status']) {
        const res = await runRoast(['skill', sub],
            { cwd:dir.dir, env:dir.env })
        t.equal(res.code, 2, `skill ${sub} exits 2`)
        t.ok(res.error instanceof UsageError, `skill ${sub} usage error`)
    }
    t.deepEqual(treeFiles(home), [], 'nothing written under HOME')
    t.deepEqual(treeFiles(dir.dir), [], 'nothing written in the cwd')
})

test('--global writes only user-level directories', async t => {
    const { top, sub, home, env } = repoSubdir(t)
    const res = await runRoast(['skill', 'install', '--global'],
        { cwd:sub, env })
    t.equal(res.code, 0, 'install --global exits 0')
    const globalPath = path.join(home, '.agents', 'skills', 'roast')
    t.ok(fs.existsSync(path.join(globalPath, 'SKILL.md')),
        'installed under HOME')
    t.ok(!fs.existsSync(path.join(top, '.agents')),
        'nothing written into the project')

    const global = await runRoast(['skill', 'status', '--global'],
        { cwd:sub, env })
    t.equal(global.code, 0, 'status --global exits 0')
    t.deepEqual(statusLines(global.stdout),
        [['agents', 'up_to_date', globalPath]], 'global is up_to_date')

    const project = await runRoast(['skill', 'status'], { cwd:sub, env })
    t.equal(project.code, 0, 'status exits 0')
    t.deepEqual(statusLines(project.stdout), [[
        'agents',
        'not_installed',
        path.join(top, '.agents', 'skills', 'roast'),
    ]], 'project stays not_installed')
})

test('--dir limits writes to one parent, with and without --global',
    async t => {
        for (const extra of [[], ['--global']]) {
            const { top, sub, home, env } = repoSubdir(t)
            const parent = tempDir('roast-skill-parent-')
            t.cleanup(parent.remove)
            const label = ['--dir', ...extra].join(' ')

            const res = await runRoast(
                ['skill', 'install', '--dir', parent.dir, ...extra],
                { cwd:sub, env })
            t.equal(res.code, 0, `${label}: install exits 0`)
            t.deepEqual(treeFiles(parent.dir),
                [path.join(parent.dir, 'roast', 'SKILL.md')],
                `${label}: only the skill below --dir`)
            t.deepEqual(treeFiles(home), [], `${label}: nothing under HOME`)
            t.ok(!fs.existsSync(path.join(top, '.agents')),
                `${label}: nothing in the project`)

            const status = await runRoast(
                ['skill', 'status', '--dir', parent.dir, ...extra],
                { cwd:sub, env })
            t.equal(status.code, 0, `${label}: status exits 0`)
            t.deepEqual(statusLines(status.stdout), [
                ['custom', 'up_to_date', path.join(parent.dir, 'roast')],
            ], `${label}: only the custom target`)
        }
    })
