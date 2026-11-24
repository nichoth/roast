import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { build, type BuildOpts } from '../../src/scope/index.js'
import { newRepo, sectionPaths, tempDir, type TestRepo } from './helpers.js'

// Global config defining a textconv driver and an external diff (each
// leaves a marker file when run), forced color, and changed prefixes.
function hostileGlobalConfig (repo:TestRepo):string[] {
    const dir = tempDir('roast-hostile-')
    const textconvRan = path.join(dir, 'textconv-ran')
    const externalRan = path.join(dir, 'external-ran')
    const textconv = path.join(dir, 'textconv.sh')
    const external = path.join(dir, 'external.sh')
    fs.writeFileSync(textconv, `#!/bin/sh\ntouch '${textconvRan}'\n` +
        'echo CONVERTED-BY-DRIVER\n', { mode:0o755 })
    fs.writeFileSync(external, `#!/bin/sh\ntouch '${externalRan}'\n` +
        'echo EXTERNAL-DIFF\n', { mode:0o755 })
    fs.writeFileSync(repo.globalConfig,
        `[diff "pdf"]\n\ttextconv = ${textconv}\n` +
        `[diff]\n\texternal = ${external}\n\tnoprefix = true\n` +
        '\tmnemonicPrefix = true\n' +
        '[color]\n\tui = always\n\tdiff = always\n')
    return [textconvRan, externalRan]
}

test('user diff drivers never run and cannot rewrite the diff',
    async t => {
        const repo = newRepo()
        repo.write('a.go', 'package a\n\nfunc A() {}\n')
        repo.write('moved.go', 'package a\n\n' + '// keep\n'.repeat(20))
        repo.commitAll()
        repo.git('branch', 'base')
        repo.write('.gitattributes', '*.go diff=pdf\n')
        repo.write('a.go', 'package a\n\nfunc A() { committed() }\n')
        repo.git('mv', 'moved.go', 'renamed.go')
        repo.commitAll('attacker change')
        repo.write('a.go', 'package a\n\nfunc A() { uncommitted() }\n')
        repo.write('new.go', 'package a\n')
        const markers = hostileGlobalConfig(repo)

        const cases:BuildOpts[] = [{ base:'base' }, { uncommittedOnly:true }]
        for (const opts of cases) {
            const label = JSON.stringify(opts)
            const s = await build(repo.dir, { ...opts, env:repo.env })
            for (const m of markers) {
                t.ok(!fs.existsSync(m), `${label}: ${path.basename(m)}`)
            }
            t.ok(!s.diff.includes('\u001b'), `${label}: no color`)
            t.ok(!s.diff.includes('CONVERTED-BY-DRIVER') &&
                !s.diff.includes('EXTERNAL-DIFF'), `${label}: not rewritten`)
            t.ok(s.diff.includes('diff --git a/a.go b/a.go') &&
                s.diff.includes('+++ b/a.go'), `${label}: a/ b/ prefixes`)
            t.ok(s.diff.includes('+func A() { uncommitted() }'),
                `${label}: plain diff`)
        }
        const s = await build(repo.dir, { base:'base', env:repo.env })
        t.ok(s.diff.includes('rename from moved.go'),
            'rename pass still collapses the move')
        repo.cleanup()
    })

test('a global diff.orderFile does not change section order', async t => {
    const repo = newRepo()
    const names = ['a.go', 'b.go', 'c.go']
    for (const n of names) repo.write(n, 'v1\n')
    repo.commitAll()
    repo.git('branch', 'base')
    for (const n of names) repo.write(n, 'v2\n')
    repo.commitAll('committed edits')
    for (const n of names) repo.write(n, 'v3\n')
    repo.git('add', '.')

    const order = path.join(path.dirname(repo.globalConfig), 'order')
    fs.writeFileSync(order, 'c.go\nb.go\na.go\n')
    fs.writeFileSync(repo.globalConfig, `[diff]\n\torderFile = ${order}\n`)
    // The order file is in effect for plain git.
    const plain = repo.git('diff', '--cached', '--name-only')
    t.deepEqual(plain.trim().split('\n'), ['c.go', 'b.go', 'a.go'],
        'git itself reverses the order')

    const staged = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.deepEqual(sectionPaths(staged.diff), names, 'staged order')
    const committed = await build(repo.dir, {
        base:'base',
        env:repo.env,
    })
    const [head, tail] = committed.diff.split('### Uncommitted changes ###')
    t.deepEqual(sectionPaths(head), names, 'committed order')
    t.deepEqual(sectionPaths(tail), names, 'uncommitted order')
    repo.cleanup()
})

test('untracked denylisted files are skipped and noted', async t => {
    const repo = newRepo()
    const secrets:Record<string, string> = {
        '.env.local':'STRIPE_KEY=sk_live_FAKE\n',
        id_ed25519:'-----BEGIN OPENSSH PRIVATE KEY-----FAKE\n',
        '.npmrc':'//registry.npmjs.org/:_authToken=npm_FAKE\n',
        'credentials.json':'{"key":"FAKE"}\n',
        'conf/.netrc':'machine example.com password FAKE\n',
    }
    for (const [name, body] of Object.entries(secrets)) {
        repo.write(name, body)
    }
    repo.write('new.go', 'package a\n\nfunc New() {}\n')
    for (const includeVendored of [false, true]) {
        const s = await build(repo.dir, {
            uncommittedOnly:true,
            includeVendored,
            env:repo.env,
        })
        t.ok(!s.diff.includes('FAKE'), 'no secret content')
        t.deepEqual([...s.files], ['new.go'], 'only the ordinary file')
        t.ok(s.diff.includes('+func New() {}'), 'ordinary file kept')
        const note = s.notes.find(n => n.includes('.npmrc'))
        t.ok(note !== undefined, 'a note names the skipped files')
        for (const name of Object.keys(secrets)) {
            t.ok(note?.includes(name), `note names ${name}`)
        }
    }
    repo.cleanup()
})

test('untracked symlinks are not synthesized', async t => {
    const repo = newRepo()
    const outside = tempDir('roast-outside-')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n')
    fs.symlinkSync(path.join(outside, 'secret.txt'),
        path.join(repo.dir, 'leak'))
    repo.write('real.txt', 'real\n')
    const s = await build(repo.dir, { env:repo.env })
    t.ok(!s.diff.includes('OUTSIDE-SECRET'), 'target not read')
    t.deepEqual([...s.files], ['real.txt'], 'symlink not in files')
    repo.cleanup()
    fs.rmSync(outside, { recursive:true, force:true })
})
