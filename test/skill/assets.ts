import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { test } from '../helpers/test.js'
import { ROOT } from '../helpers/spawn.js'
import { SKILL_FILES } from '../../src/skill/assets.js'

const ASSET_DIR = join(ROOT, 'src', 'skill', 'assets', 'roast')

async function filesUnder (dir:string):Promise<string[]> {
    const entries = await readdir(dir, { recursive:true, withFileTypes:true })
    return entries
        .filter(e => e.isFile())
        .map(e => relative(dir, join(e.parentPath, e.name)))
        .sort()
}

test('each bundled skill file equals its bytes on disk', async t => {
    const onDiskNames = await filesUnder(ASSET_DIR)
    t.deepEqual([...SKILL_FILES.keys()].sort(), onDiskNames,
        'every file under the asset directory is bundled')
    for (const [rel, bytes] of SKILL_FILES) {
        const onDisk = await readFile(join(ASSET_DIR, rel))
        t.ok(Buffer.from(bytes).equals(onDisk), `${rel} matches the file`)
    }
})
