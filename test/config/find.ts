// findConfig at the module seam (spec 02, 2.2).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { findConfig } from '../../src/config/load.js'

function mkTemp (t:{ cleanup (fn:() => void):void }):string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-find-'))
    t.cleanup(() => fs.rmSync(dir, { recursive:true, force:true }))
    return dir
}

function writeConfig (dir:string):string {
    fs.mkdirSync(dir, { recursive:true })
    const file = path.join(dir, '.roast.json')
    fs.writeFileSync(file, '{"version": 1}\n')
    return file
}

test('findConfig walks up no further than the stop directory', t => {
    const root = fs.realpathSync(mkTemp(t))
    const top = path.join(root, 'top')
    const sub = path.join(top, 'a', 'b')
    fs.mkdirSync(sub, { recursive:true })

    // Above the stop directory: never found.
    writeConfig(root)
    t.equal(findConfig(sub, top), '', 'a config above stop is ignored')

    // At the stop directory: found.
    const atTop = writeConfig(top)
    t.equal(findConfig(sub, top), atTop, 'a config at stop is found')

    // The nearest wins.
    const nearer = writeConfig(path.join(top, 'a'))
    t.equal(findConfig(sub, top), nearer, 'the nearest config wins')
})

test('findConfig skips a directory named .roast.json', t => {
    const root = fs.realpathSync(mkTemp(t))
    const sub = path.join(root, 'sub')
    fs.mkdirSync(path.join(sub, '.roast.json'), { recursive:true })
    const file = writeConfig(root)
    t.equal(findConfig(sub, root), file,
        'the directory is skipped and the parent config is found')
})

test('findConfig stops at a realpath toplevel through a symlink', t => {
    const root = fs.realpathSync(mkTemp(t))
    const real = path.join(root, 'real')
    const sub = path.join(real, 'sub')
    fs.mkdirSync(sub, { recursive:true })
    // A config above the toplevel must not be found.
    writeConfig(root)
    const link = path.join(root, 'link')
    fs.symlinkSync(real, link)

    // Start through the symlink; stop is the canonical toplevel, as
    // `git rev-parse --show-toplevel` prints it.
    t.equal(findConfig(path.join(link, 'sub'), real), '',
        'the walk ends at the toplevel')

    const atTop = writeConfig(real)
    t.equal(findConfig(path.join(link, 'sub'), real),
        path.join(link, '.roast.json'),
        'the toplevel config is found, spelled through the symlink')
    t.ok(fs.existsSync(atTop))
})

test('findConfig fails when the stop directory does not exist', t => {
    const root = fs.realpathSync(mkTemp(t))
    t.throws(() => findConfig(root, path.join(root, 'missing')),
        /find project config/, 'a missing stop is an error')
})
