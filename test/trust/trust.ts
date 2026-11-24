// The trust record (spec 03, 2.5, 2.6, 5.3) in a temporary Git repository.
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { tempRepo, tempDir } from '../helpers/repo.js'
import {
    approve,
    isApproved,
    stateDir,
    trustPath,
} from '../../src/trust/trust.js'

const H1 = 'sha256:' + '1'.repeat(64)
const H2 = 'sha256:' + '2'.repeat(64)

function repo (t:CleanupTest) {
    const r = tempRepo()
    t.cleanup(r.remove)
    const file = path.join(r.dir, '.git', 'roast', 'trust.json')
    return { ...r, file, opts:{ env:r.env } }
}

function readJson (file:string):unknown {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function rejects (p:Promise<unknown>):Promise<Error|undefined> {
    try {
        await p
    } catch (err) {
        return err as Error
    }
    return undefined
}

test('trust record lives in the Git common directory', async t => {
    const r = repo(t)
    const sub = path.join(r.dir, 'a')
    fs.mkdirSync(sub)
    t.equal(await stateDir(sub, r.opts), path.join(r.dir, '.git', 'roast'),
        'state dir')
    t.equal(await trustPath(r.dir, r.opts), r.file, 'trust path')
    const outside = tempDir()
    t.cleanup(outside.remove)
    t.ok(await rejects(trustPath(outside.dir, { env:outside.env })),
        'outside a repository throws')
})

test('absent record is not approved; approve writes version 2',
    async t => {
        const r = repo(t)
        t.equal(await isApproved(r.dir, H1, r.opts), 'not-approved',
            'not approved')
        t.ok(!fs.existsSync(path.dirname(r.file)), 'nothing created')
        await approve(r.dir, H1, r.opts)
        t.deepEqual(readJson(r.file), { version:2, approved:[H1] },
            'version 2 with one hash')
        t.equal(fs.statSync(r.file).mode & 0o777, 0o600, 'mode 0600')
        t.equal(await isApproved(r.dir, H1, r.opts), 'approved', 'approved')
        t.equal(await isApproved(r.dir, H2, r.opts), 'not-approved',
            'another hash is not')
    })

test('approving twice keeps one entry; a second hash appends',
    async t => {
        const r = repo(t)
        await approve(r.dir, H1, r.opts)
        await approve(r.dir, H1, r.opts)
        t.deepEqual(readJson(r.file), { version:2, approved:[H1] },
            'one entry')
        await approve(r.dir, H2, r.opts)
        t.deepEqual(readJson(r.file), { version:2, approved:[H1, H2] },
            'appended in order')
    })

test('a version 1 record is legacy; approve replaces it', async t => {
    const r = repo(t)
    fs.mkdirSync(path.dirname(r.file))
    fs.writeFileSync(r.file, JSON.stringify({ version:1, approved:[H1] }))
    t.equal(await isApproved(r.dir, H1, r.opts), 'legacy', 'legacy')
    await approve(r.dir, H2, r.opts)
    t.deepEqual(readJson(r.file), { version:2, approved:[H2] },
        'replaced with version 2 holding only the new hash')
})

test('a malformed record makes isApproved and approve throw',
    async t => {
        const bodies = [
            '{not json',
            JSON.stringify({ version:3, approved:[] }),
            JSON.stringify({ approved:[H1] }),
            JSON.stringify({ version:2, approved:H1 }),
            JSON.stringify({ version:2, approved:[1] }),
            JSON.stringify([]),
            JSON.stringify({ version:'2', approved:[] }),
        ]
        for (const body of bodies) {
            const r = repo(t)
            fs.mkdirSync(path.dirname(r.file))
            fs.writeFileSync(r.file, body)
            t.ok(await rejects(isApproved(r.dir, H1, r.opts)),
                `isApproved throws on ${body}`)
            t.ok(await rejects(approve(r.dir, H1, r.opts)),
                `approve throws on ${body}`)
            t.equal(fs.readFileSync(r.file, 'utf8'), body, 'file unchanged')
        }
    })

test('approved null reads as empty', async t => {
    const r = repo(t)
    fs.mkdirSync(path.dirname(r.file))
    fs.writeFileSync(r.file, JSON.stringify({
        version:2,
        approved:null,
        extra:true
    }))
    t.equal(await isApproved(r.dir, H1, r.opts), 'not-approved',
        'not approved')
    await approve(r.dir, H1, r.opts)
    t.deepEqual(readJson(r.file), { version:2, approved:[H1] },
        'unknown members dropped on write')
})
