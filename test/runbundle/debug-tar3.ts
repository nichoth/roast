import { writeTar, readTar } from '../../src/runbundle/tar.js'

const files = [{ name:'meta.json', data:Buffer.from('metadata\n') }]
const archive = writeTar(files)
console.log('Archive length:', archive.length)
const entries = readTar(archive)
console.log('---')
console.log('entries returned:', entries.length)
for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    console.log('  [' + i + '] name:', JSON.stringify(e.name), 'typeflag:',
        JSON.stringify(e.typeflag), 'size:', e.size)
}
