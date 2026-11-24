// `roast runs checkout` and `roast runs prune` after a real review
// (spec 11, test plan items 13-15 and the "New tests" paragraph).
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { tempDir, tempRepo } from '../helpers/repo.js'
import {
    approveProjectConfig,
    gitIn,
    profileConfig,
    reviewMeta,
    settingsRepo,
    writeConfig,
    type ReviewRepo,
} from '../helpers/review.js'

const REVIEW = ['review', '--no-verify', '--format', 'json']

// A repository reviewed once with snapshots on; returns the run ID.
async function reviewed (
    t:CleanupTest,
    review:object = {}
):Promise<{ r:ReviewRepo, id:string }> {
    const r = await settingsRepo(t)
    writeConfig(r.dir, profileConfig(r.server.url, { review }))
    await approveProjectConfig(r)
    const res = await r.roast(REVIEW)
    if (res.code !== 0) throw new Error(`review failed: ${res.stderr}`)
    return { r, id:reviewMeta(r).run_id }
}

// Registers removal of a worktree checked out at `dest`.
function removeLater (t:CleanupTest, r:ReviewRepo, dest:string):void {
    t.cleanup(() => {
        try {
            gitIn(r, ['worktree', 'remove', '--force', dest])
        } catch {
            fs.rmSync(dest, { recursive:true, force:true })
        }
    })
}

// A destination next to the repository, inside the test's temp root.
function outside (t:CleanupTest, r:ReviewRepo):string {
    const dest = path.join(path.dirname(r.dir), 'out')
    removeLater(t, r, dest)
    return dest
}

function reviewedFile (r:ReviewRepo):string {
    return fs.readFileSync(path.join(r.dir, 'main.go'), 'utf8')
}

test('runs checkout materializes the reviewed state', async t => {
    const { r, id } = await reviewed(t)
    const dest = outside(t, r)
    const res = await r.roast(['runs', 'checkout', id, dest])
    t.equal(res.code, 0, res.stderr)
    t.equal(res.stdout, dest + '\n', 'stdout is only the destination')
    t.equal(fs.readFileSync(path.join(dest, 'main.go'), 'utf8'),
        reviewedFile(r), 'reviewed content')
})

test('a relative destination lands under the working directory',
    async t => {
        const { r, id } = await reviewed(t)
        const sub = path.join(r.dir, 'sub')
        fs.mkdirSync(sub)
        const dest = path.join(sub, 'replay')
        removeLater(t, r, dest)
        const res = await r.roast(['runs', 'checkout', id, 'replay'],
            { cwd:sub })
        t.equal(res.code, 0, res.stderr)
        t.equal(res.stdout, dest + '\n', 'absolute destination printed')
        t.equal(fs.readFileSync(path.join(dest, 'main.go'), 'utf8'),
            reviewedFile(r), 'reviewed content under the subdirectory')
    })

test('runs checkout resolves a unique run ID prefix', async t => {
    const { r, id } = await reviewed(t)
    const dest = outside(t, r)
    const res = await r.roast(['runs', 'checkout', id.slice(0, 10), dest])
    t.equal(res.code, 0, res.stderr)
    t.equal(res.stdout, dest + '\n', 'checked out')
})

test('runs checkout usage errors exit 2', async t => {
    const { r, id } = await reviewed(t)
    const dest = outside(t, r)
    const cases:[string, string[]][] = [
        ['no positionals', []],
        ['three positionals', [id, dest, 'extra']],
        ['an unknown run', ['19990101T000000Z-00000000', dest]],
        ['an invalid run ID', ['..', dest]],
    ]
    // A second run sharing the first's date prefix makes it ambiguous.
    fs.mkdirSync(path.join(r.dir, '.roast', 'runs', id.slice(0, 9) +
        'X-ambiguous'))
    cases.push(['an ambiguous prefix', [id.slice(0, 9), dest]])
    for (const [name, args] of cases) {
        const res = await r.roast(['runs', 'checkout', ...args])
        t.equal(res.code, 2, `${name} exits 2`)
        t.equal(res.stdout, '', `${name} prints nothing`)
    }
    t.ok(!fs.existsSync(dest), 'nothing checked out')
})

test('runs checkout of a run without a snapshot exits 2', async t => {
    const { r, id } = await reviewed(t, { snapshot:false })
    const dest = outside(t, r)
    const res = await r.roast(['runs', 'checkout', id, dest])
    t.equal(res.code, 2, res.stderr)
    t.equal(res.stdout, '', 'nothing on stdout')
    t.ok(!fs.existsSync(dest), 'nothing checked out')
})

function snapshotRefs (r:ReviewRepo):string[] {
    return gitIn(r, ['for-each-ref', '--format=%(refname)',
        'refs/roast/snapshots/']).split('\n').filter(Boolean)
}

test('runs prune with no refs exits 0 and prints nothing', async t => {
    const r = tempRepo()
    t.cleanup(r.remove)
    const res = await runRoast(['runs', 'prune', '--dry-run'],
        { cwd:r.dir, env:r.env })
    t.equal(res.code, 0, res.stderr)
    t.equal(res.stdout, '', 'nothing on stdout')
})

test('runs prune lists, then deletes, only the snapshot ref', async t => {
    const { r, id } = await reviewed(t)
    const ref = `refs/roast/snapshots/${id}`
    const dry = await r.roast(['runs', 'prune', '--dry-run',
        '--older-than', '1ns'])
    t.equal(dry.code, 0, dry.stderr)
    const lines = dry.stdout.split('\n').filter(Boolean)
    t.equal(lines.length, 1, 'one line')
    t.ok(lines[0]?.startsWith(`would delete ${ref} `), 'names the ref')
    t.deepEqual(snapshotRefs(r), [ref], 'ref left in place')

    const real = await r.roast(['runs', 'prune', '--older-than', '1ns'])
    t.equal(real.code, 0, real.stderr)
    t.equal(real.stdout.split('\n').filter(Boolean).length, 1, 'one line')
    t.deepEqual(snapshotRefs(r), [], 'ref deleted')
    t.ok(fs.existsSync(path.join(r.dir, '.roast', 'runs', id,
        'meta.json')), 'run directory remains')
})

test('runs prune usage errors exit 2', async t => {
    const r = tempRepo()
    t.cleanup(r.remove)
    const outsideRepo = tempDir()
    t.cleanup(outsideRepo.remove)
    const cases:[string, string[], typeof r][] = [
        ['a bad --older-than', ['--older-than', 'bogus'], r],
        ['a positional', ['extra'], r],
        ['outside a repository', ['--dry-run'], outsideRepo],
    ]
    for (const [name, args, d] of cases) {
        const res = await runRoast(['runs', 'prune', ...args],
            { cwd:d.dir, env:d.env })
        t.equal(res.code, 2, `${name} exits 2`)
        t.equal(res.stdout, '', `${name} prints nothing`)
    }
})
