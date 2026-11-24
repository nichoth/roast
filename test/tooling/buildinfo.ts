import { test } from '@substrate-system/tapzero'
import { buildInfo, formatBuildInfo } from '../../src/buildinfo.js'

test('formatBuildInfo uses the commit form for a dev version', t => {
    t.equal(formatBuildInfo({
        version:'dev',
        commit:'abc1234',
        date:'2026-12-01T10:00:00Z',
    }), 'dev (commit abc1234)')
})

test('formatBuildInfo uses the commit form for an unknown date', t => {
    t.equal(formatBuildInfo({
        version:'2.0.0',
        commit:'abc1234',
        date:'unknown',
    }), '2.0.0 (commit abc1234)')
})

test('formatBuildInfo gives commit and date for a release build', t => {
    t.equal(formatBuildInfo({
        version:'2.0.0',
        commit:'abc1234',
        date:'2026-12-01T10:00:00Z',
    }), '2.0.0 (abc1234, 2026-12-01T10:00:00Z)')
})

test('the test bundle has no build defines', t => {
    t.deepEqual(buildInfo, {
        version:'dev',
        commit:'unknown',
        date:'unknown',
    })
})
