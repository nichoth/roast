// Stored credential files and the credential store (spec 03, 2.12, 2.13,
// 5.5), in temporary Git repositories with an isolated HOME.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, type CleanupTest } from '../helpers/test.js'
import { tempRepo, tempDir, type TempDir } from '../helpers/repo.js'
import {
    deleteCredential,
    saveCredential,
    loadCredentials,
    openCredentialStore,
    projectCredentialsPath,
    userCredentialsPath,
} from '../../src/credentials/credentials.js'

const KEY = 'sk-ant-test-0123'

// Writes `body` at <dir>/roast/credentials.json with `mode`.
function writeFile (dir:string, body:string, mode = 0o600):string {
    const file = path.join(dir, 'roast', 'credentials.json')
    fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 })
    fs.writeFileSync(file, body)
    fs.chmodSync(file, mode)
    return file
}

function scratch (t:CleanupTest):string {
    const d = tempDir()
    t.cleanup(d.remove)
    return d.dir
}

function repo (t:CleanupTest):TempDir {
    const r = tempRepo()
    t.cleanup(r.remove)
    return r
}

async function rejects (p:Promise<unknown>):Promise<Error|undefined> {
    try {
        await p
    } catch (err) {
        return err as Error
    }
    return undefined
}

function thrown (fn:() => unknown):Error|undefined {
    try {
        fn()
    } catch (err) {
        return err as Error
    }
    return undefined
}

test('project credentials live at each worktree root', async t => {
    const r = repo(t)
    const want = path.join(r.dir, '.env.roast')
    const sub = path.join(r.dir, 'a')
    fs.mkdirSync(sub)
    t.equal(await projectCredentialsPath(sub, { env:r.env }), want,
        'from a subdirectory')

    const git = (...args:string[]) => execFileSync('git', args,
        { cwd:r.dir, env:r.env, stdio:'ignore' })
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const linked = path.join(path.dirname(r.dir), 'linked')
    git('worktree', 'add', '-q', linked)
    t.equal(await projectCredentialsPath(linked, { env:r.env }),
        path.join(linked, '.env.roast'),
        'from a linked worktree')
    await saveCredential(want, 'openai', KEY, new Date(), { env:r.env })
    const store = await openCredentialStore(linked, r.env)
    t.deepEqual(store.lookup('openai'), { key:KEY, scope:'project' },
        'a manually linked worktree can use the primary checkout key')
    t.ok(!fs.existsSync(path.join(linked, '.env.roast')),
        'credential lookup leaves the linked checkout untouched')

    const outside = tempDir()
    t.cleanup(outside.remove)
    t.ok(await rejects(projectCredentialsPath(outside.dir,
        { env:outside.env })), 'outside a repository throws')
})

test('user credentials follow XDG_CONFIG_HOME, else HOME', t => {
    t.equal(userCredentialsPath({ XDG_CONFIG_HOME:'/x', HOME:'/h' }),
        path.join('/x', 'roast', 'credentials.json'), 'XDG_CONFIG_HOME')
    t.equal(userCredentialsPath({ XDG_CONFIG_HOME:'', HOME:'/h' }),
        path.join('/h', '.config', 'roast', 'credentials.json'),
        'empty XDG_CONFIG_HOME falls back to HOME')
    t.equal(userCredentialsPath({ HOME:'/h' }),
        path.join('/h', '.config', 'roast', 'credentials.json'), 'HOME')
    t.ok(thrown(() => userCredentialsPath({})), 'neither set throws')
    t.ok(thrown(() => userCredentialsPath({ HOME:'', XDG_CONFIG_HOME:'' })),
        'both empty throws')
})

test('a missing credentials file loads as empty', async t => {
    const dir = scratch(t)
    const got = await loadCredentials(path.join(dir, 'roast',
        'credentials.json'))
    t.equal(got.size, 0, 'no entries')
})

test('a well-formed file loads its entries', async t => {
    const file = writeFile(scratch(t), JSON.stringify({
        version:1,
        providers:{
            anthropic:{ key:KEY, stored_at:'2026-11-14T12:00:00Z' },
            openai:{ key:'sk-other' },
            openrouter:{ key:'sk-or', stored_at:null },
        },
    }))
    const got = await loadCredentials(file)
    t.deepEqual([...got.keys()].sort(), ['anthropic', 'openai',
        'openrouter'], 'providers')
    t.equal(got.get('anthropic')?.key, KEY, 'key')
    t.equal(got.get('anthropic')?.storedAt, '2026-11-14T12:00:00Z',
        'stored_at kept as written')
    const empty = writeFile(scratch(t), '{"version":1,"providers":null}')
    t.equal((await loadCredentials(empty)).size, 0, 'null providers')
    const absent = writeFile(scratch(t), '{"version":1}')
    t.equal((await loadCredentials(absent)).size, 0, 'missing providers')
})

const MALFORMED:[string, string][] = [
    ['unknown provider',
        '{"version":1,"providers":{"acme":{"key":"k"}}}'],
    ['unknown entry field',
        '{"version":1,"providers":{"openai":{"key":"k","extra":1}}}'],
    ['unknown top-level field', '{"version":1,"providers":{},"x":1}'],
    ['missing version', '{"providers":{}}'],
    ['wrong version', '{"version":2,"providers":{}}'],
    ['string version', '{"version":"1","providers":{}}'],
    ['empty key', '{"version":1,"providers":{"openai":{"key":""}}}'],
    ['blank key', '{"version":1,"providers":{"openai":{"key":" \\t"}}}'],
    ['missing key', '{"version":1,"providers":{"openai":{}}}'],
    ['non-string key', '{"version":1,"providers":{"openai":{"key":7}}}'],
    ['bad stored_at', '{"version":1,"providers":{"openai":' +
        '{"key":"k","stored_at":"yesterday"}}}'],
    ['non-JSON', 'not json'],
    ['trailing data', '{"version":1}{}'],
    ['not an object', '[1]'],
    ['upper-case Version', '{"Version":1,"providers":{}}'],
    ['upper-case Providers', '{"version":1,"Providers":{}}'],
    ['upper-case Key', '{"version":1,"providers":{"openai":{"Key":"k"}}}'],
]

test('loading rejects malformed files', async t => {
    for (const [name, body] of MALFORMED) {
        const file = writeFile(scratch(t), body)
        t.ok(await rejects(loadCredentials(file)), name)
    }
})

test('loading never reveals a key in its error', async t => {
    const file = writeFile(scratch(t), JSON.stringify({
        version:1,
        providers:{ openai:{ key:KEY, stored_at:'nope' } },
    }))
    const err = await rejects(loadCredentials(file))
    t.ok(err, 'rejected')
    t.ok(!String(err?.message).includes(KEY), 'no key in message')
})

test('loading rejects a file other users can access', async t => {
    const body = JSON.stringify({
        version:1,
        providers:{ openai:{ key:KEY } },
    })
    for (const mode of [0o640, 0o604, 0o644, 0o620]) {
        const file = writeFile(scratch(t), body, mode)
        const err = await rejects(loadCredentials(file))
        t.ok(err, `mode ${mode.toString(8)} rejected`)
        t.ok(String(err?.message).includes('chmod 600'), 'names chmod 600')
    }
    const ok = writeFile(scratch(t), body, 0o400)
    t.equal((await loadCredentials(ok)).size, 1, 'owner-only mode loads')
})

function credentialsIn (dir:string):string {
    return path.join(dir, 'roast', 'credentials.json')
}

function mode (p:string):number {
    return fs.statSync(p).mode & 0o777
}

test('save writes a private file and replaces it atomically', async t => {
    const file = credentialsIn(scratch(t))
    const first = new Date(Date.UTC(2026, 10, 14, 12, 0, 0))
    await saveCredential(file, 'anthropic', KEY, first)
    t.equal(mode(file), 0o600, 'file mode 0600')
    t.equal(mode(path.dirname(file)), 0o700, 'directory mode 0700')

    const second = new Date(Date.UTC(2026, 10, 15, 8, 30, 0, 120))
    await saveCredential(file, 'openai', 'sk-two', second)
    await saveCredential(file, 'anthropic', 'sk-ant-new', second)
    t.deepEqual(fs.readdirSync(path.dirname(file)), ['credentials.json'],
        'no temp file left behind')
    t.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
        version:1,
        providers:{
            anthropic:{
                key:'sk-ant-new',
                stored_at:'2026-11-15T08:30:00.12Z',
            },
            openai:{ key:'sk-two', stored_at:'2026-11-15T08:30:00.12Z' },
        },
    }, 'version 1 with each provider, fraction trimmed')
    const got = await loadCredentials(file)
    t.equal(got.get('anthropic')?.key, 'sk-ant-new', 'replaced key')
    t.equal(got.get('openai')?.key, 'sk-two', 'second key')
})

test('save keeps another provider\'s stored_at verbatim', async t => {
    const file = writeFile(scratch(t), JSON.stringify({
        version:1,
        providers:{
            openai:{ key:'sk-a', stored_at:'2026-01-02T03:04:05+02:00' },
            openrouter:{ key:'sk-or' },
        },
    }))
    await saveCredential(file, 'anthropic', KEY,
        new Date(Date.UTC(2026, 0, 1)))
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    t.equal(doc.providers.openai.stored_at, '2026-01-02T03:04:05+02:00',
        'original string kept')
    t.equal(doc.providers.openrouter.stored_at, '0001-01-01T00:00:00Z',
        'absent stored_at written as the zero time')
    t.equal(doc.providers.anthropic.stored_at, '2026-01-01T00:00:00Z',
        'whole seconds have no fraction')
})

test('save rejects bad input and bad existing files', async t => {
    const file = credentialsIn(scratch(t))
    t.ok(await rejects(saveCredential(file, 'acme', KEY, new Date())),
        'unknown provider')
    t.ok(await rejects(saveCredential(file, 'openai', ' ', new Date())),
        'blank key')
    t.ok(!fs.existsSync(file), 'nothing written')
    const loose = writeFile(scratch(t), '{"version":1}', 0o644)
    t.ok(await rejects(saveCredential(loose, 'openai', KEY, new Date())),
        'over-permissive existing file blocks saving')
})

test('save refuses a tracked project credential file', async t => {
    const r = repo(t)
    const file = path.join(r.dir, '.env.roast')
    fs.writeFileSync(file, '# tracked placeholder\n', { mode:0o600 })
    execFileSync('git', ['add', '--', path.basename(file)],
        { cwd:r.dir, env:r.env })
    const err = await rejects(saveCredential(file, 'openai', KEY,
        new Date(), { env:r.env }))
    t.ok(err?.message.includes('tracked by Git'), 'tracked file rejected')
    t.equal(fs.readFileSync(file, 'utf8'), '# tracked placeholder\n',
        'never wrote a key')
})

test('save tightens an existing 0755 directory', async t => {
    const file = credentialsIn(scratch(t))
    fs.mkdirSync(path.dirname(file), { mode:0o755 })
    fs.chmodSync(path.dirname(file), 0o755)
    await saveCredential(file, 'openai', KEY, new Date())
    t.equal(mode(path.dirname(file)), 0o700, 'directory is 0700')
})

test('delete removes one provider and keeps the others', async t => {
    const file = credentialsIn(scratch(t))
    await saveCredential(file, 'openai', 'sk-a', new Date())
    await saveCredential(file, 'anthropic', KEY, new Date())
    await deleteCredential(file, 'openai')
    t.deepEqual([...(await loadCredentials(file)).keys()], ['anthropic'],
        'only anthropic left')
    await deleteCredential(file, 'anthropic')
    t.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
        { version:1, providers:{} }, 'empty providers object')

    const missing = credentialsIn(scratch(t))
    await deleteCredential(missing, 'openai')
    t.ok(!fs.existsSync(path.dirname(missing)), 'missing file: no write')
})

// A temp repo plus its project and user credentials paths.
function storeRepo (t:CleanupTest) {
    const r = repo(t)
    const project = path.join(r.dir, '.env.roast')
    const user = path.join(r.env.XDG_CONFIG_HOME, 'roast',
        'credentials.json')
    return { ...r, project, user }
}

test('the store prefers project scope over user scope', async t => {
    const r = storeRepo(t)
    await saveCredential(r.project, 'anthropic', 'project-key', new Date())
    await saveCredential(r.user, 'anthropic', 'user-key', new Date())
    await saveCredential(r.user, 'openai', 'user-openai', new Date())
    const store = await openCredentialStore(r.dir, r.env)
    const found = store.lookup('anthropic')
    t.ok(!(found instanceof Promise), 'lookup is synchronous')
    t.deepEqual(found, { key:'project-key', scope:'project' }, 'project')
    t.deepEqual(store.lookup('openai'), { key:'user-openai', scope:'user' },
        'falls through to user scope')
    t.equal(store.lookup('openrouter'), null, 'none stored')
})

test('outside a repository the store uses only user scope', async t => {
    const d = tempDir()
    t.cleanup(d.remove)
    const user = path.join(d.env.XDG_CONFIG_HOME, 'roast',
        'credentials.json')
    await saveCredential(user, 'openai', 'user-openai', new Date())
    const store = await openCredentialStore(d.dir, d.env)
    t.deepEqual(store.lookup('openai'), { key:'user-openai', scope:'user' },
        'user key')
    const noDir = await openCredentialStore('', d.env)
    t.deepEqual(noDir.lookup('openai'), { key:'user-openai', scope:'user' },
        'empty dir: user scope only')
    const noHome = await openCredentialStore(d.dir,
        { ...d.env, HOME:'', XDG_CONFIG_HOME:'' })
    t.equal(noHome.lookup('openai'), null, 'no scope at all')
})

test('the store reads files lazily and reports a bad file', async t => {
    const r = storeRepo(t)
    const store = await openCredentialStore(r.dir, r.env)
    fs.mkdirSync(path.dirname(r.project), { recursive:true })
    fs.writeFileSync(r.project, 'not json', { mode:0o600 })
    await saveCredential(r.user, 'openai', 'user-openai', new Date())
    t.ok(thrown(() => store.lookup('openai')),
        'a bad project file throws even when user scope has the key')
    t.ok(thrown(() => store.lookup('openai')), 'failure is not cached')
    fs.rmSync(r.project)
    t.deepEqual(store.lookup('openai'), { key:'user-openai', scope:'user' },
        'a fixed file is read again')

    const r2 = storeRepo(t)
    await saveCredential(r2.project, 'openai', 'project-key', new Date())
    fs.mkdirSync(path.dirname(r2.user), { recursive:true })
    fs.writeFileSync(r2.user, '{}', { mode:0o644 })
    const store2 = await openCredentialStore(r2.dir, r2.env)
    t.deepEqual(store2.lookup('openai'),
        { key:'project-key', scope:'project' },
        'a bad user file is not read when project scope matches')
    t.ok(thrown(() => store2.lookup('anthropic')),
        'a bad user file throws once reached')
})
