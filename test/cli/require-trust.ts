// requireTrust (spec 03, 2.8) at its module seam with injected io; the
// review wiring is tested with the review command.
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test, type CleanupTest } from '../helpers/test.js'
import { tempRepo, type TempDir } from '../helpers/repo.js'
import { BufferStream, inputStream } from '../helpers/streams.js'
import { simulateTerminals } from '../helpers/terminal.js'
import { configFrom } from '../config/helpers.js'
import { requireTrust, type TrustIo } from '../../src/cli/trust.js'
import { LineReader } from '../../src/cli/terminal.js'
import { ExitCode, UsageError, exitCode } from '../../src/cli/errors.js'
import { trustHash, trustProjection } from '../../src/config/trust.js'
import { approve } from '../../src/trust/trust.js'

const CUSTOM = configFrom({
    inference_profiles:{
        gw:{
            model:'m',
            endpoint:'https://gw.example/v1',
            protocol:'chat',
            api_key_env:'GW_KEY',
        },
    },
    roles:{ finder:{ profile:'gw' }, verifier:{ profile:'gw' } },
})

const BUILTIN = configFrom({
    inference_profiles:{ o:{ model:'m' } },
    roles:{ finder:{ profile:'o' }, verifier:{ profile:'o' } },
})

interface Harness {
    repo:TempDir;
    file:string;
    io:TrustIo;
    stderr:BufferStream;
    reads ():number;
}

// A repo plus io whose stdin counts reads and answers `answer` (or
// fails when `answer` is undefined).
function harness (t:CleanupTest, answer?:string):Harness {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    let reads = 0
    const source = answer === undefined ? undefined : inputStream(answer)
    const stdin = new Readable({
        read () {
            reads++
            if (!source) {
                this.destroy(new Error('stdin must not be read'))
                return
            }
            const chunk = source.read()
            this.push(chunk)
            if (chunk !== null) this.push(null)
        },
    })
    const stderr = new BufferStream()
    return {
        repo,
        file:path.join(repo.dir, '.git', 'roast', 'trust.json'),
        stderr,
        reads:() => reads,
        io:{
            stdin,
            stderr,
            lines:new LineReader(stdin),
            env:repo.env,
            signal:new AbortController().signal,
        },
    }
}

async function failure (p:Promise<unknown>):Promise<unknown> {
    try {
        await p
    } catch (err) {
        return err
    }
    return undefined
}

function writeRecord (h:Harness, body:string):void {
    fs.mkdirSync(path.dirname(h.file), { recursive:true })
    fs.writeFileSync(h.file, body)
}

const HASH = trustHash(trustProjection(CUSTOM))

test('requireTrust passes configs that need no approval', async t => {
    const h = harness(t)
    t.equal(await failure(requireTrust(h.repo.dir, BUILTIN, h.io)),
        undefined, 'resolves')
    t.ok(!fs.existsSync(path.dirname(h.file)), 'nothing written')
    t.equal(h.reads(), 0, 'stdin untouched')
})

test('requireTrust passes an approved config', async t => {
    const h = harness(t)
    await approve(h.repo.dir, HASH, { env:h.repo.env })
    t.equal(await failure(requireTrust(h.repo.dir, CUSTOM, h.io)),
        undefined, 'resolves')
    t.equal(h.reads(), 0, 'stdin untouched')
})

test('requireTrust on non-terminals fails without reading stdin',
    async t => {
        for (const legacy of [false, true]) {
            const h = harness(t)
            simulateTerminals(t, false)
            if (legacy) writeRecord(h, '{"version":1,"approved":[]}')
            const err = await failure(requireTrust(h.repo.dir, CUSTOM, h.io))
            const name = legacy ? 'legacy' : 'not approved'
            t.ok(err instanceof UsageError, `${name}: usage error`)
            t.ok((err as Error).message.includes('npx roast trust'),
                `${name}: names npx roast trust`)
            t.equal(h.reads(), 0, `${name}: stdin untouched`)
        }
    })

test('default terminal detection keeps buffers non-interactive',
    async t => {
        const h = harness(t)
        const err = await failure(requireTrust(h.repo.dir, CUSTOM, h.io))
        t.ok(err instanceof UsageError, 'usage error without prompting')
        t.equal(h.reads(), 0, 'stdin untouched')
    })

test('requireTrust on terminals approves on y', async t => {
    for (const legacy of [false, true]) {
        const h = harness(t, 'y\n')
        simulateTerminals(t, true)
        if (legacy) writeRecord(h, '{"version":1,"approved":["x"]}')
        const err = await failure(requireTrust(h.repo.dir, CUSTOM, h.io))
        t.equal(err, undefined, 'resolves')
        t.ok(h.stderr.text().includes('https://gw.example/v1'),
            'summary on stderr')
        t.ok(h.stderr.text().includes('[y/N]'), 'asks on stderr')
        t.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')),
            { version:2, approved:[HASH] }, 'record written')
    }
})

test('requireTrust on terminals declined records nothing', async t => {
    for (const answer of ['', '\n', 'n\n', 'no\n', 'yy\n']) {
        const h = harness(t, answer)
        simulateTerminals(t, true)
        const err = await failure(requireTrust(h.repo.dir, CUSTOM, h.io))
        t.ok(err instanceof UsageError, `${JSON.stringify(answer)}: usage`)
        t.ok(!fs.existsSync(h.file), 'nothing written')
    }
})

test('requireTrust rethrows a malformed record as non-usage', async t => {
    for (const terminals of [false, true]) {
        const h = harness(t, 'y\n')
        simulateTerminals(t, terminals)
        writeRecord(h, '{not json')
        const err = await failure(requireTrust(h.repo.dir, CUSTOM, h.io))
        t.ok(err instanceof Error, 'fails')
        t.equal(exitCode(err), ExitCode.Partial, 'exit 4')
        t.equal(h.reads(), 0, 'stdin untouched')
        t.equal(fs.readFileSync(h.file, 'utf8'), '{not json',
            'file unchanged')
    }
})
