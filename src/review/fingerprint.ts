// pattern: Functional Core
import { createHash } from 'node:crypto'
import { isGoSpace } from '../gocompat/strings.js'

export function collapseWhitespace (s:string):string {
    let out = ''
    let space = false
    for (const ch of s) {
        if (isGoSpace(ch.codePointAt(0)!)) {
            space = out.length > 0
        } else {
            if (space) out += ' '
            out += ch
            space = false
        }
    }
    return out
}

export function fingerprint (
    f:{ file:string, code_quote:string }
):string {
    return createHash('sha256')
        .update(f.file + '\u0000' + collapseWhitespace(f.code_quote))
        .digest('hex').slice(0, 16)
}
