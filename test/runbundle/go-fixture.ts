import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from '../helpers/test.js'
import { verifyBundle } from '../../src/runbundle/bundle.js'
import { createHash } from 'node:crypto'

const fixture = resolve('test/runbundle/fixtures/go-bundle.tar.zst')

test('Go baseline bundle verifies against the captured artifact bytes', t => {
    const manifest = verifyBundle(fixture)
    t.deepEqual(manifest, {
        format:'roast-run-bundle',
        version:1,
        files:[{
            path:'meta.json',
            sha256:createHash('sha256').update('metadata\n').digest('hex'),
            size:9
        }],
    }, 'Go manifest and artifact digest verified')
    t.ok(readFileSync(fixture).length > 0, 'checked-in compressed fixture')
})
