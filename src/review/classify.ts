// Classification helpers for the finder prompt layer. Pure functions with no
// model calls and no prompt text.
import { goExt } from '../gocompat/strings.js'
import { UsageError } from '../cli/errors.js'

// Prose extensions compared after lower-casing. Unknown extensions count as
// code — the stricter default.
const PROSE:Set<string> = new Set([
    '.md', '.mdx', '.markdown', '.rst',
    '.txt', '.adoc', '.asciidoc', '.org', '.tex',
])

// Maps lower-cased extensions to language-family tags, used to select finder
// addenda. Extensions not in this table contribute nothing.
const LANG:Map<string, string> = new Map([
    ['.tsx', 'react'], ['.jsx', 'react'],
    ['.vue', 'frontend'], ['.svelte', 'frontend'], ['.astro', 'frontend'],
    ['.ts', 'web'], ['.js', 'web'], ['.mjs', 'web'], ['.cjs', 'web'],
    ['.css', 'web'], ['.scss', 'web'],
    ['.go', 'go'],
])

// Accepted language packs (case-sensitive). resolveLangs validates against this set.
const KNOWN_PACKS:Set<string> = new Set(['go', 'react', 'frontend', 'web'])

/** Classify mode: `code` for empty or all-code files, `prose` when every
  file has a prose extension, `mixed` when some are and others aren't. */
export function classifyMode (files:string[]):'code'|'prose'|'mixed' {
    if (files.length === 0) return 'code'
    let prose = 0
    for (const f of files) {
        const ext = goExt(f).toLowerCase()
        if (PROSE.has(ext)) prose++
    }
    if (prose === 0) return 'code'
    if (prose === files.length) return 'prose'
    return 'mixed'
}

/** Map each file's lower-cased extension through the language table, dedupe,
  and sort ascending. Unmapped extensions contribute nothing; empty input
  yields `[]`. */
export function classifyLangs (files:string[]):string[] {
    const seen = new Set<string>()
    for (const f of files) {
        const ext = goExt(f).toLowerCase()
        const tag = LANG.get(ext)
        if (tag !== undefined) seen.add(tag)
    }
    return Array.from(seen).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
}

/** Resolve language packs from the `--lang` flag values. When mode is prose
  the flag values are silently ignored and `[]` is returned. Without flag
  values the function auto-classifies by scanning file extensions. For any
  non-empty flag list, `none` alone yields `[]`, `none` combined with another
  pack or an unknown pack (case-sensitive, untrimmed) throws a `UsageError`;
  otherwise the function returns the flag values as given, preserving order
  and duplicates. */
export function resolveLangs (
    values:string[],
    files:string[],
    mode:string,
):string[] {
    if (mode === 'prose') return []

    // No flag values -> auto-classify from file extensions.
    if (values.length === 0) return classifyLangs(files)

    // Validate each value before proceeding.
    for (const v of values) {
        if (v === 'none') {
            if (values.length !== 1) {
                throw new UsageError(
                    '--lang none cannot be combined with another language pack',
                )
            }
            return []
        }
        if (!KNOWN_PACKS.has(v)) {
            throw new UsageError('unknown language pack "' + v + '"')
        }
    }

    // All values are valid -> return as given (order and duplicates kept).
    return [...values]
}
