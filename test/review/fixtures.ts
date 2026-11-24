import type { WireFinding } from '../../src/review/types.js'

export function wire (over:Partial<WireFinding> = {}):WireFinding {
    return {
        reasoning:'The guard is missing.',
        severity:'HIGH',
        confidence:0.8,
        cwe:'',
        description:'Missing guard',
        file:'a.ts',
        lines:[3],
        code_quote:'return value',
        fixed_code:'return value ?? 0',
        frontend_category:'',
        ...over,
    }
}
