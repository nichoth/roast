// esbuild options shared by every bundle (spec 15, 2.5): the CLI, the
// test entries, and the schema generator. Run directly by Node (type
// stripping), so only erasable TypeScript syntax is allowed here.
import { fileURLToPath } from 'node:url'
import type { BuildOptions } from 'esbuild'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function baseOptions ():BuildOptions {
    return {
        absWorkingDir:ROOT,
        bundle:true,
        platform:'node',
        format:'esm',
        target:'node22',
        mainFields:['module', 'main'],
        keepNames:true,
        minify:false,
        sourcemap:false,
        loader:{ '.tmpl':'text', '.md':'text', '.sh':'text' },
        logLevel:'warning',
    }
}
