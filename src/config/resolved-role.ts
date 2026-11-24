// The runtime-ready role (spec 02, section 3 `role.ts`). Kept apart from
// role.ts so credential.ts can build roles without an import cycle.
import type { CredentialSource, StoredCredentials } from './credential.js'

export interface ResolvedRole {
    readonly profile:string;
    readonly baseURL:string;
    // Secret: never logged, recorded, or rendered. Not enumerable, so
    // JSON.stringify, spread, and util.inspect leave it out.
    readonly apiKey:string;
    readonly model:string;
    readonly protocol:string;
    readonly maxOutputTokens:number;
    readonly sessionHeader:string;
    readonly pin:boolean;
    readonly authorRoutes:Readonly<Record<string, string>>;
    readonly credential:CredentialSource;
    readonly explicitEndpoint:boolean;
    // Not enumerable either: a store may hold keys.
    readonly stored?:StoredCredentials;
}

// A frozen role whose `apiKey` and `stored` are not enumerable.
export function makeRole (fields:ResolvedRole):ResolvedRole {
    const { apiKey, stored, ...visible } = fields
    const role = { ...visible }
    Object.defineProperty(role, 'apiKey', { value:apiKey, enumerable:false })
    Object.defineProperty(role, 'stored', { value:stored, enumerable:false })
    return Object.freeze(role) as ResolvedRole
}

// A copy of `role` with `changes` applied. Use this instead of a spread,
// which drops the non-enumerable key and store.
export function updateRole (
    role:ResolvedRole,
    changes:Partial<ResolvedRole>
):ResolvedRole {
    return makeRole({
        profile:role.profile,
        baseURL:role.baseURL,
        apiKey:role.apiKey,
        model:role.model,
        protocol:role.protocol,
        maxOutputTokens:role.maxOutputTokens,
        sessionHeader:role.sessionHeader,
        pin:role.pin,
        authorRoutes:role.authorRoutes,
        credential:role.credential,
        explicitEndpoint:role.explicitEndpoint,
        stored:role.stored,
        ...changes,
    })
}
