import { test } from '@substrate-system/tapzero'
import { cleanEnv } from '../helpers/env.js'

test('cleanEnv drops provider and roast variables in any case', t => {
    const got = cleanEnv({
        ANTHROPIC_API_KEY:'a',
        OPENAI_BASE_URL:'b',
        OPENROUTER_API_KEY:'c',
        ROAST_FINDER_API_KEY:'d',
        roast_skip:'e',
        OpenAI_Api_Key:'f',
        PATH:'/bin',
        HOME:'/home/x',
        MY_ROAST_THING:'kept',
    })
    t.deepEqual(got, {
        PATH:'/bin',
        HOME:'/home/x',
        MY_ROAST_THING:'kept',
    }, 'only unrelated variables remain')
})
