// Scope constants (spec 04, 2.1).

// Appended to the excludes unless --include-vendored. Order matters: it
// is the pathspec argument order.
export const DEFAULT_IGNORES:readonly string[] = Object.freeze([
    'vendor/**',
    'node_modules/**',
    '**/node_modules/**',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'go.sum',
    '*.pb.go',
    '*_pb2.py',
    '*_pb2_grpc.py',
    '*.min.js',
    '*.min.css',
])

// On every git invocation that produces a patch or a name list from
// `diff`, so diff drivers, external diff, color and prefix settings
// cannot change the text.
export const PATCH_FLAGS:readonly string[] = Object.freeze([
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
])

// Every diff-mode `git diff`: renames are recovered later only for pairs
// whose both sides survived the excludes.
export const DIFF_FLAGS:readonly string[] = Object.freeze([
    '--no-renames',
    ...PATCH_FLAGS,
])

// Placed before every `diff` subcommand: the user's diff.orderFile has no
// effect (git rejects an empty value, so /dev/null: an empty order), and
// non-ASCII paths stay unquoted in patch headers.
export const DIFF_CONFIG:readonly string[] = Object.freeze([
    '-c', 'diff.orderFile=/dev/null',
    '-c', 'core.quotePath=false',
])

export const BASE_CANDIDATES:readonly string[] = Object.freeze([
    'origin/main',
    'origin/master',
    'main',
    'master',
    'HEAD~1',
])

// Git's empty tree: lets a repository with no commits be diffed.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export const DEFAULT_MAX_FILE_DIFF_BYTES = 1_000_000

export const LINGUIST_ATTRS:readonly string[] = Object.freeze([
    'linguist-generated',
    'linguist-vendored',
])

// Ends a file section cut at the per-file ceiling. The leading `\` makes
// it diff metadata, so the grounder and the rename parser skip it.
export function SECTION_OMITTED_MARKER (n:number):string {
    return '\\ roast: the rest of this file\'s diff is omitted (over ' +
        `${n} bytes); use read_file to inspect the file\n`
}
