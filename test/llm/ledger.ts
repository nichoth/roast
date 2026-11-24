import { test } from '@substrate-system/tapzero'
import {
    newLedger,
    reserve,
    weightedTokens,
} from '../../src/llm/ledger.js'
import type { Usage } from '../../src/llm/types.js'

function usage (over:Partial<Usage> = {}):Usage {
    return {
        uncachedInputTokens:0,
        cachedInputTokens:0,
        cacheWriteTokens:0,
        outputTokens:0,
        calls:1,
        ...over,
    }
}

test('ledger: a limit <= 0 gives no ledger and unlimited admission', t => {
    t.equal(newLedger(0), null, 'zero limit: no ledger')
    t.equal(newLedger(-5), null, 'negative limit: no ledger')
    const release = reserve(null, 1e12, 1e12, false)
    t.ok(release, 'reservation admitted without a ledger')
    release?.(usage({ outputTokens:5 }))
    release?.(usage({ outputTokens:5 }))
})

test('ledger: final allowance is min(100000, limit/2)', t => {
    // limit 1000: allowance 500. est = 300/3 + 100 = 200; hold-back
    // max(500, 300) = 500, so headroom 500.
    const small = newLedger(1000)!
    t.ok(small.reserve(300, 100, false), '200 of 500 headroom admitted')
    t.ok(small.reserve(300, 100, false), '400 of 500 admitted')
    t.equal(small.reserve(300, 100, false), null, '600 > 500 refused')

    // limit 1_000_000: allowance 100000 (not 500000).
    const big = newLedger(1_000_000)!
    // est 900000/3? use reqBytes so est = 899_999 + 1 = 900_000;
    // hold-back max(100000, 900001) = 900001 -> headroom 99999: refused.
    t.equal(big.reserve(2_699_997, 1, false), null,
        'hold-back covers est + out when larger than the allowance')
    const big2 = newLedger(1_000_000)!
    // est = 300000 + 0 = 300000; hold-back max(100000, 300000) = 300000;
    // headroom 700000: admitted.
    t.ok(big2.reserve(900_000, 0, false), 'admitted under 700000')
    // est 100000+0: total 400000 <= 700000? hold-back
    // max(100000, 100000) = 100000 -> headroom 900000: admitted.
    t.ok(big2.reserve(300_000, 0, false), 'admitted under 900000')
    // est 170000: 400000 + 170000 = 570000; headroom
    // 1e6 - max(1e5, 170000) = 830000: admitted.
    t.ok(big2.reserve(510_000, 0, false), 'admitted')
    // est 1: 570001 > 1e6 - 1e5 = 900000? no -> admitted.
    t.ok(big2.reserve(3, 0, false), 'still admitted')
})

test('ledger: non-final refusal boundary is exact', t => {
    // limit 3000, allowance 1500. est = 300/3 + 100 = 200,
    // hold-back max(1500, 300) = 1500 -> headroom 1500.
    const l = newLedger(3000)!
    for (let i = 0; i < 7; i++) {
        t.ok(l.reserve(300, 100, false), `reservation ${i + 1} admitted`)
    }
    // committed 0 + outstanding 1400 + 200 = 1600 > 1500.
    t.ok(!l.exhausted(), 'not exhausted before a refusal')
    t.equal(l.reserve(300, 100, false), null, 'over by 100: refused')
    t.ok(l.exhausted(), 'refusal latches exhausted')
    // est 100 exactly fills 1500: equal is admitted.
    t.ok(l.reserve(0, 100, false), 'exactly at headroom: admitted')
    t.ok(l.exhausted(), 'exhausted stays latched')
})

test('ledger: a final reservation may use the whole limit', t => {
    const l = newLedger(3000)!
    t.equal(l.reserve(0, 2000, false), null, 'non-final 2000 refused')
    const fresh = newLedger(3000)!
    t.ok(fresh.reserve(0, 3000, true), 'final 3000 admitted')
    t.equal(fresh.reserve(0, 1, true), null, 'final over the limit refused')
    t.ok(fresh.exhausted(), 'final refusal latches exhausted')
})

test('ledger: release reconciles, is idempotent, floors negatives', t => {
    const l = newLedger(10_000)!
    const release = l.reserve(3000, 1000, true)!
    t.equal(l.outstanding(), 2000, 'outstanding holds the estimate')
    release(usage({
        uncachedInputTokens:100,
        cachedInputTokens:50,
        cacheWriteTokens:10,
        outputTokens:-7,
    }))
    t.equal(l.outstanding(), 0, 'outstanding back to 0')
    // 100 + 0.1*50 + 10 + 0 = 115
    t.deepEqual(l.committed(), { spent:115, limit:10_000 },
        'committed with cache reads at 0.1 and negatives floored')
    release(usage({ uncachedInputTokens:1000 }))
    t.equal(l.outstanding(), 0, 'second release does not change outstanding')
    t.deepEqual(l.committed(), { spent:115, limit:10_000 },
        'second release is a no-op')
})

test('ledger: committed truncates and is zero with no ledger', t => {
    const l = newLedger(1000.9)!
    const release = l.reserve(0, 1, true)!
    release(usage({ cachedInputTokens:7 }))
    t.deepEqual(l.committed(), { spent:0, limit:1000 }, 'truncated')
    const release2 = l.reserve(0, 1, true)!
    release2(usage({ uncachedInputTokens:2, cachedInputTokens:9 }))
    // 0.7 + 2 + 0.9 = 3.6
    t.deepEqual(l.committed(), { spent:3, limit:1000 }, 'truncates sums')
})

test('ledger: weightedTokens', t => {
    t.equal(weightedTokens(usage({
        uncachedInputTokens:4,
        cachedInputTokens:4,
        outputTokens:3,
    })), 7.4, 'chat example weighs 7.4')
    t.equal(weightedTokens(usage({
        uncachedInputTokens:-1,
        cachedInputTokens:20,
        cacheWriteTokens:-3,
        outputTokens:0,
    })), 2, 'cached may exceed uncached; negatives floored')
})
