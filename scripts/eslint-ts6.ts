// Preloaded by `npm run lint` only. typescript-eslint (and ts-api-utils)
// refuse the TypeScript 7 package that `typecheck` uses, so inside the
// eslint process every import of `typescript` is sent to
// `@typescript/typescript6`, which re-exports the TypeScript 6 API.
// Remove this hook once typescript-eslint supports TypeScript 7.
import { registerHooks } from 'node:module'

registerHooks({
    resolve (specifier, context, nextResolve) {
        if (specifier === 'typescript') {
            return nextResolve('@typescript/typescript6', context)
        }
        return nextResolve(specifier, context)
    },
})
