// `roast gate enable|disable|status` (spec 12, 2.4 to 2.10), driven
// through the in-process CLI in isolated temp repositories.
import fs from 'node:fs'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { ROOT } from '../helpers/spawn.js'
import {
    gateRepo,
    git,
    localConfig,
    modeOf,
    read,
    scratch,
    writeHook,
    type GateRepo,
} from '../gate/helpers.js'

// The shipped script, read from disk as the independent source of truth.
const SCRIPT = fs.readFileSync(
    path.join(ROOT, 'src', 'gate', 'pre-commit.sh'), 'utf8')

const BEGIN = '# >>> roast pre-commit gate (managed by `roast gate`) >>>'
const END = '# <<< roast pre-commit gate <<<'
const INVOKE =
    '"$(git rev-parse --git-path hooks/roast-pre-commit)" || exit $?'

function gate (r:GateRepo, ...args:string[]) {
    return runRoast(['gate', ...args], { cwd:r.dir, env:r.env })
}

test('gate enable installs an executable hook and records consent',
    async t => {
        const r = gateRepo(t)
        const res = await gate(r, 'enable')
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        t.equal(read(r.hook), SCRIPT, 'the hook is the shipped script')
        t.equal(modeOf(r.hook), 0o755, 'mode 0755')
        t.equal(localConfig(r, 'roast.gate'), 'enabled', 'records enabled')
    })

test('gate enable without a toplevel config is a usage error', async t => {
    const r = gateRepo(t, false)
    const sub = path.join(r.dir, 'sub')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, '.roast.jsonc'), '{"version": 1}')
    for (const cwd of [r.dir, sub]) {
        const res = await runRoast(['gate', 'enable'], { cwd, env:r.env })
        t.equal(res.code, 2, 'exits 2')
        t.ok(!fs.existsSync(r.hook), 'writes no hook')
        t.equal(localConfig(r, 'roast.gate'), '', 'records nothing')
    }
})

test('gate enable refreshes a stale own hook and a lost execute bit',
    async t => {
        const r = gateRepo(t)
        writeHook(r.hook, '#!/bin/sh\n# roast-gate-hook: v1\n# old\n')
        let res = await gate(r, 'enable')
        t.equal(res.code, 0, 'exits 0')
        t.equal(read(r.hook), SCRIPT, 'stale content rewritten')

        fs.chmodSync(r.hook, 0o644)
        res = await gate(r, 'enable')
        t.equal(res.code, 0, 'exits 0')
        t.equal(modeOf(r.hook), 0o755, 'execute bit repaired')
        t.equal(read(r.hook), SCRIPT, 'content unchanged')
    })

test('gate enable appends to a foreign shell hook with a sidecar',
    async t => {
        const r = gateRepo(t)
        writeHook(r.hook, '#!/bin/sh\nmake lint\n', 0o755)
        const res = await gate(r, 'enable')
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        const body = read(r.hook)
        const lines = body.split('\n')
        t.equal(lines[0], '#!/bin/sh', 'shebang first')
        t.equal(lines[2], BEGIN, 'block right after the shebang')
        t.ok(lines.includes(INVOKE), 'block runs the sidecar')
        t.ok(body.endsWith(`${END}\nmake lint\n`), 'their lines follow')
        t.equal(read(r.sidecar), SCRIPT, 'sidecar is the script')
        t.equal(modeOf(r.sidecar), 0o755, 'sidecar executable')
        t.equal(localConfig(r, 'roast.gate'), 'enabled', 'consent')

        // A stale sidecar is refreshed on the next enable.
        writeHook(r.sidecar, '#!/bin/sh\n# roast-gate-hook: v1\n# old\n')
        const again = await gate(r, 'enable')
        t.equal(again.code, 0, 'exits 0')
        t.equal(read(r.sidecar), SCRIPT, 'stale sidecar refreshed')
        t.equal(read(r.hook), body, 'hook not appended twice')
    })

test('appending preserves the foreign hook mode', async t => {
    for (const mode of [0o755, 0o750, 0o644]) {
        const r = gateRepo(t)
        writeHook(r.hook, '#!/bin/bash\necho hi\n', mode)
        const res = await gate(r, 'enable')
        t.equal(res.code, 0, 'exits 0')
        t.ok(read(r.hook).includes(INVOKE), 'block appended')
        t.equal(modeOf(r.hook), mode, `mode ${mode.toString(8)} kept`)
    }
})

test('a one-line hook without a newline gets one before the block',
    async t => {
        const r = gateRepo(t)
        writeHook(r.hook, '#!/bin/sh')
        const res = await gate(r, 'enable')
        t.equal(res.code, 0, `exits 0 ${res.stderr}`)
        const lines = read(r.hook).split('\n')
        t.equal(lines[0], '#!/bin/sh', 'the shebang line stands alone')
        t.equal(lines[1], '', 'blank separator')
        t.equal(lines[2], BEGIN, 'then the block')
        t.equal(read(r.sidecar), SCRIPT, 'sidecar written')
    })

test('non-shell and symlinked hooks are left untouched', async t => {
    const r = gateRepo(t)
    const python = '#!/usr/bin/env python3\nprint("hi")\n'
    writeHook(r.hook, python)
    let res = await gate(r, 'enable')
    t.equal(res.code, 0, 'manual enable exits 0')
    t.equal(read(r.hook), python, 'non-shell hook byte-identical')
    t.equal(localConfig(r, 'roast.gate'), 'enabled', 'consent recorded')
    t.equal(read(r.sidecar), SCRIPT, 'sidecar for the manual line')

    const s = gateRepo(t)
    const target = path.join(scratch(t), 'husky-hook')
    const shell = '#!/bin/sh\nnpx lint-staged\n'
    writeHook(target, shell)
    fs.mkdirSync(path.dirname(s.hook), { recursive:true })
    fs.symlinkSync(target, s.hook)
    res = await gate(s, 'enable')
    t.equal(res.code, 0, 'symlinked enable exits 0')
    t.ok(fs.lstatSync(s.hook).isSymbolicLink(), 'still a symlink')
    t.equal(fs.readlinkSync(s.hook), target, 'same link target')
    t.equal(read(target), shell, 'target untouched')
    t.equal(localConfig(s, 'roast.gate'), 'enabled', 'consent recorded')
})

test('gate disable removes only what Roast wrote', async t => {
    // Own hook: deleted.
    const own = gateRepo(t)
    await gate(own, 'enable')
    let res = await gate(own, 'disable')
    t.equal(res.code, 0, 'exits 0')
    t.ok(!fs.existsSync(own.hook), 'own hook deleted')
    t.equal(localConfig(own, 'roast.gate'), 'declined', 'records declined')

    // Appended: only the block goes, and the sidecar with it.
    const app = gateRepo(t)
    const foreign = '#!/bin/sh\r\n# theirs\nmake lint\nexit 0'
    writeHook(app.hook, foreign, 0o750)
    await gate(app, 'enable')
    t.ok(read(app.hook).includes(INVOKE), 'block appended first')
    res = await gate(app, 'disable')
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(app.hook), foreign, 'remainder byte-identical')
    t.equal(modeOf(app.hook), 0o750, 'mode kept')
    t.ok(!fs.existsSync(app.sidecar), 'owned sidecar removed')

    // Untouched foreign hook: left alone.
    const other = gateRepo(t)
    writeHook(other.hook, '#!/bin/sh\nmake lint\n')
    res = await gate(other, 'disable')
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(other.hook), '#!/bin/sh\nmake lint\n', 'foreign kept')
    t.equal(localConfig(other, 'roast.gate'), 'declined', 'declined')
})

test('ownership is anchored', async t => {
    const cases:[string, string][] = [
        ['marker text mid-file',
            '#!/bin/sh\necho "#!/bin/sh"\n# roast-gate-hook: v1\nmake\n'],
        ['begin without end',
            `#!/bin/sh\n${BEGIN}\n${INVOKE}\nmake lint\n`],
        ['marker pair without invocation',
            `#!/bin/sh\n${BEGIN}\n# gone\n${END}\nmake lint\n`],
    ]
    for (const [name, body] of cases) {
        const r = gateRepo(t)
        writeHook(r.hook, body)
        const res = await gate(r, 'disable')
        t.equal(res.code, 0, `${name}: disable exits 0`)
        t.equal(read(r.hook), body, `${name}: never stripped or deleted`)
    }
})

test('a foreign file at the sidecar path is never clobbered', async t => {
    const r = gateRepo(t)
    const theirs = '#!/bin/sh\n# their own roast-pre-commit\n'
    writeHook(r.sidecar, theirs)
    writeHook(r.hook, '#!/bin/sh\nmake lint\n')
    const res = await gate(r, 'enable')
    t.equal(res.code, 4, 'enable fails rather than overwrite')
    t.equal(read(r.sidecar), theirs, 'sidecar untouched by enable')
    t.equal(read(r.hook), '#!/bin/sh\nmake lint\n', 'hook untouched')

    const off = await gate(r, 'disable')
    t.equal(off.code, 0, 'disable exits 0')
    t.equal(read(r.sidecar), theirs, 'sidecar untouched by disable')
})

test('hook writes do not follow planted temp symlinks', async t => {
    const r = gateRepo(t)
    git(r.dir, r.env, 'config', 'core.hooksPath', '.githooks')
    const hooks = path.join(r.dir, '.githooks')
    fs.mkdirSync(hooks)
    const victim = path.join(scratch(t), 'precious')
    fs.writeFileSync(victim, 'do not touch\n')
    fs.symlinkSync(victim, path.join(hooks, 'pre-commit.roast-tmp'))
    for (let i = 0; i < 16; i++) {
        fs.symlinkSync(victim,
            path.join(hooks, `.pre-commit.roast-${i.toString(16)}`))
    }
    const res = await gate(r, 'enable')
    t.equal(res.code, 0, `exits 0 ${res.stderr}`)
    t.equal(read(victim), 'do not touch\n', 'victim untouched')
    t.equal(read(path.join(hooks, 'pre-commit')), SCRIPT, 'hook written')
})

test('core.hooksPath is honoured', async t => {
    const r = gateRepo(t)
    git(r.dir, r.env, 'config', 'core.hooksPath', 'custom-hooks')
    const res = await gate(r, 'enable')
    t.equal(res.code, 0, 'exits 0')
    t.equal(read(path.join(r.dir, 'custom-hooks', 'pre-commit')), SCRIPT,
        'hook written under core.hooksPath')
    t.ok(!fs.existsSync(r.hook), 'not in .git/hooks')
})

test('gate status prints three lines and never mutates', async t => {
    const r = gateRepo(t)
    for (const step of [[], ['enable'], ['disable']]) {
        if (step.length) await gate(r, ...step)
        const before = localConfig(r, 'roast.gate')
        const hook = fs.existsSync(r.hook) ? read(r.hook) : ''
        const res = await gate(r, 'status')
        t.equal(res.code, 0, 'exits 0')
        t.equal(res.stdout.trimEnd().split('\n').length, 3, 'three lines')
        t.equal(localConfig(r, 'roast.gate'), before, 'no decision change')
        t.equal(fs.existsSync(r.hook) ? read(r.hook) : '', hook,
            'hook unchanged')
    }
})

test('gate subcommand arguments', async t => {
    const r = gateRepo(t)
    for (const sub of ['enable', 'disable', 'status']) {
        const res = await gate(r, sub, 'extra')
        t.equal(res.code, 2, `${sub} with an extra argument exits 2`)
    }
    t.ok(!fs.existsSync(r.hook), 'nothing installed')
    const bare = await gate(r)
    t.equal(bare.code, 0, 'bare gate exits 0')
    const outside = scratch(t)
    for (const sub of ['enable', 'disable', 'status']) {
        const res = await runRoast(['gate', sub],
            { cwd:outside, env:r.env })
        t.equal(res.code, 2, `${sub} outside a repository exits 2`)
    }
})
