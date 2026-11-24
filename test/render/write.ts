import { Writable } from 'node:stream'
import { test } from '../helpers/test.js'
import { toJSON, toMarkdown, writeReport } from '../../src/render/render.js'
import { report } from './fixtures.js'

test('report writer sends formats to their streams in JSON-first order', t => {
    const r = report()
    for (const format of ['json', 'markdown', 'both'] as const) {
        const calls:{ stream:string; text:string }[] = []
        function stream (name:string):Writable {
            return new Writable({
                write (chunk, _encoding, done) {
                    calls.push({ stream:name, text:chunk.toString() })
                    done()
                },
            })
        }
        writeReport({ stdout:stream('out'), stderr:stream('err') },
            format, false, r)
        const expected = []
        if (format !== 'markdown') {
            expected.push({ stream:'out', text:toJSON(r) + '\n' })
        }
        if (format !== 'json') {
            expected.push({ stream:'err', text:toMarkdown(r, false) + '\n' })
        }
        t.deepEqual(calls, expected)
        t.ok(calls.every(c => c.text.endsWith('\n')))
    }
})
