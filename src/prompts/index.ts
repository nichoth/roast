import { readFile } from 'node:fs/promises'
import core from './templates/finder_core.tmpl'
import prose from './templates/finder_prose.tmpl'
import diff from './templates/finder_scope_diff.tmpl'
import survey from
    './templates/finder_scope_survey.tmpl'
import mixed from
    './templates/finder_mixed_addendum.tmpl'
import go from './templates/finder_go_addendum.tmpl'
import frontend from
    './templates/finder_frontend_addendum.tmpl'
import hooks from
    './templates/finder_react_hooks_addendum.tmpl'
import quickAddendum from
    './templates/finder_quick_addendum.tmpl'
import singleCall from './templates/finder_single_call.tmpl'
import verifier from
    './templates/verifier_system.tmpl'

export async function finderSystem (
    mode:string,
    scope:string,
    quick:boolean,
    langs:ReadonlyArray<string>,
    overridePath:string,
    interactive:boolean
):Promise<string> {
    let base:string
    try {
        base = await loadOverride(
            overridePath, mode === 'prose' ? prose : core,
        )
    } catch (error) {
        const kind = mode === 'prose' ? 'prose' : 'core'
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`finder ${kind} prompt: ${message}`, { cause:error })
    }
    if (mode !== 'prose' || scope === 'repo') {
        base += scope === 'repo' ? survey : diff
    }
    if (mode === 'mixed') base += mixed
    if (mode !== 'prose') {
        if (langs.includes('go')) base += go
        if (langs.includes('react') || langs.includes('frontend')) {
            base += frontend
        }
        if (langs.includes('react')) base += hooks
    }
    if (!interactive) base += singleCall
    if (quick) base += quickAddendum
    return base
}

export async function verifierSystem (overridePath:string):Promise<string> {
    return loadOverride(overridePath, verifier)
}

async function loadOverride (path:string, fallback:string):Promise<string> {
    if (path === '') return fallback
    try {
        return await readFile(path, 'utf8')
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`prompt override ${path}: ${message}`, { cause:error })
    }
}
