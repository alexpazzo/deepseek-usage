// Pure parsing, aggregation and formatting for the DeepSeek usage API.
// No Qt imports and no Intl/Map so the same file runs under QML and Node
// (test-usage.js).

function num(value) {
  var n = Number(value)
  return isFinite(n) ? n : 0
}

function owns(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function trim(value) {
  return value === undefined || value === null ? "" : String(value).trim()
}

// Accepts a raw token, a JSON string holding one, or a JSON object with a
// "value"/"token" member (the shape localStorage.userToken can take).
function normalizeToken(raw) {
  var text = trim(raw)
  if (text === "") return ""
  var first = text.charAt(0)
  if (first !== "{" && first !== "\"") return text
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return ""
  }
  if (typeof parsed === "string") return trim(parsed)
  if (parsed && typeof parsed === "object") {
    var value = parsed.value !== undefined ? parsed.value : parsed.token
    return trim(value)
  }
  return ""
}

// {"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{...}}}
// Auth failures arrive as HTTP 200 with data:null, so the envelope is the only
// place the failure code shows up.
function parseEnvelope(text) {
  var payload
  try {
    payload = JSON.parse(trim(text))
  } catch (e) {
    return { ok: false, code: "invalid", message: "Unreadable response" }
  }
  if (!payload || typeof payload !== "object")
    return { ok: false, code: "invalid", message: "Unreadable response" }
  if (num(payload.code) !== 0 || !payload.data) {
    return {
      ok: false,
      code: payload.code === undefined ? "unknown" : payload.code,
      message: trim(payload.msg) || "Request failed"
    }
  }
  var data = payload.data
  if (num(data.biz_code) !== 0 || !data.biz_data) {
    return {
      ok: false,
      code: data.biz_code === undefined ? "unknown" : data.biz_code,
      message: trim(data.biz_msg) || trim(payload.msg) || "Request failed"
    }
  }
  return { ok: true, data: data.biz_data }
}

function copyUsage(source) {
  var usage = {}
  if (!source || typeof source !== "object") return usage
  for (var key in source) {
    if (owns(source, key)) usage[key] = num(source[key])
  }
  return usage
}

// {series:[{model, buckets:[{time, usage:{...}}]}]}
function parseAmount(bizData) {
  var rows = []
  if (!bizData || typeof bizData !== "object") return rows
  var series = bizData.series
  if (!series && bizData.data && bizData.data.series) series = bizData.data.series
  if (!series || !series.length) return rows
  for (var i = 0; i < series.length; i++) {
    var group = series[i] || {}
    var model = trim(group.model) || "unknown"
    var buckets = group.buckets || []
    for (var j = 0; j < buckets.length; j++) {
      var bucket = buckets[j] || {}
      rows.push({
        model: model,
        time: num(bucket.time),
        usage: copyUsage(bucket.usage)
      })
    }
  }
  return rows
}

// {data:[{currency, series:[{model, buckets:[{time, cost}]}]}]}
function parseCost(bizData) {
  var rows = []
  if (!bizData || typeof bizData !== "object") return rows
  var groups = bizData.data
  if (!groups && bizData.series) groups = [{ currency: "USD", series: bizData.series }]
  if (!groups || !groups.length) return rows
  for (var i = 0; i < groups.length; i++) {
    var group = groups[i] || {}
    var currency = trim(group.currency).toUpperCase() || "USD"
    var series = group.series || []
    for (var j = 0; j < series.length; j++) {
      var modelGroup = series[j] || {}
      var model = trim(modelGroup.model) || "unknown"
      var buckets = modelGroup.buckets || []
      for (var k = 0; k < buckets.length; k++) {
        var bucket = buckets[k] || {}
        rows.push({
          currency: currency,
          model: model,
          time: num(bucket.time),
          cost: num(bucket.cost)
        })
      }
    }
  }
  return rows
}

function emptyCounters() {
  return { requests: 0, cacheHit: 0, cacheMiss: 0, output: 0, costs: {} }
}

function countersFor(bucket, key) {
  if (!owns(bucket, key)) bucket[key] = emptyCounters()
  return bucket[key]
}

function addUsage(counters, usage) {
  counters.requests += num(usage.REQUEST)
  counters.cacheHit += num(usage.PROMPT_CACHE_HIT_TOKEN)
  counters.cacheMiss += num(usage.PROMPT_CACHE_MISS_TOKEN)
  counters.output += num(usage.RESPONSE_TOKEN)
}

function addCost(counters, currency, value) {
  if (!currency) return
  counters.costs[currency] = num(counters.costs[currency]) + num(value)
}

function mergeInto(target, source) {
  target.requests += num(source.requests)
  target.cacheHit += num(source.cacheHit)
  target.cacheMiss += num(source.cacheMiss)
  target.output += num(source.output)
  for (var code in source.costs) {
    if (owns(source.costs, code)) addCost(target, code, source.costs[code])
  }
}

// Buckets land on local day keys and per-model totals; costs attach to both, so
// a day can report spend even when the amount call returned nothing for it.
function collect(amountRows, costRows, tzOffsetSec) {
  var tz = num(tzOffsetSec)
  var days = {}
  var models = {}
  var currencies = {}

  var amounts = amountRows || []
  for (var i = 0; i < amounts.length; i++) {
    var row = amounts[i] || {}
    var usage = row.usage || {}
    var key = localDayKey(row.time, tz)
    var model = trim(row.model) || "unknown"
    addUsage(countersFor(days, key), usage)
    addUsage(countersFor(models, model), usage)
  }

  var costs = costRows || []
  for (var j = 0; j < costs.length; j++) {
    var costRow = costs[j] || {}
    var currency = trim(costRow.currency).toUpperCase() || "USD"
    var costModel = trim(costRow.model) || "unknown"
    var cost = num(costRow.cost)
    addCost(countersFor(days, localDayKey(costRow.time, tz)), currency, cost)
    addCost(countersFor(models, costModel), currency, cost)
    currencies[currency] = num(currencies[currency]) + cost
  }

  return { days: days, models: models, currencies: currencies }
}

function sumRange(collected, keys) {
  var total = emptyCounters()
  if (!collected || !keys) return total
  var days = collected.days || {}
  for (var i = 0; i < keys.length; i++) {
    if (owns(days, keys[i])) mergeInto(total, days[keys[i]])
  }
  return total
}

function primaryCurrency(collected) {
  var currencies = collected && collected.currencies ? collected.currencies : {}
  var best = ""
  var bestValue = -Infinity
  for (var code in currencies) {
    if (!owns(currencies, code)) continue
    var value = num(currencies[code])
    if (value > bestValue) {
      bestValue = value
      best = code
    }
  }
  return best === "" ? "USD" : best
}

function tokens(counters) {
  if (!counters) return 0
  return num(counters.cacheHit) + num(counters.cacheMiss) + num(counters.output)
}

function inputTokens(counters) {
  if (!counters) return 0
  return num(counters.cacheHit) + num(counters.cacheMiss)
}

function cacheRate(counters) {
  var input = inputTokens(counters)
  return input > 0 ? num(counters.cacheHit) / input : 0
}

function currencySymbol(currency) {
  switch (trim(currency).toUpperCase()) {
  case "USD": return "$"
  case "CNY": return "\u00a5"
  case "EUR": return "\u20ac"
  default: return ""
  }
}

function formatAmount(value, currency) {
  var amount = num(value)
  var text
  if (amount === 0) text = "0.00"
  else if (Math.abs(amount) >= 0.01) text = amount.toFixed(2)
  else text = amount.toFixed(4)
  var symbol = currencySymbol(currency)
  if (symbol !== "") return symbol + text
  var code = trim(currency).toUpperCase()
  return code === "" ? text : code + " " + text
}

function formatCosts(counters, currency) {
  var costs = counters && counters.costs ? counters.costs : {}
  return formatAmount(num(costs[currency]), currency)
}

function formatTokens(value) {
  var count = Math.max(0, Math.round(num(value)))
  if (count < 1000) return String(count)
  var units = ["K", "M", "B", "T"]
  var scaled = count
  var unit = -1
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled = scaled / 1000
    unit++
  }
  var rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled)
  if (rounded >= 1000 && unit < units.length - 1) {
    rounded = Math.round(rounded / 100) / 10
    unit++
  }
  var text = rounded < 10 && rounded !== Math.round(rounded)
    ? rounded.toFixed(1)
    : String(rounded)
  return text + units[unit]
}

function formatCount(value) {
  var count = Math.round(num(value))
  var digits = String(Math.abs(count))
  var grouped = ""
  while (digits.length > 3) {
    grouped = "," + digits.slice(-3) + grouped
    digits = digits.slice(0, -3)
  }
  return (count < 0 ? "-" : "") + digits + grouped
}

function formatPercent(ratio) {
  return (num(ratio) * 100).toFixed(1) + "%"
}

function tzOffsetSec(date) {
  return -date.getTimezoneOffset() * 60
}

function localDayKey(epochSec, tzOffsetSecValue) {
  return new Date((num(epochSec) + num(tzOffsetSecValue)) * 1000).toISOString().slice(0, 10)
}

function todayKey(nowMs, tzOffsetSecValue) {
  return localDayKey(num(nowMs) / 1000, tzOffsetSecValue)
}

function shiftDayKey(key, days) {
  var parts = String(key).split("-")
  var base = Date.UTC(num(parts[0]), num(parts[1]) - 1, num(parts[2]))
  return new Date(base + num(days) * 86400000).toISOString().slice(0, 10)
}

function dayKeysBack(nowMs, tzOffsetSecValue, count) {
  var total = Math.max(0, Math.round(num(count)))
  var keys = []
  var today = todayKey(nowMs, tzOffsetSecValue)
  for (var i = total - 1; i >= 0; i--) keys.push(shiftDayKey(today, -i))
  return keys
}

// Local midnight of `key`, as an epoch in the local-shifted space the API wants.
function epochForDayStart(key, tzOffsetSecValue) {
  var parts = String(key).split("-")
  var utc = Date.UTC(num(parts[0]), num(parts[1]) - 1, num(parts[2]))
  return Math.floor(utc / 1000) - num(tzOffsetSecValue)
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeToken: normalizeToken,
    parseEnvelope: parseEnvelope,
    parseAmount: parseAmount,
    parseCost: parseCost,
    emptyCounters: emptyCounters,
    collect: collect,
    sumRange: sumRange,
    primaryCurrency: primaryCurrency,
    tokens: tokens,
    inputTokens: inputTokens,
    cacheRate: cacheRate,
    formatAmount: formatAmount,
    formatCosts: formatCosts,
    formatTokens: formatTokens,
    formatCount: formatCount,
    formatPercent: formatPercent,
    tzOffsetSec: tzOffsetSec,
    localDayKey: localDayKey,
    todayKey: todayKey,
    dayKeysBack: dayKeysBack,
    epochForDayStart: epochForDayStart
  }
}
