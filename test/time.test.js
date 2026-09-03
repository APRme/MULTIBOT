const test = require('node:test');
const assert = require('node:assert/strict');
const { getTimestamp, formatDuration } = require('../src/util/time');

function expectedOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const pad2 = (value) => String(value).padStart(2, '0');
  return `${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
}

test('getTimestamp renders wall-clock time with local offset', () => {
  const date = new Date(2026, 8, 3, 21, 5, 46, 873); // local timezone
  const output = getTimestamp(date);
  assert.match(output, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(output, `2026-09-03T21:05:46.873${expectedOffset(date)}`);
});

test('getTimestamp with no argument matches a parseable ISO timestamp', () => {
  const output = getTimestamp();
  assert.match(output, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  const parsed = new Date(output);
  assert.equal(Number.isNaN(parsed.getTime()), false);
});

test('getTimestamp offset matches the local timezone offset', () => {
  const date = new Date();
  const output = getTimestamp(date);
  assert.ok(output.endsWith(expectedOffset(date)));
});

test('formatDuration renders human readable durations', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(1500), '1s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(3600000), '1h');
  assert.equal(formatDuration(90061000), '1d 1h 1m 1s');
  assert.equal(formatDuration(-5), '0s');
});
