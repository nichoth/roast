// linguist-generated / linguist-vendored exclusion (spec 04, 2.7). Every
// failure means "no excludes": the review proceeds unfiltered, never
// narrower. An abort always rejects.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DIFF_FLAGS, LINGUIST_ATTRS } from './constants.js'
import { diffArgs, git, type GitRunOpts } from './git.js'
import { compareBytes, decodeName, decodePaths, splitNul } from './text.js'

// The tracked paths (plus, in staged mode, the staged diff's paths) that
// in-tree attributes mark generated or vendored, sorted. `cached` reads
// attributes from the index, pinned to `treeOID` when set.
export async function linguistIgnores (
    repo:string,
    cached:boolean,
    treeOID:string,
    opts:GitRunOpts = {}
):Promise<string[]> {
    let dir:string|undefined
    try {
        const extraEnv:Record<string, string> = {}
        if (cached && treeOID) {
            dir = await fs.mkdtemp(path.join(os.tmpdir(),
                'roast-scope-idx-'))
            extraEnv.GIT_INDEX_FILE = path.join(dir, 'index')
            // No fallback to the live index: a wrong exclusion set would
            // silently change what is reviewed.
            await git(repo, ['read-tree', treeOID], { ...opts, extraEnv })
        }
        const runOpts = { ...opts, extraEnv }
        const listed = await git(repo, ['ls-files', '-z'], runOpts)
        const paths = decodePaths(listed).paths
        if (cached) {
            // With renames off, a staged rename lists both paths, so a
            // deleted or moved-away marked file is still excluded.
            try {
                const changed = await git(repo, diffArgs(...DIFF_FLAGS,
                    '--cached', '--name-only', '-z'), runOpts)
                paths.push(...decodePaths(changed).paths)
            } catch (err) {
                if (opts.signal?.aborted) throw err
            }
        }
        if (paths.length === 0) return []
        const marked = await linguistMarked(repo, paths, cached, runOpts)
        return marked.sort(compareBytes)
    } catch (err) {
        if (opts.signal?.aborted) throw err
        return []
    } finally {
        if (dir) await fs.rm(dir, { recursive:true, force:true })
    }
}

// The paths (first-occurrence order) whose linguist attributes are set.
// Only repository attributes count: the global attributes file and the
// system one are disabled. `opts.extraEnv` (a pinned index) wins.
export async function linguistMarked (
    repo:string,
    paths:readonly string[],
    cached:boolean,
    opts:GitRunOpts = {}
):Promise<string[]> {
    if (paths.length === 0) return []
    const args = ['-c', 'core.attributesFile=/dev/null', 'check-attr',
        '--stdin', '-z']
    if (cached) args.push('--cached')
    args.push(...LINGUIST_ATTRS)
    let out:Buffer
    try {
        out = await git(repo, args, {
            ...opts,
            extraEnv:{ GIT_ATTR_NOSYSTEM:'1', ...opts.extraEnv },
            input:paths.join('\0') + '\0',
        })
    } catch (err) {
        if (opts.signal?.aborted) throw err
        return []
    }
    // (path, attr, value) triples; a short trailing group is ignored.
    const fields = splitNul(out)
    const seen = new Set<string>()
    const marked:string[] = []
    for (let i = 0; i + 2 < fields.length; i += 3) {
        const p = decodeName(fields[i])
        const value = fields[i + 2].toString('utf8')
        if (p === null || (value !== 'set' && value !== 'true')) continue
        if (seen.has(p)) continue
        seen.add(p)
        marked.push(p)
    }
    return marked
}
