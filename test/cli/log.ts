import { test } from '../helpers/test.js'
import { logf } from '../../src/cli/log.js'
import {
    interactiveTerminals,
    openBrowser,
    terminalHooks,
} from '../../src/cli/terminal.js'
import { BufferStream, inputStream } from '../helpers/streams.js'
import { captureBrowser, simulateTerminals } from '../helpers/terminal.js'

test('logf writes one prefixed, sanitized line', t => {
    const out = new BufferStream()
    logf(out, 'scope a\x1b[2J.go')
    const s = out.text()
    t.ok(s.startsWith('roast: '), 'prefixed')
    t.ok(s.endsWith('\n'), 'newline terminated')
    t.ok(!s.includes('\x1b'), 'no ESC byte')
})

test('simulateTerminals and captureBrowser swap and restore', async t => {
    const realTerminals = terminalHooks.interactiveTerminals
    const realBrowser = terminalHooks.openBrowser
    // A stand-in test whose cleanups run before the checks below.
    const cleanups:(() => void)[] = []
    const inner = { cleanup:(f:() => void) => { cleanups.push(f) } }
    simulateTerminals(inner, true)
    const opened = captureBrowser(inner)
    t.equal(interactiveTerminals(inputStream(), new BufferStream()), true,
        'terminals simulated')
    t.equal(await openBrowser('https://example.test/a'), undefined,
        'the capture reports no error')
    t.deepEqual(opened, ['https://example.test/a'], 'the URL is captured')
    for (const f of cleanups.reverse()) f()
    t.equal(terminalHooks.interactiveTerminals, realTerminals,
        'terminal detection restored')
    t.equal(terminalHooks.openBrowser, realBrowser, 'opener restored')
})
