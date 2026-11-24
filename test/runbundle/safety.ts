import * as fs from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from '../helpers/test.js'
import { recordRepo } from '../record/repo.js'
import { buildBundle, BUNDLE_FILE } from '../../src/runbundle/bundle.js'

test('build refuses symlinks, special artifacts and invalid cached bundles',
    t => {
        const repo = recordRepo(t)
        const dir = join(repo.dir, 'run')
        fs.mkdirSync(dir)
        const target = join(repo.dir, 'target')
        fs.writeFileSync(target, 'private')
        const bundle = join(dir, BUNDLE_FILE)
        fs.symlinkSync(target, bundle)
        t.throws(() => buildBundle(dir), /regular file/,
            'bundle symlink refused')
        t.equal(fs.readFileSync(target, 'utf8'), 'private', 'target preserved')
        fs.unlinkSync(bundle)
        fs.symlinkSync(target, join(dir, 'artifact'))
        t.throws(() => buildBundle(dir), /symlink/, 'artifact symlink refused')
        t.ok(!fs.existsSync(bundle + '.tmp'), 'failed build releases lock')
        fs.unlinkSync(join(dir, 'artifact'))
        execFileSync('mkfifo', [join(dir, 'pipe')])
        t.throws(() => buildBundle(dir), /regular file/, 'FIFO refused')
        fs.unlinkSync(join(dir, 'pipe'))
        fs.writeFileSync(join(dir, 'bundle-manifest.json'), '{}')
        t.throws(() => buildBundle(dir), /reserved/, 'stray manifest refused')
        fs.unlinkSync(join(dir, 'bundle-manifest.json'))
        fs.writeFileSync(bundle, 'invalid compressed bytes')
        t.throws(() => buildBundle(dir), /zstd/,
            'invalid existing bundle refused')
        t.equal(fs.readFileSync(bundle, 'utf8'), 'invalid compressed bytes',
            'invalid existing bundle preserved for diagnosis')
    })
