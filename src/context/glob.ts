// list_files glob matching (spec 05, 2.9 `globstarMatch`).
import { goPathMatch } from '../gocompat/match.js'

// Whether `value` matches `pattern`, both split on `/`. A `**` segment
// matches zero or more segments; any other segment matches exactly one
// by Go path.Match rules. A malformed segment never matches.
export function globstarMatch (pattern:string, value:string):boolean {
    const p = pattern.split('/')
    const v = value.split('/')
    // ok[j]: p[0..i) matches v[0..j).
    let ok:boolean[] = new Array<boolean>(v.length + 1).fill(false)
    ok[0] = true
    for (const seg of p) {
        const next = new Array<boolean>(v.length + 1).fill(false)
        if (seg === '**') {
            let any = false
            for (let j = 0; j <= v.length; j++) {
                any = any || ok[j]
                next[j] = any
            }
        } else {
            for (let j = 1; j <= v.length; j++) {
                next[j] = ok[j - 1] && goPathMatch(seg, v[j - 1])
            }
        }
        ok = next
    }
    return ok[v.length]
}
