#!/usr/bin/env node
// Self-check for Pricing.js: node test-pricing.js

const assert = require("assert")
const Pricing = require("./Pricing.js")

const utc = (text) => new Date(text)

// Wednesday 2026-10-21.
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T00:59:00Z")), false)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T01:00:00Z")), true)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T03:59:00Z")), true)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T04:00:00Z")), false)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T06:00:00Z")), true)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T09:59:00Z")), true)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T10:00:00Z")), false)
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-21T23:59:00Z")), false)

// Saturday 2026-10-24 is never peak.
assert.strictEqual(Pricing.isPeakAt(utc("2026-10-24T02:00:00Z")), false)

// Next flips.
assert.strictEqual(Pricing.nextChange(utc("2026-10-21T00:59:00Z")).toISOString(), "2026-10-21T01:00:00.000Z")
assert.strictEqual(Pricing.nextChange(utc("2026-10-21T02:00:00Z")).toISOString(), "2026-10-21T04:00:00.000Z")
assert.strictEqual(Pricing.nextChange(utc("2026-10-21T04:00:00Z")).toISOString(), "2026-10-21T06:00:00.000Z")
assert.strictEqual(Pricing.nextChange(utc("2026-10-21T10:00:00Z")).toISOString(), "2026-10-22T01:00:00.000Z")
assert.strictEqual(Pricing.nextChange(utc("2026-10-23T10:00:00Z")).toISOString(), "2026-10-26T01:00:00.000Z")
assert.strictEqual(Pricing.nextChange(utc("2026-10-24T02:00:00Z")).toISOString(), "2026-10-26T01:00:00.000Z")

// Local rendering is offset-driven, so it is deterministic under any TZ.
assert.strictEqual(Pricing.formatClock(utc("2026-10-22T01:00:00Z"), 120), "03:00")
assert.strictEqual(Pricing.formatClock(utc("2026-10-22T01:00:00Z"), -300), "20:00")
assert.strictEqual(Pricing.formatClock(utc("2026-10-22T01:05:00Z"), 330), "06:35")

assert.strictEqual(Pricing.formatOffset(0), "UTC")
assert.strictEqual(Pricing.formatOffset(120), "UTC+02:00")
assert.strictEqual(Pricing.formatOffset(-300), "UTC-05:00")
assert.strictEqual(Pricing.formatOffset(345), "UTC+05:45")
assert.strictEqual(Pricing.formatOffset(90), "UTC+01:30")

assert.strictEqual(Pricing.formatWindows(0), "01:00-04:00, 06:00-10:00")
assert.strictEqual(Pricing.formatWindows(120), "03:00-06:00, 08:00-12:00")
assert.strictEqual(Pricing.formatWindows(-300), "20:00-23:00, 01:00-05:00")
assert.strictEqual(Pricing.formatWindows(345), "06:45-09:45, 11:45-15:45")

console.log("test-pricing: all checks passed")
