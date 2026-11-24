import { test } from '@substrate-system/tapzero'
import {
    ExitCode,
    UsageError,
    CancelledError,
    ExitSignal,
    errorChainHas,
    isCancellation,
    exitCode,
    errorCategoryFor,
    writeError,
} from '../../src/cli/errors.js'
import {
    AuthError,
    EndpointError,
    BudgetExhaustedError,
    WorkDeadlineError,
    NoFinalCallError,
} from '../../src/llm/errors.js'
import { BufferStream } from '../helpers/streams.js'

function wrap (inner:Error, ...prefixes:string[]):Error {
    let err = inner
    for (const p of prefixes) {
        err = new Error(`${p}: ${err.message}`, { cause:err })
    }
    return err
}

test('exit code constants match the contract', t => {
    t.deepEqual({ ...ExitCode }, {
        Clean:0, Findings:1, Usage:2, Auth:3, Partial:4, Cancelled:5,
    }, 'codes 0 to 5')
})

test('exitCode walks the cause chain', t => {
    t.equal(exitCode(undefined), 0, 'no error is 0')
    t.equal(exitCode(wrap(new CancelledError(), 'a', 'b')), 5,
        'wrapped cancellation')
    t.equal(exitCode(wrap(new AuthError('401'), 'finder')), 3,
        'wrapped auth')
    t.equal(exitCode(wrap(new UsageError('bad flag'), 'x')), 2,
        'wrapped usage')
    t.equal(exitCode(new Error('boom')), 4, 'anything else')
    t.equal(exitCode(wrap(new AuthError('401'), 'x'), undefined), 3,
        'no signal given')
    const both = new UsageError('u', { cause:new CancelledError() })
    t.equal(exitCode(both), 5, 'cancellation outranks usage')
    const authUsage = new UsageError('u', { cause:new AuthError('a') })
    t.equal(exitCode(authUsage), 3, 'auth outranks usage')
})

test('errorChainHas is cycle safe', t => {
    const a = new Error('a')
    const b = new Error('b', { cause:a })
    ;(a as { cause?:unknown }).cause = b
    t.equal(errorChainHas(b, e => e instanceof UsageError), false,
        'terminates on a cycle')
    t.equal(errorChainHas('not an error', () => true), false,
        'a non-error is not walked')
})

test('isCancellation: abort errors only while the signal is cancelled',
    t => {
        const abortErr = new DOMException('aborted', 'AbortError')
        const c = new AbortController()
        t.equal(isCancellation(abortErr, c.signal), false,
            'not aborted yet')
        c.abort(new CancelledError())
        t.equal(isCancellation(wrap(abortErr, 'fetch'), c.signal), true,
            'AbortError while cancelled')
        const timeout = new DOMException('timed out', 'TimeoutError')
        t.equal(isCancellation(timeout, c.signal), false,
            'a TimeoutError is never cancellation')
        t.equal(exitCode(wrap(timeout, 'request')), 4,
            'a timeout exits 4')
        const other = new AbortController()
        other.abort(new Error('not ours'))
        t.equal(isCancellation(abortErr, other.signal), false,
            'an abort with another reason is not cancellation')
    })

test('errorCategoryFor maps codes and wrapped errors', t => {
    const cases:[number, unknown, string][] = [
        [0, undefined, 'none'],
        [1, new ExitSignal(1), 'findings'],
        [2, wrap(new UsageError('u'), 'x'), 'usage'],
        [2, new Error('flag parse'), 'usage'],
        [3, wrap(new AuthError('401'), 'x'), 'auth'],
        [4, wrap(new EndpointError('502'), 'x'), 'endpoint'],
        [4, wrap(new BudgetExhaustedError('b'), 'x'), 'resource_limit'],
        [4, wrap(new WorkDeadlineError('d'), 'x'), 'resource_limit'],
        [4, wrap(new NoFinalCallError('n'), 'x'), 'resource_limit'],
        [5, wrap(new CancelledError(), 'x'), 'cancelled'],
        [5, new Error('plain'), 'cancelled'],
        [4, new Error('git failed'), 'partial'],
        [4, new ExitSignal(4), 'partial'],
    ]
    for (const [code, err, want] of cases) {
        t.equal(errorCategoryFor(code, err), want,
            `${code} ${err instanceof Error ? err.name : ''}`)
    }
})

test('writeError text form escapes control bytes', t => {
    const out = new BufferStream()
    writeError(out, 4, new Error('a\x1b[2J.go'), 'text')
    const s = out.text()
    t.ok(!s.includes('\x1b'), 'no ESC byte reaches stderr')
    t.ok(s.endsWith('\n'), 'one line')
    t.equal(s.split('\n').length, 2, 'exactly one line')
})

test('writeError JSON form', t => {
    const out = new BufferStream()
    const msg = 'bad <tag> & "quote"\u2028'
    writeError(out, 2, new UsageError(msg), 'json')
    const s = out.text()
    t.ok(s.endsWith('\n'), 'newline terminated')
    const parsed = JSON.parse(s)
    t.deepEqual(Object.keys(parsed),
        ['error_category', 'message', 'exit_code'], 'keys in order')
    t.equal(parsed.error_category, 'usage', 'category')
    t.equal(parsed.exit_code, 2, 'exit code')
    t.equal(parsed.message, msg, 'message round-trips unchanged')
    t.ok(!s.includes('\\u003c'), 'no HTML escaping')
})
