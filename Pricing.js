// DeepSeek peak/off-peak schedule (pure JS, QML + Node shared).
// Peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday. Every other hour,
// weekends included, is off-peak (the discount band).
// The band itself is always computed in UTC; the format* helpers only render
// instants and windows in the caller's offset.
// Schedule source: https://api-docs.deepseek.com/quick_start/pricing/ (effective 2026-08-16)
// Math adapted from io.github.caffeinatedtech.qs-plugin-deepseek-pricing (MIT).

function isPeakAt(date) {
  var day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  var hour = date.getUTCHours()
  return (hour >= 1 && hour <= 3) || (hour >= 6 && hour <= 9)
}

// Next UTC top-of-hour where the band flips. Hourly forward scan: the furthest a
// flip can be is Fri 10:00 UTC -> Mon 01:00 UTC (63 hours).
function nextChange(date) {
  var top = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(),
    date.getUTCDate(), date.getUTCHours())
  if (top <= date.getTime()) top += 3600000
  var current = isPeakAt(date)
  for (var i = 0; i < 200; i++) {
    if (isPeakAt(new Date(top)) !== current) return new Date(top)
    top += 3600000
  }
  return new Date(top)
}

function pad(value) {
  return value < 10 ? "0" + value : "" + value
}

// Clock time of `date` in an east-positive offset, e.g. 120 -> "03:00".
function formatClock(date, offsetMinutes) {
  var shifted = new Date(date.getTime() + Math.round(offsetMinutes) * 60000)
  return pad(shifted.getUTCHours()) + ":" + pad(shifted.getUTCMinutes())
}

// Offset label, e.g. 120 -> "UTC+02:00", -300 -> "UTC-05:00", 0 -> "UTC".
function formatOffset(offsetMinutes) {
  var total = Math.round(offsetMinutes)
  if (total === 0) return "UTC"
  var abs = Math.abs(total)
  return "UTC" + (total < 0 ? "-" : "+") + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60)
}

// A UTC top-of-hour rendered as a local clock time, wrapped into 00:00-23:59.
function shiftHour(hour, offsetMinutes) {
  var minutesInDay = 1440
  var shifted = ((hour * 60 + Math.round(offsetMinutes)) % minutesInDay + minutesInDay) % minutesInDay
  return pad(Math.floor(shifted / 60)) + ":" + pad(shifted % 60)
}

// Both peak windows in the caller's offset, e.g. 120 ->
// "03:00-06:00, 08:00-12:00". Negative offsets wrap past midnight.
function formatWindows(offsetMinutes) {
  return shiftHour(1, offsetMinutes) + "-" + shiftHour(4, offsetMinutes)
    + ", " + shiftHour(6, offsetMinutes) + "-" + shiftHour(10, offsetMinutes)
}

if (typeof module !== "undefined") {
  module.exports = {
    isPeakAt: isPeakAt,
    nextChange: nextChange,
    formatClock: formatClock,
    formatOffset: formatOffset,
    formatWindows: formatWindows
  }
}
