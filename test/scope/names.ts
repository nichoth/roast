import { test } from '@substrate-system/tapzero'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from '../../src/scope/index.js'
import { compareBytes } from '../../src/gocompat/strings.js'
import { newRepo } from './helpers.js'

test('non-ASCII paths appear unquoted for tracked and untracked files',
    async t => {
        const repo = newRepo()
        const tracked = 'caf\u00e9/na\u00efve.go'
        const untracked = '\u65e5\u672c/\u{1f600}.txt'
        repo.write(tracked, 'package a\n')
        repo.commitAll()
        repo.write(tracked, 'package a\n// edit\n')
        repo.write(untracked, 'hello\n')
        const s = await build(repo.dir, { env:repo.env })
        t.deepEqual([...s.files], [tracked, untracked].sort(compareBytes),
            'both paths, unquoted')
        t.ok(s.diff.includes(`diff --git a/${tracked} b/${tracked}`),
            'tracked header unquoted')
        t.ok(s.diff.includes(`+++ b/${untracked}\n@@ -0,0 +1,1 @@\n+hello`),
            'untracked file synthesized')
        repo.cleanup()
    })

test('a file name that is not valid UTF-8 is skipped with a note',
    async t => {
        const repo = newRepo()
        const bad = Buffer.concat([Buffer.from(repo.dir + '/bad-'),
            Buffer.from([0xff, 0xfe]), Buffer.from('.txt')])
        try {
            fs.writeFileSync(bad, 'x\n')
        } catch {
            // Some file systems (APFS) refuse such names.
            t.ok(true, 'skipped: file system refuses non-UTF-8 names')
            repo.cleanup()
            return
        }
        repo.write('good.txt', 'ok\n')
        const s = await build(repo.dir, { env:repo.env })
        t.deepEqual([...s.files], ['good.txt'], 'only the valid name')
        t.ok(s.notes.some(n => n.includes('not valid UTF-8')),
            'warning note')
        t.ok(fs.existsSync(path.join(repo.dir, 'good.txt')), 'build ok')
        repo.cleanup()
    })

test('a staged name that is not valid UTF-8 is skipped with a note',
    async t => {
        const repo = newRepo()
        repo.write('good.txt', 'ok\n')
        repo.git('add', 'good.txt')
        const oid = repo.git('hash-object', '-w', 'good.txt').trim()
        // The index can hold a name no file system here could create.
        const entry = Buffer.concat([Buffer.from(`100644 ${oid}\tbad-`),
            Buffer.from([0xff, 0xfe]), Buffer.from('.txt\n')])
        execFileSync('git', ['-C', repo.dir, 'update-index', '--index-info'],
            { env:repo.env, input:entry })
        const s = await build(repo.dir, { stagedOnly:true, env:repo.env })
        t.deepEqual([...s.files], ['good.txt'], 'only the valid name')
        const warn = s.notes.filter(n => n.includes('not valid UTF-8'))
        t.equal(warn.length, 1, 'one warning note')
        t.equal(s.notes[s.notes.length - 1], warn[0], 'it is the last note')
        repo.cleanup()
    })
