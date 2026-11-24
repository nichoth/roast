import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import {
    DEFAULT_DENYLIST,
    denylisted,
    denylistedUntracked,
    denylistedUntrackedRaw,
} from '../../src/snapshot/denylist.js'
import { newRepo } from '../scope/helpers.js'
import { fakeGit, onArg } from '../context/tools-helpers.js'

test('denylisted matches default patterns by basename or path', t => {
    const hits = [
        '.env', '.env.local', 'sub/.env.production', '.ENV',
        'server.pem', 'a/b/SERVER.PEM', 'deploy_rsa', 'tls.key',
        'creds.json', 'dir/credentials.json', '.npmrc', '.netrc',
        '_netrc', '.pgpass', '.git-credentials', 'cert.p12', 'cert.pfx',
        'id_rsa', 'id_rsa.pub', 'id_rsa_work', 'id_ed25519_github',
        'home/.ssh/id_ecdsa', 'id_dsa', 'id_xmss', '.pypirc',
    ]
    for (const p of hits) t.ok(denylisted(p), `denied: ${p}`)
    const misses = [
        'id_map.go', 'src/main.go', 'environment.ts', 'README.md',
        'keys/notes.txt', 'credentials.json.md',
    ]
    for (const p of misses) t.ok(!denylisted(p), `allowed: ${p}`)
})

test('denylisted with custom patterns, full path and bad pattern', t => {
    t.ok(denylisted('a/b.txt', ['a/*.txt']), 'full path match')
    t.ok(!denylisted('a/c/b.txt', ['a/*.txt']), 'star does not cross /')
    t.ok(denylisted('X.TXT', ['*.txt']), 'case folded')
    t.ok(!denylisted('a[', ['a[']), 'malformed pattern never matches')
    t.ok(!denylisted('anything', []), 'empty list matches nothing')
})

test('DEFAULT_DENYLIST keeps the spec order', t => {
    t.deepEqual([...DEFAULT_DENYLIST], [
        '.env*', '*.pem', '*_rsa', '*.key', 'creds*',
        'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'id_xmss*',
        'credentials.json', '.npmrc', '.pypirc', '.netrc', '_netrc',
        '.pgpass', '.git-credentials', '*.p12', '*.pfx',
    ], 'order')
})

test('denylistedUntracked returns sorted untracked non-ignored hits',
    async t => {
        const repo = newRepo()
        repo.write('tracked.pem', 'x\n')
        repo.commitAll()
        repo.write('z/.env', 'SECRET=1\n')
        repo.write('b.key', 'k\n')
        repo.write('ignored.pem', 'k\n')
        repo.write('.gitignore', 'ignored.pem\n')
        repo.write('ok.go', 'package x\n')
        const got = await denylistedUntracked(repo.dir, { env:repo.env })
        t.deepEqual(got, ['b.key', 'z/.env'], 'sorted, untracked only')
        repo.cleanup()
    })

test('denylistedUntracked with an empty list does not run git',
    async t => {
        const dir = fs.mkdtempSync(path.join('/tmp', 'roast-nogit-'))
        // Not a repository: running git here would fail.
        const got = await denylistedUntracked(dir, { patterns:[] })
        t.deepEqual(got, [], 'empty')
        fs.rmSync(dir, { recursive:true, force:true })
    })

test('denylistedUntrackedRaw keeps names that are not valid UTF-8',
    async t => {
        const repo = newRepo()
        // APFS refuses such names, so a fake git lists them.
        const fake = fakeGit(repo, onArg('--others',
            "printf '\\377dir/.env\\000ok.go\\000\\377.pem\\000'"))
        const got = await denylistedUntrackedRaw(repo.dir,
            { env:fake.env })
        t.deepEqual(got.map(p => [...p.raw]), [
            [0xff, ...Buffer.from('.pem')],
            [0xff, ...Buffer.from('dir/.env')],
        ], 'raw names, byte order')
        t.deepEqual(got.map(p => p.name),
            ['\ufffd.pem', '\ufffddir/.env'], 'lossy names')
        fake.cleanup()
        repo.cleanup()
    })
