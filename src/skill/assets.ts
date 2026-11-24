// The bundled agent skill: every file under src/skill/assets/roast/,
// keyed by its path relative to that directory. esbuild has no directory
// embed, so each file needs its own text-loader import here.
import skillMd from './assets/roast/SKILL.md'

const encoder = new TextEncoder()

export const SKILL_FILES:ReadonlyMap<string, Uint8Array> = new Map([
    ['SKILL.md', encoder.encode(skillMd)],
])
