import { tempRepo, type TempDir } from '../helpers/repo.js'
import type { CleanupTest } from '../helpers/test.js'

export function recordRepo (t:CleanupTest):TempDir {
    const repo = tempRepo()
    const cwd = process.cwd()
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR']
    const previous = keys.map(key => process.env[key])
    for (const key of keys) process.env[key] = repo.env[key]
    process.chdir(repo.dir)
    t.cleanup(() => {
        process.chdir(cwd)
        keys.forEach((key, i) => {
            if (previous[i] === undefined) delete process.env[key]
            else process.env[key] = previous[i]
        })
        repo.remove()
    })
    return repo
}
