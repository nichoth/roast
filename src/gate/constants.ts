// Gate constants (spec 12, 2.1). HOOK_SCRIPT is the byte-exact
// pre-commit.sh the Go releases installed, so those hooks compare equal
// and are not reported stale.
import hookScript from './pre-commit.sh'

export const HOOK_SCRIPT:string = hookScript

export const HOOK_NAME = 'pre-commit'
export const SIDECAR_NAME = 'roast-pre-commit'
export const HOOK_MARKER = '# roast-gate-hook: v1'
export const HOOK_HEADER = `#!/bin/sh\n${HOOK_MARKER}\n`
export const APPEND_BEGIN =
    '# >>> roast pre-commit gate (managed by `roast gate`) >>>'
export const APPEND_END = '# <<< roast pre-commit gate <<<'

export const CONFIG_KEY_DECISION = 'roast.gate'
export const CONFIG_KEY_NOTICE = 'roast.gate-notice'

// The one line that runs the sidecar: the body of the appended block, and
// what a user adds by hand to a hook Roast will not edit. It resolves the
// sidecar through git, so it survives repo moves and core.hooksPath.
export function manualLine ():string {
    return `"$(git rev-parse --git-path hooks/${SIDECAR_NAME})" || exit $?`
}
