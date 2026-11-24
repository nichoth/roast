import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from '../../src/fsutil/atomic.js'

function tempDir ():string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'roast-atomic-'))
}

function mode (p:string):number {
    return fs.statSync(p).mode & 0o777
}

test('writeFileAtomic leaves only the target, mode 0o600 by default', async t => {
    const dir = tempDir()
    const target = path.join(dir, 'trust.json')
    await writeFileAtomic(target, '{"version":2}\n', {
        tempPrefix:'trust-',
        tempSuffix:'.json',
        dirMode:0o755,
        errorPrefix:'write trust record',
    })
    t.equal(fs.readFileSync(target, 'utf8'), '{"version":2}\n', 'content')
    t.equal(mode(target), 0o600, 'mode 0o600')
    t.deepEqual(fs.readdirSync(dir), ['trust.json'], 'no temp file left')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('writeFileAtomic replaces a file and applies the requested mode', async t => {
    const dir = tempDir()
    const target = path.join(dir, 'pre-commit')
    fs.writeFileSync(target, 'old', { mode:0o644 })
    await writeFileAtomic(target, Buffer.from('#!/bin/sh\n'), { mode:0o755 })
    t.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\n', 'replaced')
    t.equal(mode(target), 0o755, 'mode 0o755')
    t.deepEqual(fs.readdirSync(dir), ['pre-commit'], 'no temp file left')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('writeFileAtomic creates missing parent directories', async t => {
    const dir = tempDir()
    const target = path.join(dir, 'a', 'b', 'trust.json')
    await writeFileAtomic(target, 'x', { dirMode:0o755 })
    t.equal(fs.readFileSync(target, 'utf8'), 'x', 'written')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('a failed rename leaves the original and no temp file', async t => {
    const dir = tempDir()
    // A non-empty directory at the target makes the rename fail.
    const target = path.join(dir, 'credentials.json')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep'), 'original')
    let err:unknown
    try {
        await writeFileAtomic(target, 'new', {
            tempPrefix:'credentials-',
            tempSuffix:'.json',
            errorPrefix:'write credentials',
        })
    } catch (e) {
        err = e
    }
    t.ok(err instanceof Error, 'rejects')
    t.ok((err as Error).message.startsWith('write credentials: '),
        'uses the error prefix')
    t.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'original',
        'original untouched')
    t.deepEqual(fs.readdirSync(dir), ['credentials.json'],
        'no temp file left')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('a failed temp create leaves the original untouched', async t => {
    const dir = tempDir()
    const target = path.join(dir, 'trust.json')
    fs.writeFileSync(target, 'original', { mode:0o600 })
    fs.chmodSync(dir, 0o500)
    let err:unknown
    try {
        await writeFileAtomic(target, 'new', { errorPrefix:'write trust record' })
    } catch (e) {
        err = e
    } finally {
        fs.chmodSync(dir, 0o700)
    }
    t.ok(err instanceof Error, 'rejects')
    t.equal(fs.readFileSync(target, 'utf8'), 'original', 'original untouched')
    t.deepEqual(fs.readdirSync(dir), ['trust.json'], 'no temp file left')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('credentials mode tightens an existing 0o755 parent to 0o700', async t => {
    const dir = tempDir()
    const parent = path.join(dir, 'roast')
    fs.mkdirSync(parent, { mode:0o755 })
    fs.chmodSync(parent, 0o755)
    fs.writeFileSync(path.join(parent, 'trust.json'), '{}')
    await writeFileAtomic(path.join(parent, 'credentials.json'), '{}\n', {
        tempPrefix:'credentials-',
        tempSuffix:'.json',
        dirMode:0o700,
        chmodDir:true,
        errorPrefix:'write credentials',
    })
    t.equal(mode(parent), 0o700, 'parent tightened')
    t.equal(mode(path.join(parent, 'credentials.json')), 0o600, 'file 0o600')
    t.deepEqual(fs.readdirSync(parent).sort(),
        ['credentials.json', 'trust.json'], 'only the expected files')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('without chmodDir an existing parent keeps its mode', async t => {
    const dir = tempDir()
    const parent = path.join(dir, 'roast')
    fs.mkdirSync(parent)
    fs.chmodSync(parent, 0o755)
    await writeFileAtomic(path.join(parent, 'trust.json'), '{}', {
        dirMode:0o755,
    })
    t.equal(mode(parent), 0o755, 'parent unchanged')
    fs.rmSync(dir, { recursive:true, force:true })
})

test('gate-style errors name the step when no prefix is given', async t => {
    const dir = tempDir()
    const target = path.join(dir, 'hook')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep'), 'x')
    let err:unknown
    try {
        await writeFileAtomic(target, 'new', { mode:0o755 })
    } catch (e) {
        err = e
    }
    t.ok((err as Error)?.message.startsWith(`replace ${target}: `),
        'rename failure names the target')
    t.deepEqual(fs.readdirSync(dir), ['hook'], 'no temp file left')
    fs.rmSync(dir, { recursive:true, force:true })
})
