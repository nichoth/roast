import { test } from '@substrate-system/tapzero'
import {
    checkNodeVersion,
    filterWarnings,
} from '../../src/startup.js'

test('the version check rejects Node below 22.18, naming the floor', t => {
    for (const version of ['22.17.1', '20.0.0', '21.99.0', '18.20.4']) {
        const err = checkNodeVersion(version)
        t.ok(err, `${version} is rejected`)
        t.ok(err?.message.includes('22.18'), 'the error names 22.18')
        t.ok(err?.message.includes(version),
            'the error names the running version')
    }
})

test('the version check passes Node 22.18 and later', t => {
    for (const version of ['22.18.0', '22.20.5', '23.0.0', '24.0.0']) {
        t.equal(checkNodeVersion(version), null, `${version} passes`)
    }
})

function warning (name:string, message:string):Error {
    const err = new Error(message)
    err.name = name
    return err
}

test('the warning filter drops the zstd ExperimentalWarning', t => {
    const seen:Error[] = []
    const listener = filterWarnings([w => { seen.push(w) }])
    listener(warning('ExperimentalWarning',
        'zstd is an experimental feature and might change at any time'))
    t.equal(seen.length, 0, 'the zstd warning is not passed on')
})

test('the warning filter passes every other warning through', t => {
    const seen:Error[] = []
    const other = [
        warning('ExperimentalWarning',
            'WASI is an experimental feature and might change at any time'),
        warning('DeprecationWarning', 'Buffer() is deprecated'),
        warning('Warning', 'something else'),
    ]
    const listener = filterWarnings([
        w => { seen.push(w) },
        w => { seen.push(w) },
    ])
    for (const w of other) listener(w)
    t.equal(seen.length, other.length * 2,
        'each warning reaches every original listener')
    t.deepEqual(seen.filter((_, i) => i % 2 === 0), other,
        'warnings arrive unchanged and in order')
})
