import { PassThrough } from 'node:stream'
import { test } from '@substrate-system/tapzero'
import {
    LineReader,
    promptYesDefault,
    readSecret,
    interactiveTerminals,
} from '../../src/cli/terminal.js'
import { CancelledError, exitCode } from '../../src/cli/errors.js'
import { BufferStream, inputStream } from '../helpers/streams.js'

// A stdin that looks like a TTY: isTTY plus setRawMode recording calls.
function fakeTTY ():PassThrough&{ rawCalls:boolean[] } {
    const s = new PassThrough() as PassThrough&{
        isTTY:boolean;
        rawCalls:boolean[];
        setRawMode (on:boolean):void;
    }
    s.isTTY = true
    s.rawCalls = []
    s.setRawMode = (on:boolean) => { s.rawCalls.push(on) }
    return s
}

test('promptYesDefault answers', async t => {
    const cases:[string, boolean][] = [
        ['\n', true],
        ['y\n', true],
        ['Y\n', true],
        ['yes\n', true],
        ['  YES  \n', true],
        ['n\n', false],
        ['no\n', false],
        ['sure\n', false],
        ['', false],
    ]
    for (const [input, want] of cases) {
        const out = new BufferStream()
        const lines = new LineReader(inputStream(input))
        const got = await promptYesDefault(out, lines, 'Continue?')
        t.equal(got, want, JSON.stringify(input))
        t.ok(out.text().length > 0, 'the question is written')
    }
})

test('consecutive prompts share one LineReader', async t => {
    const out = new BufferStream()
    const stdin = inputStream('a\nb\n')
    const lines = new LineReader(stdin)
    t.equal(await readSecret(out, stdin, lines, 'key: '), 'a', 'first')
    t.equal(await readSecret(out, stdin, lines, 'key: '), 'b', 'second')
    let err:unknown
    try {
        await readSecret(out, stdin, lines, 'key: ')
    } catch (e) {
        err = e
    }
    t.ok(err instanceof Error, 'EOF with no text is an error')
})

test('promptYesDefault then readSecret on one reader', async t => {
    const out = new BufferStream()
    const stdin = inputStream('y\nsk-test\n')
    const lines = new LineReader(stdin)
    t.equal(await promptYesDefault(out, lines, 'Log in?'), true, 'yes')
    t.equal(await readSecret(out, stdin, lines, 'key: '), 'sk-test',
        'the buffered second answer survives')
})

test('readSecret on a TTY reads raw without echo', async t => {
    const stdin = fakeTTY()
    const out = new BufferStream()
    const lines = new LineReader(stdin)
    const p = readSecret(out, stdin, lines, 'key: ')
    stdin.write(' sk-se')
    stdin.write('cret\x7fT \r')
    t.equal(await p, 'sk-secreT', 'backspace edits, result trimmed')
    t.deepEqual(stdin.rawCalls, [true, false], 'raw mode on, then off')
    t.ok(!out.text().includes('sk-'), 'the secret is not echoed')
})

test('readSecret on a TTY treats Ctrl-C as cancellation', async t => {
    const stdin = fakeTTY()
    const out = new BufferStream()
    const lines = new LineReader(stdin)
    const p = readSecret(out, stdin, lines, 'key: ')
    stdin.write('sk\x03')
    let err:unknown
    try {
        await p
    } catch (e) {
        err = e
    }
    t.ok(err instanceof CancelledError, 'a CancelledError')
    t.equal(exitCode(err), 5, 'exits 5')
    t.deepEqual(stdin.rawCalls, [true, false], 'raw mode restored')
})

test('default interactiveTerminals rejects non-file streams', t => {
    const tty = fakeTTY()
    t.equal(interactiveTerminals(inputStream(), new BufferStream()), false,
        'buffers are not terminals')
    t.equal(interactiveTerminals(tty, new BufferStream()), false,
        'an isTTY flag without a file descriptor is not a terminal')
})
