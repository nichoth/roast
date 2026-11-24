import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { resolveUnderRepo } from '../../src/context/paths.js'
import { tempDir } from '../scope/helpers.js'

test('resolveUnderRepo rejects escapes and accepts repo paths', t => {
    const repo = tempDir('roast-ctx-repo-')
    const outside = tempDir('roast-ctx-out-')
    fs.symlinkSync(outside, path.join(repo, 'escape_link'))
    const cases:[string, boolean][] = [
        ['', false],
        ['/etc/passwd', false],
        ['../escape', false],
        ['sub/../../etc/passwd', false],
        ['escape_link/secret.txt', false],
        ['.git/config', false],
        ['.GIT/config', false],
        ['internal/foo.go', true],
        ['.', true],
    ]
    for (const [p, ok] of cases) {
        t.equal(resolveUnderRepo(repo, p) !== null, ok,
            `resolveUnderRepo(${JSON.stringify(p)}) ok=${ok}`)
    }
    t.equal(resolveUnderRepo(repo, 'internal/foo.go'),
        path.join(repo, 'internal/foo.go'), 'returns the joined candidate')
    fs.rmSync(repo, { recursive:true, force:true })
    fs.rmSync(outside, { recursive:true, force:true })
})
