// In-process glob matching for untracked files and the repo-scope listing
// (spec 04, 2.14). Git's pathspec engine handles tracked diffs.

const ESCAPED = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '[', ']',
    '|', '\\'])

// Any character but a newline (Go RE2 `.`).
const ANY = '[^\\n]'

// An anchored full-match regex. `**` and `*` both cross `/` (Python
// fnmatch semantics); a `/` right after `**` is optional. `[...]` classes
// are not supported: brackets are literal.
export function globToRegExp (pattern:string):RegExp {
    let src = '^'
    const chars = [...pattern]
    let i = 0
    while (i < chars.length) {
        const ch = chars[i]
        if (ch === '*') {
            src += ANY + '*'
            i++
            if (chars[i] === '*') {
                i++
                if (chars[i] === '/') {
                    src += '/?'
                    i++
                }
            }
        } else if (ch === '?') {
            src += ANY
            i++
        } else if (ESCAPED.has(ch)) {
            src += '\\' + ch
            i++
        } else {
            src += ch
            i++
        }
    }
    return new RegExp(src + '$', 'u')
}

function matchGlob (path:string, pattern:string):boolean {
    try {
        return globToRegExp(pattern).test(path)
    } catch {
        return false
    }
}

// Matches `pattern`, then the pattern with every `**` read as `*`.
export function globMatch (path:string, pattern:string):boolean {
    if (matchGlob(path, pattern)) return true
    const alt = pattern.replaceAll('**', '*')
    return alt !== pattern && matchGlob(path, alt)
}

// Whether a path survives the excludes and is selected by `paths` (all
// paths when empty). A glob-free path pattern also selects its subtree,
// as a git pathspec does.
export function untrackedPasses (
    path:string,
    paths:readonly string[],
    excludes:readonly string[]
):boolean {
    if (excludes.some(pat => globMatch(path, pat))) return false
    if (paths.length === 0) return true
    for (const pat of paths) {
        if (globMatch(path, pat)) return true
        const dir = pat.endsWith('/') ? pat.slice(0, -1) : pat
        if (dir !== '' && !/[*?[]/.test(pat) &&
            path.startsWith(dir + '/')) {
            return true
        }
    }
    return false
}
