import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { build } from '../../src/scope/index.js'
import { newRepo, sectionPaths } from './helpers.js'

test('linguist-marked paths are excluded; =false un-marks', async t => {
    const repo = newRepo()
    const names = ['gen_true.json', 'gen_bare.txt', 'vend.json',
        'gen_false.json', 'normal.go']
    for (const n of names) repo.write(n, 'v1\n')
    repo.write('.gitattributes',
        'gen_true.json linguist-generated=true\n' +
        'gen_bare.txt linguist-generated\n' +
        'vend.json linguist-vendored=true\n' +
        'gen_false.json linguist-generated=false\n')
    repo.commitAll()
    for (const n of names) repo.write(n, 'v2\n')
    const s = await build(repo.dir, { uncommittedOnly:true, env:repo.env })
    t.deepEqual([...s.files], ['gen_false.json', 'normal.go'],
        'marked files excluded')
    t.deepEqual(sectionPaths(s.diff), ['gen_false.json', 'normal.go'],
        'and absent from the diff')
    t.equal(s.notes.length, 1, 'exclusion note')

    const all = await build(repo.dir, {
        uncommittedOnly:true,
        includeVendored:true,
        env:repo.env,
    })
    t.equal(all.files.length, names.length, '--include-vendored reviews all')
    repo.cleanup()
})

test('no .gitattributes means no linguist excludes', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package a\n')
    repo.commitAll()
    repo.write('a.go', 'package a\n// edit\n')
    const s = await build(repo.dir, { uncommittedOnly:true, env:repo.env })
    t.deepEqual([...s.files], ['a.go'], 'reviewed')
    t.deepEqual([...s.notes], [], 'no exclusion note')
    repo.cleanup()
})

test('a generated file is excluded from a committed range', async t => {
    const repo = newRepo()
    repo.write('code.go', 'package x\n')
    repo.write('schema.json', '{}\n')
    repo.write('.gitattributes', 'schema.json linguist-generated=true\n')
    repo.commitAll()
    repo.write('code.go', 'package x\n\nfunc F() {}\n')
    repo.write('schema.json', '{"changed": true}\n')
    repo.commitAll('change both')
    const s = await build(repo.dir, { base:'HEAD~1', env:repo.env })
    t.deepEqual([...s.files], ['code.go'], 'schema.json excluded')
    t.ok(!s.diff.includes('schema.json'), 'not in the diff')
    repo.cleanup()
})

test('a name with glob metacharacters excludes only itself', async t => {
    const repo = newRepo()
    repo.write('a.go', 'package a\n')
    repo.write('b.go', 'package b\n')
    repo.write('[ab].go', 'package weird\n')
    repo.write('.gitattributes', '[[]ab[]].go linguist-generated=true\n')
    repo.commitAll()
    repo.write('a.go', 'package a\n\nfunc A() {}\n')
    repo.write('b.go', 'package b\n\nfunc B() {}\n')
    repo.write('[ab].go', 'package weird\n\nfunc W() {}\n')
    repo.commitAll('change all')
    const s = await build(repo.dir, { base:'HEAD~1', env:repo.env })
    t.deepEqual([...s.files], ['a.go', 'b.go'], 'only [ab].go excluded')
    repo.cleanup()
})

test('staged mode reads attributes from the index', async t => {
    const repo = newRepo()
    repo.write('schema.json', '{}\n')
    repo.commitAll()
    repo.write('schema.json', '{"v": 1}\n')
    repo.git('add', 'schema.json')
    repo.write('.gitattributes', 'schema.json linguist-generated=true\n')
    const unstaged = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.deepEqual([...unstaged.files], ['schema.json'],
        'an unstaged marker does not apply')
    repo.git('add', '.gitattributes')
    const staged = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.deepEqual([...staged.files], ['.gitattributes'],
        'a staged marker applies')
    repo.cleanup()
})

test('linguist exclusions honor the pinned tree', async t => {
    const repo = newRepo()
    repo.write('schema.json', '{}\n')
    repo.commitAll()
    repo.write('schema.json', '{"v": 1}\n')
    repo.git('add', 'schema.json')
    const pinned = repo.git('write-tree').trim()
    repo.write('.gitattributes', 'schema.json linguist-generated=true\n')
    repo.git('add', '.gitattributes')
    const s = await build(repo.dir, {
        stagedOnly:true,
        stagedTreeOID:pinned,
        env:repo.env,
    })
    t.deepEqual([...s.files], ['schema.json'],
        'a marker staged after the pin does not apply')
    t.ok(!s.diff.includes('linguist-generated'), 'post-pin file absent')
    const unpinned = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.ok(!unpinned.files.includes('schema.json'),
        'without a pin the live index applies')
    repo.cleanup()
})

test('a staged deletion of a generated file is excluded', async t => {
    const repo = newRepo()
    repo.write('keep.go', 'package x\n')
    repo.write('schema.json', '{"big": true}\n')
    repo.write('.gitattributes', 'schema.json linguist-generated=true\n')
    repo.commitAll()
    repo.git('rm', '-q', 'schema.json')
    repo.write('keep.go', 'package x\n\nfunc F() {}\n')
    repo.git('add', 'keep.go')
    const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
    t.deepEqual([...s.files], ['keep.go'], 'deletion excluded')
    repo.cleanup()
})

test('a staged rename of a marked file excludes the old path too',
    async t => {
        const repo = newRepo()
        repo.write('keep.go', 'package x\n')
        repo.write('gen/schema.json', '{"big": true}\n'.repeat(20))
        repo.write('.gitattributes', 'gen/** linguist-generated=true\n')
        repo.commitAll()
        repo.git('mv', 'gen/schema.json', 'gen/schema2.json')
        repo.write('keep.go', 'package x\n\nfunc F() {}\n')
        repo.git('add', 'keep.go')
        const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
        t.deepEqual([...s.files], ['keep.go'], 'both sides excluded')
        t.ok(!s.diff.includes('schema'), 'neither side in the diff')
        repo.cleanup()
    })

test('a global core.attributesFile cannot blank a review', async t => {
    const repo = newRepo()
    repo.write('code.go', 'package x\n')
    repo.commitAll()
    repo.write('code.go', 'package x\n// edit\n')
    const attrs = path.join(path.dirname(repo.globalConfig), 'attributes')
    fs.writeFileSync(attrs, '* linguist-generated\n')
    fs.writeFileSync(repo.globalConfig,
        `[core]\n\tattributesFile = ${attrs}\n`)
    const s = await build(repo.dir, { uncommittedOnly:true, env:repo.env })
    t.deepEqual([...s.files], ['code.go'], 'still reviewed')
    t.deepEqual([...s.notes], [], 'no exclusion note')
    repo.write('new.go', 'package n\n')
    const withNew = await build(repo.dir, {
        uncommittedOnly:true,
        env:repo.env,
    })
    t.deepEqual([...withNew.files], ['code.go', 'new.go'],
        'untracked files not blanked either')
    repo.cleanup()
})

test('untracked linguist-marked files are excluded', async t => {
    const repo = newRepo()
    repo.write('keep.go', 'package x\n')
    repo.write('.gitattributes', '*.gen.json linguist-generated=true\n')
    repo.commitAll()
    repo.write('new.go', 'package y\n')
    repo.write('big.gen.json', '{"a": 1}\n')
    const s = await build(repo.dir, { uncommittedOnly:true, env:repo.env })
    t.deepEqual([...s.files], ['new.go'], 'marked untracked file excluded')
    repo.cleanup()
})
