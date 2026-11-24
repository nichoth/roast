import { test } from '@substrate-system/tapzero'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { explorationTools } from '../../src/context/tools.js'
import {
    LIVE_TREE,
    pinnedWorktree,
    type Tree,
} from '../../src/context/tree.js'
import { encodeToolResult } from '../../src/llm/json.js'
import { denylistedUntracked } from '../../src/snapshot/denylist.js'
import { newRepo, tempDir, type TestRepo } from '../scope/helpers.js'
import { allTrees, call, content } from './tools-helpers.js'

test('explorationTools returns the three tools, described per tree',
    async t => {
        const repo = newRepo()
        const descriptions = new Map<string, Set<string>>()
        for (const [, tree] of await allTrees(repo)) {
            const tools = explorationTools(repo.dir, tree, { env:repo.env })
            t.deepEqual(tools.map(x => x.name),
                ['read_file', 'list_files', 'grep_repo'], 'exactly three')
            for (const tool of tools) {
                t.equal(typeof tool.run, 'function', `${tool.name} runs`)
                t.equal(tool.schema.type, 'object', `${tool.name} schema`)
                const set = descriptions.get(tool.name) ?? new Set()
                set.add(tool.description)
                descriptions.set(tool.name, set)
            }
        }
        for (const [name, set] of descriptions) {
            t.equal(set.size, 3, `${name} descriptions differ per tree`)
        }
        repo.cleanup()
    })

const SECRETS = ['FAKETOKEN', 'GITIGNORED_SECRET', 'DENYLISTED_SECRET',
    'repositoryformatversion']

const BLOCKED = ['.git/config', '.GIT/config', '.Git/HEAD',
    'gitlink/config', '.env', 'build/out.go', 'credentials.json']

function liveFixture ():TestRepo {
    const repo = newRepo()
    repo.write('.gitignore', '.env\nbuild/\n')
    repo.write('a.go', 'package a\n')
    repo.commitAll()
    repo.git('config', 'remote.origin.url',
        'https://user:FAKETOKEN@example.com/x/y')
    repo.write('.env', 'API_TOKEN=GITIGNORED_SECRET\n')
    repo.write('build/out.go', 'package build // GITIGNORED_SECRET\n')
    repo.write('credentials.json', '{"token":"DENYLISTED_SECRET"}\n')
    repo.write('new.go', 'package a // new\n')
    fs.symlinkSync('.git', path.join(repo.dir, 'gitlink'))
    return repo
}

// The captured worktree, built with plumbing as the snapshot area does.
async function captureWorktree (repo:TestRepo):Promise<Tree> {
    const dir = tempDir('roast-ctx-cap-')
    const env = { ...repo.env, GIT_INDEX_FILE:path.join(dir, 'index') }
    const run = (...args:string[]) => execFileSync('git',
        ['-C', repo.dir, ...args], { env, encoding:'utf8' })
    run('read-tree', 'HEAD')
    const denied = await denylistedUntracked(repo.dir, { env:repo.env })
    const others = run('ls-files', '-z', '--others', '--exclude-standard')
        .split('\u0000')
        .filter(p => p !== '' && !denied.includes(p))
    if (others.length > 0) run('add', '--', ...others)
    const tree = pinnedWorktree(run('write-tree').trim())
    fs.rmSync(dir, { recursive:true, force:true })
    return tree
}

test('no tool serves .git, ignored, or denylisted content', async t => {
    const repo = liveFixture()
    const trees:[string, Tree][] = [['live', LIVE_TREE],
        ['pinned', await captureWorktree(repo)]]
    for (const [name, tree] of trees) {
        for (const p of BLOCKED) {
            const r = await call(repo, tree, 'read_file', { path:p })
            t.ok(typeof r.error === 'string', `${name}: read_file ${p}`)
        }
        for (const d of ['.git', 'build', 'gitlink']) {
            const r = await call(repo, tree, 'list_files', { directory:d })
            t.ok(typeof r.error === 'string' || r.matches === null,
                `${name}: list_files ${d} serves nothing`)
        }
        const all = encodeToolResult(await call(repo, tree, 'list_files',
            { pattern:'**' }))
        t.ok(all.includes('new.go'), `${name}: lists new.go`)
        for (const p of ['out.go', 'credentials.json', 'config', 'HEAD']) {
            t.ok(!all.includes(p), `${name}: list_files hides ${p}`)
        }
        for (const s of SECRETS) {
            const r = encodeToolResult(await call(repo, tree, 'grep_repo',
                { pattern:s }))
            t.ok(r.includes('"matches":[]'), `${name}: grep_repo ${s} ` +
                'finds nothing')
        }
        const ok = await call(repo, tree, 'read_file', { path:'new.go' })
        t.ok(content(ok).includes('new'), `${name}: serves new.go`)
    }
    repo.cleanup()
})

const SLACK = 512
const CAP = 65536

test('every tool result is bounded', async t => {
    const repo = newRepo()
    repo.write('wide.txt', ('A'.repeat(100000) + '\n').repeat(40))
    repo.write('tall.txt', 'short line\n'.repeat(200000))
    repo.write('min.js', 'B'.repeat(5000000))
    let many = ''
    for (let i = 0; i < 3000; i++) many += `needle ${i} ${'x'.repeat(500)}\n`
    repo.write('many.txt', many)
    const long = 'd'.repeat(200)
    for (let i = 0; i < 400; i++) {
        repo.write(`${long}/${long}/f${String(i).padStart(3, '0')}.go`,
            'package p\n')
    }
    repo.commitAll()
    const head = pinnedWorktree(repo.git('rev-parse', 'HEAD^{tree}').trim())
    for (const [name, tree] of [['live', LIVE_TREE], ['pinned', head]] as
        [string, Tree][]) {
        for (const args of [
            { path:'wide.txt', limit:1e9 },
            { path:'tall.txt', limit:1e9 },
            { path:'tall.txt', offset:1e18, limit:1e18 },
            { path:'min.js' },
        ]) {
            const r = await call(repo, tree, 'read_file', args)
            const size = Buffer.byteLength(encodeToolResult(r))
            t.ok(size <= CAP + SLACK,
                `${name}: read_file ${JSON.stringify(args)} is ${size} bytes`)
            if (args.path === 'wide.txt') {
                t.equal(r.more_below, true, `${name}: wide has more below`)
            }
        }
        const r = await call(repo, tree, 'read_file',
            { path:'wide.txt', offset:1, limit:3 })
        t.deepEqual(r.returned_range, [1, 1], `${name}: wide resumes`)
        t.ok(content(r).includes('offset>=2'), `${name}: at offset>=2`)

        for (const pattern of ['needle', 'B']) {
            const out = encodeToolResult(await call(repo, tree, 'grep_repo',
                { pattern }))
            t.ok(Buffer.byteLength(out) <= CAP + SLACK,
                `${name}: grep ${pattern} is bounded`)
            t.ok(out.includes('truncated'), `${name}: grep ${pattern} marks`)
        }
        const list = await call(repo, tree, 'list_files', { pattern:'*.go' })
        const out = encodeToolResult(list)
        t.ok(Buffer.byteLength(out) <= CAP + SLACK,
            `${name}: list_files is bounded`)
        const m = list.matches as string[]
        t.ok(m.length < 400 && !m[m.length - 1].endsWith('.go'),
            `${name}: list_files marks truncation`)
    }
    repo.cleanup()
})
