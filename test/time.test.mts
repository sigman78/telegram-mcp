import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, parseTime } from '../src/time.ts';

// 2026-10-19 18:05:44 UTC
const T = Date.UTC(2026, 9, 19, 18, 5, 44) / 1000;
const ZONES = ['UTC', 'America/New_York', 'Europe/Stockholm', 'Asia/Kolkata', 'Pacific/Auckland'];

test('formatTime prints seconds and a UTC offset', () => {
  assert.equal(formatTime('UTC', T), '2026-10-19 18:05:44 +00:00');
  assert.equal(formatTime('America/New_York', T), '2026-10-19 14:05:44 -04:00');
  assert.equal(formatTime('Asia/Kolkata', T), '2026-10-19 23:35:44 +05:30');
  assert.equal(formatTime('Pacific/Auckland', T), '2026-10-20 07:05:44 +13:00');
});

for (const tz of ZONES) {
  test(`what is printed parses back to the same instant (${tz})`, () => {
    const printed = formatTime(tz, T);
    assert.equal(parseTime(printed, tz), T);
    assert.equal(parseTime(printed, 'UTC'), T, 'an explicit offset must win over the configured zone');
  });
}

test('input without an offset is read in the configured zone, not UTC', () => {
  assert.equal(parseTime('2026-10-19 18:05:44', 'UTC'), T);
  assert.equal(parseTime('2026-10-19 20:05:44', 'Europe/Stockholm'), T); // CEST, +02:00
  assert.equal(parseTime('2026-10-19T14:05:44', 'America/New_York'), T); // EDT, -04:00
  assert.equal(parseTime('2026-01-15 12:00', 'Europe/Stockholm'), Date.UTC(2026, 0, 15, 11, 0) / 1000); // CET, +01:00
});

test('date-only input means midnight in the configured zone', () => {
  assert.equal(parseTime('2026-10-19', 'UTC'), Date.UTC(2026, 9, 19) / 1000);
  assert.equal(parseTime('2026-10-19', 'Europe/Stockholm'), Date.UTC(2026, 9, 18, 22) / 1000);
});

test('explicit offsets: Z, +HH:MM and +HHMM', () => {
  assert.equal(parseTime('2026-10-19T18:05:44Z', 'Asia/Kolkata'), T);
  assert.equal(parseTime('2026-10-19T23:35:44+05:30', 'UTC'), T);
  assert.equal(parseTime('2026-10-19T23:35:44+0530', 'UTC'), T);
});

test('a time that does not exist (spring-forward gap) still gives a sane instant', () => {
  const t = parseTime('2026-03-29 02:30', 'Europe/Stockholm');
  assert.ok(Math.abs(t - Date.UTC(2026, 2, 29, 1, 30) / 1000) <= 3600);
});

test('garbage is rejected with a message that shows the expected format', () => {
  assert.throws(() => parseTime('tomorrow', 'UTC'), /Cannot parse date "tomorrow".*ISO format/);
  assert.throws(() => parseTime('2026-13-45', 'UTC'), /Cannot parse date/);
});
