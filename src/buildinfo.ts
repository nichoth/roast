// Version, commit, and build date. The bundle step injects them through
// esbuild defines; a build without them (the test bundle, running from
// source) gets the sentinels dev, unknown, unknown.

export interface BuildInfo {
    version:string;
    commit:string;
    date:string;
}

export const buildInfo:BuildInfo = {
    version:typeof __ROAST_VERSION__ === 'string' ?
        __ROAST_VERSION__ :
        'dev',
    commit:typeof __ROAST_COMMIT__ === 'string' ?
        __ROAST_COMMIT__ :
        'unknown',
    date:typeof __ROAST_DATE__ === 'string' ?
        __ROAST_DATE__ :
        'unknown',
}

// The one-line build string (Go buildinfo.String).
export function formatBuildInfo (info:BuildInfo):string {
    if (info.version === 'dev' || info.date === 'unknown') {
        return `${info.version} (commit ${info.commit})`
    }
    return `${info.version} (${info.commit}, ${info.date})`
}
