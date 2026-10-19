/**
 * Times shown to the agent carry seconds and a UTC offset ("2026-10-19 18:05:44 +02:00"), and the same string
 * parses back to the same instant. Input without an offset is read in the configured timezone, not in UTC.
 */
const pad = (n: number) => String(n).padStart(2, '0');

/** Offset of `tz` from UTC at `at`, in minutes (east is positive). */
export function offsetMinutes(tz: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

export function formatTime(tz: string, epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const off = offsetMinutes(tz, d);
  const shifted = new Date(d.getTime() + off * 60_000).toISOString();
  const a = Math.abs(off);
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} ${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const SHAPE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Epoch seconds for an ISO-like date or date-time. Without an explicit offset it is read in `tz`. */
export function parseTime(input: string, tz: string): number {
  const m = SHAPE.exec(input.trim());
  if (!m) throw new Error(`Cannot parse date "${input}" - use ISO format like 2026-03-01 or 2026-03-01 14:30:00 +02:00`);
  const [, date, rawTime, rawOffset] = m;
  const time = rawTime ? (rawTime.length === 5 ? `${rawTime}:00` : rawTime) : '00:00:00';
  let ms: number;
  if (rawOffset) {
    const o = rawOffset.toUpperCase() === 'Z' ? 'Z' : rawOffset.length === 5 ? `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}` : rawOffset;
    ms = Date.parse(`${date}T${time}${o}`);
  } else {
    const asUtc = Date.parse(`${date}T${time}Z`);
    if (Number.isNaN(asUtc)) throw new Error(`Cannot parse date "${input}" - use ISO format like 2026-03-01`);
    const guess = asUtc - offsetMinutes(tz, new Date(asUtc)) * 60_000;
    ms = asUtc - offsetMinutes(tz, new Date(guess)) * 60_000; // second pass settles dates next to a DST change
  }
  if (Number.isNaN(ms)) throw new Error(`Cannot parse date "${input}" - use ISO format like 2026-03-01`);
  return Math.floor(ms / 1000);
}
