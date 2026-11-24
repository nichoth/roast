// scripts/schema.ts writes roast.schema.json in its working directory,
// and only when the generated content differs (spec 15, 2.7).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '../helpers/test.js'
import { ROOT, run } from '../helpers/spawn.js'
import { renderProjectSchema } from '../../src/config/json-schema.js'

const SCRIPT = path.join(ROOT, 'scripts', 'schema.ts')

test('scripts/schema.ts rewrites roast.schema.json only on change', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-schema-'))
    t.cleanup(() => fs.rmSync(dir, { recursive:true, force:true }))
    const file = path.join(dir, 'roast.schema.json')

    const first = await run(process.execPath, [SCRIPT], { cwd:dir })
    t.equal(first.code, 0, `first run exits 0 ${first.stderr}`)
    t.equal(fs.readFileSync(file, 'utf8'), renderProjectSchema(),
        'a missing file is written')

    // Mark the file so a rewrite is observable.
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(file, past, past)
    const before = fs.statSync(file).mtimeMs
    const second = await run(process.execPath, [SCRIPT], { cwd:dir })
    t.equal(second.code, 0, 'second run exits 0')
    t.equal(fs.statSync(file).mtimeMs, before,
        'an up-to-date file is not rewritten')

    fs.writeFileSync(file, '{}\n')
    const third = await run(process.execPath, [SCRIPT], { cwd:dir })
    t.equal(third.code, 0, 'third run exits 0')
    t.equal(fs.readFileSync(file, 'utf8'), renderProjectSchema(),
        'a stale file is rewritten')
})
