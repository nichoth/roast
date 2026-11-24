import type { Finding } from '../../src/review/types.js'
import type { Report } from '../../src/render/render.js'

export function finding (patch:Partial<Finding> = {}):Finding {
    return {
        reasoning:'A guard is missing',
        severity:'HIGH',
        confidence:0.9,
        cwe:'CWE-476',
        description:'Missing guard',
        file:'main.ts',
        lines:[10, 12],
        code_quote:'return value.field',
        fixed_code:'return value?.field',
        frontend_category:'',
        ...patch,
    }
}

export function report (patch:Partial<Report> = {}):Report {
    return {
        result:{
            findings:[finding()],
            dropped:[],
            assessment:'FINDINGS_PRESENT',
            notes:[],
        },
        mode:'code',
        ...patch,
    }
}
