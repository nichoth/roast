import * as fs from 'node:fs'
import { join } from 'node:path'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import {
    buildBundle, BUNDLE_FILE, BundleBuildInProgressError,
} from '../../src/runbundle/bundle.js'

test('fresh lock blocks a builder and stale lock is reclaimed', t => {
    const repo = recordRepo(t)
    const dir = join(repo.dir, 'run')
    fs.mkdirSync(dir)
    fs.writeFileSync(join(dir, 'meta.json'), 'metadata\n')
    const lock = join(dir, BUNDLE_FILE + '.tmp')
    fs.writeFileSync(lock, 'other builder', { mode:0o600 })
    let error:unknown
    try { buildBundle(dir) } catch (err) { error = err }
    t.ok(error instanceof BundleBuildInProgressError, 'typed contention error')
    t.equal(fs.readFileSync(lock, 'utf8'), 'other builder', 'lock untouched')
    t.ok(!fs.existsSync(join(dir, BUNDLE_FILE)), 'no bundle on contention')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(lock, old, old)
    t.equal(buildBundle(dir).path, join(dir, BUNDLE_FILE), 'stale reclaimed')
    t.ok(!fs.existsSync(lock), 'lock renamed away')
})
