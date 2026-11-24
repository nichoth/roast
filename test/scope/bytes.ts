import { test } from '@substrate-system/tapzero'
import { execFileSync } from 'node:child_process'
import { build } from '../../src/scope/index.js'
import { newRepo } from './helpers.js'

test('diffBytes are the bytes git emitted; diff decodes with U+FFFD',
    async t => {
        const repo = newRepo()
        const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) // caf\xe9
        repo.write('a.txt', 'plain\n')
        repo.commitAll()
        repo.write('a.txt', Buffer.concat([Buffer.from('plain\n'), latin1]))
        repo.git('add', '.')
        const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
        // What git itself prints for the same comparison.
        const raw = execFileSync('git', ['-C', repo.dir, '-c',
            'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff',
            '--no-textconv', '--no-color', '--src-prefix=a/',
            '--dst-prefix=b/', '--cached', 'HEAD'], { env:repo.env })
        t.ok(s.diffBytes.equals(raw), 'byte-exact')
        t.ok(s.diffBytes.includes(latin1), 'invalid UTF-8 byte kept')
        t.ok(s.diff.includes('+caf\ufffd\n'), 'diff has U+FFFD')
        t.equal(s.diff, s.diffBytes.toString('utf8'), 'diff decodes bytes')
        repo.cleanup()
    })

test('files sort by code point, not UTF-16 unit', async t => {
    const repo = newRepo()
    const astral = '\u{1f600}.txt'
    const bmp = '\ufffd.txt'
    repo.write(astral, 'a\n')
    repo.write(bmp, 'b\n')
    const s = await build(repo.dir, { env:repo.env })
    // UTF-16 order would put the surrogate pair (0xd83d) first.
    t.deepEqual([...s.files], [bmp, astral], 'astral after U+FFFD')
    repo.cleanup()
})
