import { test } from '../helpers/test.js'
import { newRunId } from '../../src/record/run-id.js'

test('run IDs have UTC time and fresh random suffixes', t => {
    const id = newRunId()
    t.equal(id.length, 25)
    t.equal(id[16], '-')
    t.ok(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(id))
    t.ok(id !== newRunId())
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    t.equal(id.slice(0, 8), today)
})
