import * as fs from 'node:fs'
import { join } from 'node:path'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { buildBundle, verifyBundle } from '../../src/runbundle/bundle.js'

test('existing bundle keeps its bytes and identity after artifacts change',
    t => {
        const repo = recordRepo(t)
        fs.writeFileSync(join(repo.dir, 'a'), 'original')
        const first = buildBundle(repo.dir)
        const bytes = fs.readFileSync(first.path)
        const stat = fs.statSync(first.path)
        fs.writeFileSync(join(repo.dir, 'a'), 'changed')
        fs.writeFileSync(join(repo.dir, 'bundle-manifest.json'), 'reserved')
        fs.chmodSync(first.path, 0o644)
        const second = buildBundle(repo.dir)
        t.deepEqual(second, first, 'result is reused')
        t.deepEqual(fs.readFileSync(first.path), bytes, 'bytes unchanged')
        t.equal(fs.statSync(first.path).ino, stat.ino, 'inode unchanged')
        t.equal(fs.statSync(first.path).mtimeMs, stat.mtimeMs,
            'mtime unchanged')
        t.equal(fs.statSync(first.path).mode & 0o777, 0o600, 'mode tightened')
        t.equal(verifyBundle(first.path).files?.[0].size, 8,
            'manifest still binds original content')
    })
