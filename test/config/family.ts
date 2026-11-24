// Model families at the module seam (spec 02, 2.10).
import { test } from '../helpers/test.js'
import { canonicalFamily, inferFamily } from '../../src/config/family.js'

test('inferFamily matches the family table', t => {
    const cases:[string, string][] = [
        ['anthropic/claude-sonnet', 'anthropic'],
        ['gpt-5', 'openai'],
        ['gemini-2.5-pro', 'google'],
        ['mistral-large', 'mistral'],
        ['codestral-latest', 'mistral'],
        ['grok-4', 'xai'],
        ['command-r', 'cohere'],
        ['deepseek-chat', 'deepseek'],
        ['gpt-5-codex', 'openai'],
        ['codex-mini-latest', 'openai'],
        ['chatgpt-4o-latest', 'openai'],
        ['o3-mini', 'openai'],
        ['o4', 'openai'],
        ['openai/gpt-6.1-terra', 'openai'],
        ['anthropic/claude-opus-5-5', 'anthropic'],
        ['meta-llama/llama-4:free', ''],
        ['google/gemini-2.5-pro', 'google'],
        ['gemini/whatever', 'google'],
        ['someone/claude-x', 'anthropic'],
        ['claude-opus-5-5[1m]', 'anthropic'],
        ['  Claude-Opus  ', 'anthropic'],
        ['gemini', 'google'],
        ['OpenAI', 'openai'],
        ['llama-3', ''],
        ['', ''],
        ['   ', ''],
    ]
    for (const [input, want] of cases) {
        t.equal(inferFamily(input), want, `inferFamily(${input})`)
    }
})

test('canonicalFamily maps gemini to google only', t => {
    t.equal(canonicalFamily('gemini'), 'google')
    t.equal(canonicalFamily('google'), 'google')
    t.equal(canonicalFamily('openai'), 'openai')
})
