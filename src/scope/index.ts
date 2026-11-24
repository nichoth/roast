// The review scope area's public surface.
export {
    build,
    fit,
    isEmpty,
    type BuildOpts,
    type Scope,
    type ScopeKind,
    type SizeEntry,
} from './build.js'
export {
    DEFAULT_IGNORES,
    DIFF_CONFIG,
    DIFF_FLAGS,
    PATCH_FLAGS,
    SECTION_OMITTED_MARKER,
} from './constants.js'
export { gitPatch, GitError } from './git.js'
export { SectionCapper } from './patch.js'
export { gitRoot } from '../git/git.js'
