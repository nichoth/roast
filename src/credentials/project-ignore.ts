// pattern: Imperative Shell
import { git, GitError, type GitRunOpts } from '../git/git.js'
import { appendIgnoreEntries } from '../git/ignore.js'
import {
    PROJECT_CREDENTIALS_FILE as FILE,
    PROJECT_CREDENTIALS_TEMP_PREFIX as TEMP,
} from './dotenv.js'

export const PROJECT_IGNORE_ENTRY = `/${FILE}`
const TEMP_IGNORE_ENTRY = `/${TEMP}*`

export async function addProjectIgnoreEntries (root:string) {
    return appendIgnoreEntries(root, new Map([
        [PROJECT_IGNORE_ENTRY, new Set([PROJECT_IGNORE_ENTRY, FILE])],
        [TEMP_IGNORE_ENTRY, new Set([TEMP_IGNORE_ENTRY, `${TEMP}*`])],
    ]))
}

export async function assertProjectCredentialUntracked (
    root:string, opts:GitRunOpts
):Promise<void> {
    const tracked = await git(root, ['ls-files', '-z', '--', FILE], opts)
    if (tracked.length > 0) {
        throw new Error(`${FILE} is tracked by Git in ${root}`)
    }
}

async function ignored (
    root:string, name:string, opts:GitRunOpts
):Promise<boolean> {
    try {
        await git(root, ['check-ignore', '-q', '--', name], opts)
        return true
    } catch (err) {
        if (err instanceof GitError && err.exitCode === 1) return false
        throw err
    }
}

export async function protectProjectCredential (
    root:string, opts:GitRunOpts
):Promise<void> {
    await assertProjectCredentialUntracked(root, opts)
    const temp = TEMP + 'check'
    if (await ignored(root, FILE, opts) && await ignored(root, temp, opts)) {
        return
    }
    await addProjectIgnoreEntries(root)
    if (!await ignored(root, FILE, opts) ||
        !await ignored(root, temp, opts)) {
        throw new Error(`Git does not ignore ${FILE} and its temporary ` +
            `files in ${root}; check .gitignore for conflicting rules`)
    }
}
