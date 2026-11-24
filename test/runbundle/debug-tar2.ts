import { writeTar } from '../../src/runbundle/tar.js'

// Build the archive
const files = [{ name:'meta.json', data:Buffer.from('metadata\n') }]
const archive = writeTar(files)
console.log('archive length:', archive.length)

// Now manually do what readTar should do
const BLOCK_SIZE = 512
const data = archive
let offset = 0
let entryCount = 0

while (offset < data.length) {
    // Check zero block
    let zero = true
    for (let i = offset; i < offset + BLOCK_SIZE && i < data.length; i++) {
        if (data[i] !== 0) { zero = false; break }
    }
    if (zero) {
        console.log('  zero block at offset', offset,
            '- exit loop'); break
    }

    // Check checksum (spaces in chksum field at 148-155)
    let sum = 0
    for (let i = 0; i < 148; i++) sum += data[i]
    for (let i = 156; i < 512; i++) sum += data[i]
    console.log('offset', offset, 'checksum unsigned sum:', sum)

    // Read chksum field as octal
    let end = 156
    while (end > 148 && data[end - 1] === 0) end--
    let start = 148
    while (start < end && data[start] === 32) start++
    let chkStr = ''
    for (let i = start; i < end; i++) chkStr += String.fromCharCode(data[i])
    const chkNum = parseInt(chkStr, 8)
    console.log('  checksum field:', JSON.stringify(chkStr), '→', chkNum)
    console.log('  unsigned vs signed match:',
        Math.abs(sum) === Math.abs(sum - chkNum))

    // Read name
    let nEnd = 100
    while (nEnd > 0 && data[nEnd - 1] === 0) nEnd--
    let name = ''
    for (let i = 0; i < nEnd; i++) name += String.fromCharCode(data[i])
    console.log('  name:', JSON.stringify(name))

    // Read typeflag
    console.log('  typeflag:', JSON.stringify(String.fromCharCode(data[156])))

    // Read size
    end = 136
    while (end > 124 && data[end - 1] === 0) end--
    start = 124
    while (start < end && data[start] === 32) start++
    let szStr = ''
    for (let i = start; i < end; i++) szStr += String.fromCharCode(data[i])
    const sz = parseInt(szStr, 8)
    console.log('  size:', sz)

    // Compute what padToBlock would give
    const mod = sz % BLOCK_SIZE
    const padded = mod === 0 ? sz : sz + (BLOCK_SIZE - mod)
    const nextOffset = offset + BLOCK_SIZE + padded
    console.log('  dataStart + padToBlock(size):', offset + BLOCK_SIZE, '+',
        padded, '=', nextOffset)

    entryCount++
    console.log('  → Entry', entryCount, ':', JSON.stringify(name),
        'typeflag:', JSON.stringify(String.fromCharCode(data[156])), 'size:',
        sz)

    offset = nextOffset
    if (entryCount > 3) {
        console.log('breaking to avoid infinite loop')
        break
    }
}
console.log('total entries:', entryCount)
