// The zod schema of .roast.jsonc: the single source of truth for its
// shape, its types, and the editor schema (roast.schema.json, rendered by
// json-schema.ts). Range checks and cross-field rules run later as plain
// functions in load.ts, so their order and messages match Go.
//
// Where the editor schema is intentionally stricter than or different
// from the runtime check, the difference is carried in `.meta()` and the
// runtime check lives in load.ts. Every such place is marked
// "editor-only" below.
import { z } from 'zod'
import { isGoDuration } from '../gocompat/duration.js'

const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

export const Duration = z.string({
    error:issue => 'duration must be a string such as "90s" (got ' +
        `${JSON.stringify(issue.input)})`,
}).refine(isGoDuration, {
    error:issue => `invalid duration ${JSON.stringify(issue.input)}`,
}).meta({
    id:'duration',
    // \u00b5 is the micro sign; Go also accepts U+03BC (Greek mu).
    pattern:'^([0-9]+(\\.[0-9]+)?(ns|us|\u00b5s|ms|s|m|h))+$|^0$',
    description:'A Go duration such as "90s" or "10m".',
})

export const InferenceProfile = z.strictObject({
    endpoint:z.string().optional().meta({
        format:'uri',
        description:'Base URL. Defaults to the protocol\'s public ' +
            'endpoint (https://api.openai.com/v1 or ' +
            'https://api.anthropic.com/v1). Any other endpoint requires ' +
            '`npx roast trust` approval and api_key_env.',
    }),
    model:z.string().optional().meta({
        description:'Model ID sent to the endpoint.',
    }),
    // editor-only: the enum. The runtime also accepts "" (unset) and
    // reports any other value in load.ts.
    protocol:z.string().optional().meta({
        enum:['responses', 'chat', 'anthropic'],
        description:'Wire protocol. Default responses.',
    }),
    // editor-only: the pattern. The runtime accepts "" (unset) and checks
    // the pattern in load.ts.
    api_key_env:z.string().optional().meta({
        pattern:'^[A-Za-z_][A-Za-z0-9_]*$',
        description:'Name of the environment variable that holds the ' +
            'credential. A config never holds the credential itself.',
    }),
    // editor-only: minimum 1. The runtime treats 0 as the default and
    // rejects negatives in load.ts.
    max_output_tokens:z.int().optional().meta({
        minimum:1,
        description:'Output token limit per request. Default 32768.',
    }),
    // editor-only: maxLength. The runtime checks length, characters, and
    // reserved names in load.ts.
    session_header:z.string().optional().meta({
        maxLength:64,
        description:'Extra request header that carries the ' +
            'per-conversation session ID, for gateways that need one.',
    }),
}).meta({ id:'inference_profile' })

export const Role = z.strictObject({
    // editor-only: required. A missing profile is reported by load.ts.
    profile:z.string().optional().meta({
        description:'Name of an inference profile.',
    }),
    pin:z.boolean().optional().meta({
        description:'Finder only: keep this profile even when it shares ' +
            'the author\'s model family.',
    }),
    author_routes:z.record(z.string(), z.string()).optional().meta({
        description:'Finder only: maps an author model or model family ' +
            'to another inference profile.',
    }),
}).meta({ id:'role', required:['profile'] })

// editor-only: minimum. The runtime checks it in load.ts
// (validateSettings) so the order and messages match Go.
function integer (minimum:number, description:string) {
    return z.int().optional().meta({ minimum, description })
}

// editor-only: minimum 0 and maximum 1, checked in load.ts (normalize).
function floor (description:string) {
    return z.number().optional().meta({ minimum:0, maximum:1, description })
}

export const ConfigSchema = z.strictObject({
    $schema:z.string().optional().meta({
        description:'Editor schema reference. Roast ignores it.',
    }),
    version:z.literal(1).meta({
        description:'Config schema version. Must be 1.',
    }),
    inference_profiles:z.record(z.string(), InferenceProfile).optional()
        .meta({
            description:'Named model, endpoint, protocol, and credential ' +
                'variable combinations that roles select.',
        }),
    roles:z.strictObject({
        finder:Role.optional().meta({
            description:'Proposes defects in the change.',
        }),
        verifier:Role.optional().meta({
            description:'Checks each proposed defect against the code.',
        }),
    }).optional().meta({
        description:'Which inference profile each role uses.',
    }),
    review:z.strictObject({
        confidence_floor:floor('Minimum confidence to report a finding. ' +
            'Default 0.6.'),
        quick_confidence_floor:floor('Minimum confidence for a --quick ' +
            'review. Default 0.8.'),
        excludes:z.array(z.string()).optional().meta({
            description:'Path patterns left out of every review.',
        }),
        snapshot:z.boolean().optional().meta({
            description:'Record a Git snapshot of each review for ' +
                'replay. Default true.',
        }),
    }).optional().meta({ description:'Review defaults.' }),
    prompts:z.strictObject({
        finder_code:z.string().optional().meta({
            description:'Finder prompt for code changes.',
        }),
        finder_prose:z.string().optional().meta({
            description:'Finder prompt for prose changes.',
        }),
        verifier:z.string().optional().meta({
            description:'Verifier prompt.',
        }),
    }).optional().meta({
        description:'Project files that replace the embedded prompt ' +
            'templates. A relative path is relative to the directory ' +
            'holding this config file. Setting any of these requires ' +
            '`npx roast trust` approval.',
    }),
    limits:z.strictObject({
        deadline:Duration.optional().meta({
            description:'Wall-clock limit for one review. Default ' +
                '"10m"; "0s" disables.',
        }),
        request_timeout:Duration.optional().meta({
            description:'Limit for one model request. Default "10m".',
        }),
        max_total_tokens:integer(0, 'Token budget for one review. ' +
            'Default 3000000; 0 disables.'),
        max_diff_bytes:integer(1, 'Largest diff sent to the finder. ' +
            'Default 1000000.'),
        max_prompt_bytes:integer(1, 'Largest prompt sent in one ' +
            'request. Default 8000000.'),
        max_file_ctx_bytes:integer(1, 'Largest file context sent with ' +
            'the diff. Default 400000.'),
        max_attempts:integer(1, 'Attempts per model request, including ' +
            'the first. Default 4.'),
        max_verified:integer(0, 'Most findings sent to the verifier. ' +
            'Default 25.'),
    }).optional().meta({
        description:'Per-review limits. An unset limit uses the ' +
            'built-in default.',
    }),
    interactive:z.strictObject({
        min_files:integer(0, 'Minimum changed files. Default 4.'),
        min_diff_lines:integer(0, 'Minimum changed lines. Default 80.'),
    }).optional().meta({
        description:'Diff size below which an --interactive review uses ' +
            'a single finder call instead.',
    }),
    gate:z.strictObject({
        timeout_seconds:integer(0, 'Gate watchdog in seconds. Default ' +
            '180; 0 disables.'),
        // editor-only: the upper-case enum. The runtime accepts any letter
        // case and checks the value in load.ts.
        severity:z.string().optional().meta({
            enum:[...SEVERITIES],
            description:'Lowest severity that blocks a commit. Default ' +
                'HIGH.',
        }),
        offer:z.boolean().optional().meta({
            description:'Whether the first interactive review offers to ' +
                'enable the gate. Default true.',
        }),
    }).optional().meta({ description:'The pre-commit gate.' }),
})

export type RawConfig = z.infer<typeof ConfigSchema>
export type RawProfile = z.infer<typeof InferenceProfile>
export type RawRole = z.infer<typeof Role>

export { SEVERITIES }
