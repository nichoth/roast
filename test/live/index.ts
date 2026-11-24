// Entry for opt-in live provider tests (ROAST_LIVE_*). Never imported by
// test/index.ts, so `npm test` cannot reach the network. Run with
// `npm run test:live`; each test skips unless its variables are set.
import './anthropic.js'
import './deepseek.js'
