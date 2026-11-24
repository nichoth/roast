import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from '@substrate-system/tapzero'
import {
    createSignalHandler,
    createStdoutErrorHandler,
} from '../../src/cli/process.js'
import { CancelledError } from '../../src/cli/errors.js'
import { ROOT } from '../helpers/spawn.js'

test('first signal aborts, second exits 130', t => {
    const controller = new AbortController()
    const exits:number[] = []
    const onSignal = createSignalHandler(controller, code => {
        exits.push(code)
    })
    onSignal()
    t.ok(controller.signal.aborted, 'the first signal aborts')
    t.ok(controller.signal.reason instanceof CancelledError,
        'with a CancelledError')
    t.deepEqual(exits, [], 'without exiting')
    onSignal()
    t.deepEqual(exits, [130], 'the second exits 130')
})

test('EPIPE on stdout exits with the computed code', t => {
    const exits:number[] = []
    const run:{ code?:number } = {}
    const onError = createStdoutErrorHandler(() => run.code, c => {
        exits.push(c)
    })
    const epipe = Object.assign(new Error('write EPIPE'), { code:'EPIPE' })
    onError(epipe)
    t.deepEqual(exits, [], 'still running: no exit yet')
    run.code = 3
    onError(epipe)
    t.deepEqual(exits, [3], 'after the run: exits with its code')
    let thrown:unknown
    try {
        onError(new Error('other'))
    } catch (e) {
        thrown = e
    }
    t.ok(thrown instanceof Error, 'other errors are not swallowed')
})

test('the built CLI exits quietly when stdout is closed', async t => {
    const child = spawn(process.execPath, [join(ROOT, 'dist', 'cli.js'),
        '--help'], { stdio:['ignore', 'pipe', 'pipe'] })
    child.stdout.destroy()
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', c => { stderr += c })
    const code = await new Promise(resolve => child.on('close', resolve))
    t.equal(code, 0, 'exits with the computed code')
    t.equal(stderr, '', 'no stack trace')
})
