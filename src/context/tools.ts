// The exploration tools handed to the agent loop (spec 05, 2.7): read_file,
// list_files, grep_repo, each serving the one reviewed tree. Every result
// is a plain object; the llm area's encoder owns key order and JSON text.
import type { Tool } from '../llm/types.js'
import type { ContextOpts } from './git.js'
import { grepRepo } from './grep.js'
import { listFiles } from './list-files.js'
import { readFile } from './read-file.js'
import { pinned, staged, type Tree } from './tree.js'

const EM = '\u2014'

interface Corpus {
    read:string;
    grep:string;
    list:string;
}

const CORPUS:Record<'live'|'staged'|'worktree', Corpus> = {
    live:{
        read:'Reads the working tree of this checkout (tracked plus ' +
            'untracked, non-ignored files; never .git).',
        grep:'Search the working tree of this checkout (tracked plus ' +
            'untracked, non-ignored files) for a pattern.',
        list:'Lists tracked plus untracked, non-ignored files in the ' +
            'working tree of this checkout.',
    },
    staged:{
        read:'This review covers STAGED content, so this reads the git ' +
            `index blob ${EM} exactly what the commit would contain ` +
            `${EM} NOT the working tree: unstaged edits and untracked ` +
            'files are invisible here, and a path staged for deletion ' +
            'reads as absent from the index.',
        grep:'Search the git INDEX of this checkout for a pattern ' +
            `${EM} exactly the content the review covers. Unstaged ` +
            'edits and untracked files are NOT searched.',
        list:'Lists regular files in the captured git INDEX, not the ' +
            'live working tree.',
    },
    worktree:{
        read:'Reads the immutable captured worktree used by this run, ' +
            'not later checkout edits.',
        grep:'Search the immutable captured worktree used by this run, ' +
            'including captured non-ignored untracked files.',
        list:'Lists regular files in the immutable captured worktree ' +
            'used by this run.',
    },
}

function corpus (tree:Tree):Corpus {
    if (!pinned(tree)) return CORPUS.live
    return staged(tree) ? CORPUS.staged : CORPUS.worktree
}

// `opts.env` is the environment git runs with (the CLI context's env);
// each call's signal comes from the agent loop.
export function explorationTools (
    repo:string,
    tree:Tree,
    opts:Omit<ContextOpts, 'signal'> = {}
):Tool[] {
    const c = corpus(tree)
    return [
        {
            name:'read_file',
            description:'Read a file from the repository under review. ' +
                c.read + ' Use when a finding depends on code you ' +
                `haven't seen ${EM} a helper, a type definition, a ` +
                'config, a test. For large files request a window via ' +
                'offset/limit.',
            schema:{
                type:'object',
                properties:{
                    path:{ type:'string', description:'Repo-relative path.' },
                    offset:{
                        type:'integer',
                        description:'1-indexed starting line.',
                    },
                    limit:{
                        type:'integer',
                        description:'Max lines to return (default 500, ' +
                            'at most 2000; output is capped at 65536 ' +
                            'bytes).',
                    },
                },
                required:['path'],
            },
            run:(args, signal) => readFile(repo, tree, args, signal, opts),
        },
        {
            name:'list_files',
            description:'List files under a repo directory, optionally ' +
                'filtered by glob (e.g. \'*.go\', \'**/*_test.go\'). ' +
                'Returns relative paths. ' + c.list,
            schema:{
                type:'object',
                properties:{
                    directory:{
                        type:'string',
                        description:'Repo-relative directory (default: ' +
                            'root).',
                    },
                    pattern:{ type:'string', description:'Optional glob.' },
                },
            },
            run:(args, signal) => listFiles(repo, tree, args, signal, opts),
        },
        {
            name:'grep_repo',
            description:c.grep + ' Returns matching lines with filenames ' +
                'and line numbers. An empty result is not proof of ' +
                `absence ${EM} it cannot see ignored/generated files, ` +
                'other repos, interface/reflection dispatch, or ' +
                'build-tag-excluded code.',
            schema:{
                type:'object',
                properties:{
                    pattern:{
                        type:'string',
                        description:'Search pattern (literal string or ' +
                            'Go regexp).',
                    },
                    path_glob:{
                        type:'string',
                        description:'Optional glob to restrict which ' +
                            'files are searched (e.g. \'*.go\').',
                    },
                },
                required:['pattern'],
            },
            run:(args, signal) => grepRepo(repo, tree, args, signal, opts),
        },
    ]
}
