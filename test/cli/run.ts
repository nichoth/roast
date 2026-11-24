import { test } from '../helpers/test.js'
import { runRoast } from '../helpers/run.js'
import { tempDir, tempRepo } from '../helpers/repo.js'
import { registerCommand } from '../../src/cli/command.js'
import {
    CancelledError,
    ExitSignal,
    UsageError,
} from '../../src/cli/errors.js'

test('unknown commands and flags are usage errors', async t => {
    const cases = [
        ['bogus'],
        ['config', 'bogus'],
        ['completion'],
        ['eval'],
        ['install'],
        ['replay'],
        ['--bogus'],
        ['review', 'extra'],
        ['--', 'positional'],
    ]
    for (const args of cases) {
        const res = await runRoast(args)
        t.equal(res.code, 2, `${args.join(' ')} exits 2`)
        t.ok(res.error instanceof UsageError, 'a UsageError')
        t.ok(res.stderr.startsWith('roast: '), 'a text error on stderr')
    }
})

test('--help exits 0 with help on stdout and needs nothing', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    for (const flag of ['--help', '-h']) {
        const res = await runRoast([flag], { cwd:dir.dir, env:dir.env })
        t.equal(res.code, 0, `${flag} exits 0`)
        t.ok(res.stdout.length > 0, 'help on stdout')
        t.equal(res.stderr, '', 'nothing on stderr')
    }
    const review = await runRoast(['review', '--help'],
        { cwd:dir.dir, env:dir.env })
    t.equal(review.code, 0, 'review --help exits 0 outside a repository')
    t.ok(review.stdout.length > 0, 'review help on stdout')
})

test('--version prints the build string; root only', async t => {
    for (const flag of ['--version', '-v']) {
        const res = await runRoast([flag])
        t.equal(res.code, 0, `${flag} exits 0`)
        t.ok(/^roast version \S.*\n$/.test(res.stdout),
            'one version line on stdout')
    }
    const json = await runRoast(['--error-format', 'json', '--version'])
    t.equal(json.code, 0, 'after --error-format it is still root-level')

    let ran = false
    t.cleanup(registerCommand({
        command:'probe',
        describe:'test command',
        handler:() => { ran = true },
    }))
    const ok = await runRoast(['probe'])
    t.equal(ok.code, 0, 'the registered command runs')
    t.ok(ran, 'its handler was called')
    for (const flag of ['--version', '-v']) {
        const res = await runRoast(['probe', flag])
        t.equal(res.code, 2, `probe ${flag} is an unknown flag`)
    }
})

test('--error-format selects the error output', async t => {
    const bad = await runRoast(['--error-format', 'yaml'])
    t.equal(bad.code, 2, 'an invalid value exits 2')
    t.ok(bad.stderr.startsWith('roast: '), 'reported in text')

    const parse = await runRoast(['--error-format', 'json', '--bogus'])
    t.equal(parse.code, 2, 'a parse failure exits 2')
    const body = JSON.parse(parse.stderr)
    t.equal(body.error_category, 'usage', 'JSON category')
    t.equal(body.exit_code, 2, 'JSON exit code')
    t.equal(typeof body.message, 'string', 'JSON message')

    const eq = await runRoast(['bogus', '--error-format=json'])
    t.equal(eq.code, 2, 'unknown command exits 2')
    t.equal(JSON.parse(eq.stderr).error_category, 'usage',
        '--error-format=json after an unknown command')

    const text = await runRoast(['--bogus'])
    t.ok(text.stderr.startsWith('roast: '), 'text by default')
})

test('bare roast outside a repository prints help', async t => {
    const dir = tempDir()
    t.cleanup(dir.remove)
    const bare = await runRoast([], { cwd:dir.dir, env:dir.env })
    t.equal(bare.code, 0, 'exits 0')
    t.ok(bare.stdout.length > 0, 'help on stdout')
    t.equal(bare.stderr.split('\n').length, 2, 'one note line on stderr')

    const review = await runRoast(['review'], { cwd:dir.dir, env:dir.env })
    t.equal(review.code, 2, 'explicit review outside a repository exits 2')
    t.ok(review.error instanceof UsageError, 'a UsageError')
})

test('review in a repository without a config exits 2', async t => {
    const repo = tempRepo()
    t.cleanup(repo.remove)
    for (const args of [[], ['review']]) {
        const res = await runRoast(args, { cwd:repo.dir, env:repo.env })
        t.equal(res.code, 2, `"${args.join(' ')}" exits 2`)
    }
})

test('registered commands map errors to exit codes', async t => {
    const controller = new AbortController()
    t.cleanup(registerCommand({
        command:'cancel-me',
        describe:false,
        handler:(_args, ctx) => {
            controller.abort(new CancelledError())
            throw new Error('finder: request', {
                cause:ctx.signal.reason,
            })
        },
    }))
    t.cleanup(registerCommand({
        command:'gate-exit',
        describe:false,
        handler:() => { throw new ExitSignal(1) },
    }))
    t.cleanup(registerCommand({
        command:'aborting',
        describe:false,
        handler:async (_args, ctx) => {
            controller.abort(new CancelledError())
            await new Promise(resolve => setTimeout(resolve, 1))
            ctx.signal.throwIfAborted()
        },
    }))

    const cancelled = await runRoast(
        ['cancel-me', '--error-format', 'json'],
        { signal:controller.signal })
    t.equal(cancelled.code, 5, 'cancellation exits 5')
    t.equal(JSON.parse(cancelled.stderr).error_category, 'cancelled',
        'category cancelled')

    const exit1 = await runRoast(['gate-exit'])
    t.equal(exit1.code, 1, 'ExitSignal(1) exits 1')
    t.equal(exit1.stderr, '', 'nothing on stderr')
    const exit1json = await runRoast(['gate-exit', '--error-format=json'])
    t.equal(exit1json.stderr, '', 'nothing on stderr in JSON form')

    const aborting = await runRoast(['aborting'],
        { signal:controller.signal })
    t.equal(aborting.code, 5, 'an aborted signal exits 5')
})

test('group commands print help without a subcommand', async t => {
    let ran = ''
    t.cleanup(registerCommand({
        command:'grp',
        describe:'a group',
        subcommands:[{
            command:'leaf <name>',
            describe:'a leaf',
            handler:args => { ran = String(args.name) },
        }],
    }))
    const bare = await runRoast(['grp'])
    t.equal(bare.code, 0, 'the group alone exits 0')
    t.ok(bare.stdout.length > 0, 'its help on stdout')
    const leaf = await runRoast(['grp', 'leaf', 'x'])
    t.equal(leaf.code, 0, 'the leaf runs')
    t.equal(ran, 'x', 'with its positional')
    for (const args of [['grp', 'bogus'], ['grp', 'leaf'],
        ['grp', 'leaf', 'a', 'b']]) {
        const res = await runRoast(args)
        t.equal(res.code, 2, `${args.join(' ')} exits 2`)
    }
})
