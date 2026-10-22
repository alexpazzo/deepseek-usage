#!/usr/bin/env node
// Self-check for Usage.js: node test-usage.js

const assert = require("assert")
const Usage = require("./Usage.js")

const TZ = 7200
const DAY_A = "2026-10-20"
const DAY_B = "2026-10-21"
const EPOCH_A = Date.UTC(2026, 9, 20, 12, 0, 0) / 1000
const EPOCH_B = Date.UTC(2026, 9, 21, 12, 0, 0) / 1000

// --- day keys ---------------------------------------------------------------

assert.strictEqual(
  Usage.localDayKey(Date.UTC(2026, 9, 20, 22, 30, 0) / 1000, TZ),
  "2026-10-21",
  "22:30Z shifts into the next local day at +02:00"
)
assert.strictEqual(
  Usage.localDayKey(Date.UTC(2026, 9, 20, 21, 30, 0) / 1000, TZ),
  DAY_A,
  "21:30Z stays in the same local day at +02:00"
)
assert.deepStrictEqual(
  Usage.dayKeysBack(Date.parse("2026-10-21T12:00:00Z"), TZ, 3),
  ["2026-10-19", "2026-10-20", "2026-10-21"],
  "dayKeysBack is contiguous and ends today"
)
assert.strictEqual(
  Usage.epochForDayStart("2026-10-19", TZ),
  Date.UTC(2026, 9, 18, 22, 0, 0) / 1000,
  "local midnight of a day key, shifted by tz"
)

// --- envelopes --------------------------------------------------------------

const okEnvelope = Usage.parseEnvelope(JSON.stringify({
  code: 0,
  msg: "",
  data: {
    biz_code: 0,
    biz_msg: "",
    biz_data: { series: [] }
  }
}))
assert.strictEqual(okEnvelope.ok, true, "success envelope parses")
assert.deepStrictEqual(okEnvelope.data, { series: [] })

const authFailure = Usage.parseEnvelope(JSON.stringify({
  code: 40003,
  msg: "Authorization Failed (invalid token)",
  data: null
}))
assert.strictEqual(authFailure.ok, false)
assert.strictEqual(authFailure.code, 40003)
assert.strictEqual(authFailure.message, "Authorization Failed (invalid token)")

const bizFailure = Usage.parseEnvelope(JSON.stringify({
  code: 0,
  msg: "",
  data: { biz_code: 40002, biz_msg: "missing token", biz_data: null }
}))
assert.strictEqual(bizFailure.ok, false)
assert.strictEqual(bizFailure.code, 40002)

// --- fixtures ---------------------------------------------------------------

const amountPayload = {
  series: [
    {
      model: "deepseek-chat",
      buckets: [
        {
          time: EPOCH_A,
          usage: {
            REQUEST: 12,
            PROMPT_CACHE_HIT_TOKEN: 800000,
            PROMPT_CACHE_MISS_TOKEN: 200000,
            RESPONSE_TOKEN: 40000
          }
        },
        {
          time: EPOCH_B,
          usage: {
            REQUEST: 5,
            PROMPT_CACHE_HIT_TOKEN: 100000,
            PROMPT_CACHE_MISS_TOKEN: 50000,
            RESPONSE_TOKEN: 9000
          }
        }
      ]
    },
    {
      model: "deepseek-reasoner",
      buckets: [
        {
          time: EPOCH_A,
          usage: {
            REQUEST: 3,
            PROMPT_CACHE_HIT_TOKEN: 100000,
            PROMPT_CACHE_MISS_TOKEN: 50000,
            RESPONSE_TOKEN: 9000
          }
        }
      ]
    }
  ]
}

const costPayload = {
  data: [
    {
      currency: "USD",
      series: [
        { model: "deepseek-chat", buckets: [{ time: EPOCH_A, cost: 0.12 }, { time: EPOCH_B, cost: 0.05 }] },
        { model: "deepseek-reasoner", buckets: [{ time: EPOCH_A, cost: 0.03 }] }
      ]
    }
  ]
}

const amountRows = Usage.parseAmount(amountPayload)
assert.strictEqual(amountRows.length, 3, "three amount buckets")
assert.deepStrictEqual(amountRows[0], {
  model: "deepseek-chat",
  time: EPOCH_A,
  usage: {
    REQUEST: 12,
    PROMPT_CACHE_HIT_TOKEN: 800000,
    PROMPT_CACHE_MISS_TOKEN: 200000,
    RESPONSE_TOKEN: 40000
  }
})

const costRows = Usage.parseCost(costPayload)
assert.strictEqual(costRows.length, 3, "three cost buckets")
assert.deepStrictEqual(costRows[0], { currency: "USD", model: "deepseek-chat", time: EPOCH_A, cost: 0.12 })
assert.strictEqual(Usage.parseCost({ series: costPayload.data[0].series })[0].currency, "USD", "bare series defaults to USD")

// --- aggregation ------------------------------------------------------------

const collected = Usage.collect(amountRows, costRows, 0)
assert.deepStrictEqual(Object.keys(collected.days).sort(), [DAY_A, DAY_B])
assert.deepStrictEqual(Object.keys(collected.models).sort(), ["deepseek-chat", "deepseek-reasoner"])

const dayA = Usage.sumRange(collected, [DAY_A])
assert.strictEqual(dayA.requests, 15)
assert.strictEqual(Usage.tokens(dayA), 900000 + 250000 + 49000)
assert.strictEqual(dayA.costs.USD.toFixed(2), "0.15")
assert.strictEqual(Usage.cacheRate(dayA), 900000 / 1150000)

const both = Usage.sumRange(collected, [DAY_A, DAY_B])
assert.strictEqual(both.requests, 20)
assert.strictEqual(both.costs.USD.toFixed(2), "0.20")

const modelTotals = Usage.sumRange(collected, [DAY_A, DAY_B])
assert.strictEqual(Usage.tokens(collected.models["deepseek-reasoner"]), 159000)
assert.strictEqual(Usage.tokens(collected.models["deepseek-chat"]), 1040000 + 159000)
assert.strictEqual(Usage.tokens(modelTotals), Usage.tokens(collected.models["deepseek-chat"]) + 159000)

assert.deepStrictEqual(Usage.sumRange(collected, ["2026-01-01"]), Usage.emptyCounters(), "unknown day is empty")

// A cost row with no amount row keeps its model and its day.
const costOnly = Usage.collect([], Usage.parseCost({
  data: [{ currency: "CNY", series: [{ model: "deepseek-chat", buckets: [{ time: EPOCH_B, cost: 9 }] }] }]
}), 0)
assert.strictEqual(costOnly.models["deepseek-chat"].costs.CNY, 9)
assert.strictEqual(costOnly.days[DAY_B].costs.CNY, 9)
assert.strictEqual(costOnly.days[DAY_B].requests, 0)

// --- tokens -----------------------------------------------------------------

assert.strictEqual(Usage.normalizeToken("eyJhbGciOiJIUzI1NiJ9.payload.sig"), "eyJhbGciOiJIUzI1NiJ9.payload.sig")
assert.strictEqual(Usage.normalizeToken('{"value":"JWT"}'), "JWT")
assert.strictEqual(Usage.normalizeToken('{"token":"JWT2"}'), "JWT2")
assert.strictEqual(Usage.normalizeToken(' "  JWT " '), "JWT")
assert.strictEqual(Usage.normalizeToken(""), "")
assert.strictEqual(Usage.normalizeToken("   "), "")
assert.strictEqual(Usage.normalizeToken('{"other":1}'), "", "object without a token is unusable")

// --- formatting -------------------------------------------------------------

assert.strictEqual(Usage.formatTokens(1234567), "1.2M")
assert.strictEqual(Usage.formatTokens(12345), "12K")
assert.strictEqual(Usage.formatTokens(999), "999")
assert.strictEqual(Usage.formatTokens(0), "0")
assert.strictEqual(Usage.formatTokens(3400000000), "3.4B")
assert.strictEqual(Usage.formatCosts({ costs: { USD: 0.4231 } }, "USD"), "$0.42")
assert.strictEqual(Usage.formatCosts({ costs: { CNY: 0 } }, "CNY"), "\u00a50.00")
assert.strictEqual(Usage.formatCosts(Usage.emptyCounters(), "USD"), "$0.00")
assert.strictEqual(Usage.formatAmount(0.0042, "USD"), "$0.0042")
assert.strictEqual(Usage.formatAmount(12.5, "JPY"), "JPY 12.50")
assert.strictEqual(Usage.formatPercent(0.9234), "92.3%")
assert.strictEqual(Usage.formatCount(1204), "1,204")
assert.strictEqual(Usage.formatCount(15), "15")
assert.strictEqual(Usage.primaryCurrency(collected), "USD")
assert.strictEqual(Usage.primaryCurrency({ currencies: { USD: 1.5, CNY: 9 } }), "CNY")
assert.strictEqual(Usage.primaryCurrency({ currencies: {} }), "USD")
assert.strictEqual(Usage.primaryCurrency(null), "USD")

console.log("test-usage: all checks passed")
