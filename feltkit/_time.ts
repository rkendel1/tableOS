/**
 * Local dates and times at a location. Pure functions: the only clock input is `nowMs`.
 *
 * A location's "now" comes from its IANA time zone through Intl, so it is correct across DST
 * changes. (This is one reason TableOS targets FeltKit's Node runtime rather than an AppBoundry
 * artifact, whose engine has no locale/time-zone data — see docs/PLATFORM-AUDIT.md.)
 */

export function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
}

export function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Weekday (0 = Sunday) of a calendar date, independent of any time zone. */
export function weekdayOf(date: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay();
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, mo! - 1, d!));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo! - 1 && t.getUTCDate() === d;
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (calendar dates). */
export function daysBetween(a: string, b: string): number {
  const ms = (x: string) => {
    const [y, mo, d] = x.split("-").map(Number);
    return Date.UTC(y!, mo! - 1, d!);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The location's local date and minute-of-day at `nowMs`. */
export function localNow(timeZone: string, nowMs: number): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}
