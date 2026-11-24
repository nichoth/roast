import { recordRepo } from './repo.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { tempDir } from '../helpers/repo.js'
import { recordDir, makeRunDir, isValidName } from '../../src/record/dir.js'

test('records resolve at the Git root and ignore overrides', async t => {
    const repo = recordRepo(t)
    const outside = tempDir()
    t.cleanup(outside.remove)
    const sub = path.join(repo.dir, 'sub')
    await fs.mkdir(sub)
    t.equal(await recordDir(sub, {
        env:{ ...repo.env, ROAST_RECORD_DIR:outside.dir },
    }), path.join(repo.dir, '.roast/runs'))
    t.equal(await recordDir(outside.dir, { env:outside.env }), '')
    t.equal(await recordDir(repo.dir, { env:{ PATH:'' } }), '')
})

test('plain names cannot traverse the record root', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
        t.ok(!isValidName(name))
        t.ok(await makeRunDir(dir, name).then(() => false, () => true))
    }
    t.ok(isValidName('20260919T120000Z-1234abcd'))
    t.ok(isValidName('plain-name.json'))
    t.ok(await fs.lstat(path.dirname(dir)).then(() => false, () => true))
})

test('first run ignores state and existing state stays alone', async t => {
    const repo = recordRepo(t)
    const dir = await recordDir(repo.dir, { env:repo.env })
    await makeRunDir(dir, 'first')
    const ignore = path.join(repo.dir, '.roast/.gitignore')
    t.equal(await fs.readFile(ignore, 'utf8'), '*\n')
    await fs.writeFile(ignore, 'custom\n')
    await makeRunDir(dir, 'second')
    t.equal(await fs.readFile(ignore, 'utf8'), 'custom\n')
    await fs.unlink(ignore)
    await makeRunDir(dir, 'third')
    t.ok(!(await fs.readdir(path.dirname(ignore))).includes('.gitignore'))
})
