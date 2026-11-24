// The bootstrap module seam (spec 12, 2.11), for what the CLI cannot
// observe through git config alone.
import { test } from '../helpers/test.js'
import { bootstrap } from '../../src/gate/bootstrap.js'
import { gateRepo, localConfig } from './helpers.js'

test('a non-interactive hint is printed once per repository', async t => {
    const r = gateRepo(t)
    const lines:string[] = []
    const opts = {
        repo:r.dir,
        env:r.env,
        noOffer:false,
        out:(line:string) => { lines.push(line) },
    }
    t.equal(await bootstrap(opts), 'hinted', 'first run hints')
    t.equal(lines.length, 1, 'one message')
    t.equal(localConfig(r, 'roast.gate-notice'), 'sent', 'notice recorded')
    t.equal(await bootstrap(opts), 'quiet', 'second run is quiet')
    t.equal(lines.length, 1, 'nothing more printed')
})
