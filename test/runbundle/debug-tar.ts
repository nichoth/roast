import { writeTar, readTar } from '../../src/runbundle/tar.js'

const files = [{ name:'meta.json', data:Buffer.from('metadata\n') }]
const archive = writeTar(files)
console.log('archive length:', archive.length)

function isZero (buf:Buffer, off:number):boolean {
    for (let i = off; i < off + 512 && i < buf.length; i++) {
        if (buf[i] !== 0) return false
    }
    return true
}
console.log('zero block at 0:', isZero(archive, 0))
console.log('zero block at 512:', isZero(archive, 512))
console.log('zero block at 1024:', isZero(archive, 1024))

const _BLOCK_SIZE = 512
const data = archive

let end = 136
while (end > 124 && data[end - 1] === 0) end--
let start = 124
while (start < end && data[start] === 32) start++
let szStr = ''
for (let i = start; i < end; i++) szStr += String.fromCharCode(data[i])
console.log('size field bytes:', Array.from(data.slice(124, 136)))
console.log('size string:', JSON.stringify(szStr))
console.log('size as number:', parseInt(szStr, 8))

const entries = readTar(archive)
console.log('entries returned:', entries.length)
for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    console.log('  [' + i + '] name:', JSON.stringify(e.name), 'typeflag:',
        JSON.stringify(e.typeflag), 'size:', e.size)
}
