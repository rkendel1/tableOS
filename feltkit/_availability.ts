/**
 * Availability: the restaurant's booking rules as pure functions over canonical records.
 *
 * A slot is bookable for a party when the location is open, the slot starts no later than
 * `lastSeatingBeforeCloseMinutes` before the period closes, it respects the lead time and the
 * booking window, and at least one active table seats the party with no overlapping active
 * reservation. The table chosen is the smallest that fits (then by label), so large tables are
 * kept for large parties. The same function decides what the public site offers and whether a
 * booking is accepted, so they cannot disagree.
 */
import { daysBetween, localNow, toClock, toMinutes, weekdayOf } from "./_time.js";

export interface Rules {
  accepting: boolean;
  slotMinutes: number;
  durationMinutes: number;
  minPartySize: number;
  maxPartySize: number;
  minLeadMinutes: number;
  maxDaysAhead: number;
  lastSeatingBeforeCloseMinutes: number;
}
export interface PeriodLike { open: string; close: string }
export interface TableLike { id: string; label: string; minParty: number; maxParty: number; active: boolean }
export interface BookingLike { id: string; tableId: string; startMin: number; endMin: number; status: string }
export interface HoursFor { periods: PeriodLike[]; closed: boolean; source: "weekly" | "exception"; note?: string }

/** Statuses that hold a table. */
export const ACTIVE = new Set(["booked", "seated"]);

/** The hours that apply on a date: a special-hours exception replaces the weekly hours. */
export function hoursOn(
  date: string,
  weekly: Array<{ weekday: number; periods: PeriodLike[] }>,
  exception: { closed: boolean; periods: PeriodLike[]; note?: string } | null | undefined,
): HoursFor {
  if (exception) return { periods: exception.closed ? [] : exception.periods, closed: exception.closed || exception.periods.length === 0, source: "exception", ...(exception.note ? { note: exception.note } : {}) };
  const day = weekly.find((w) => w.weekday === weekdayOf(date));
  const periods = day?.periods ?? [];
  return { periods, closed: periods.length === 0, source: "weekly" };
}

/** Problems with a set of opening periods (empty when valid). */
export function periodProblems(periods: PeriodLike[]): string[] {
  const problems: string[] = [];
  const sorted = [...periods].sort((a, b) => toMinutes(a.open) - toMinutes(b.open));
  sorted.forEach((p, i) => {
    if (toMinutes(p.close) <= toMinutes(p.open)) problems.push(`${p.open}–${p.close} closes before it opens (periods past midnight are not supported).`);
    const next = sorted[i + 1];
    if (next && toMinutes(next.open) < toMinutes(p.close)) problems.push(`${p.open}–${p.close} overlaps ${next.open}–${next.close}.`);
  });
  return problems;
}

/** The smallest active table that seats the party and is free for [start, end). */
export function pickTable(tables: TableLike[], bookings: BookingLike[], partySize: number, start: number, end: number, ignoreReservationId?: string): TableLike | null {
  const fits = tables
    .filter((t) => t.active && t.minParty <= partySize && partySize <= t.maxParty)
    .sort((a, b) => a.maxParty - b.maxParty || a.label.localeCompare(b.label));
  for (const table of fits) {
    const busy = bookings.some((b) => b.id !== ignoreReservationId && b.tableId === table.id && ACTIVE.has(b.status) && b.startMin < end && start < b.endMin);
    if (!busy) return table;
  }
  return null;
}

export type Refusal =
  | "not_accepting" | "party_too_small" | "party_too_large" | "date_in_past" | "too_far_ahead"
  | "closed" | "outside_hours" | "too_soon" | "off_grid" | "no_table";

export interface SlotCheck { ok: boolean; reason?: Refusal; message?: string; table?: TableLike; startMin: number; endMin: number }

export interface Situation {
  rules: Rules;
  timeZone: string;
  hours: HoursFor;
  tables: TableLike[];
  bookings: BookingLike[];
  nowMs: number;
}

/** Whether a party of `partySize` can be booked at `date` `time`, and on which table. */
export function checkSlot(sit: Situation, date: string, time: string, partySize: number, ignoreReservationId?: string): SlotCheck {
  const { rules } = sit;
  const startMin = toMinutes(time);
  const endMin = startMin + rules.durationMinutes;
  const no = (reason: Refusal, message: string): SlotCheck => ({ ok: false, reason, message, startMin, endMin });
  if (!rules.accepting) return no("not_accepting", "This location is not accepting reservations.");
  if (partySize < rules.minPartySize) return no("party_too_small", `The smallest party we book is ${rules.minPartySize}.`);
  if (partySize > rules.maxPartySize) return no("party_too_large", `Parties larger than ${rules.maxPartySize} should contact the restaurant.`);
  const now = localNow(sit.timeZone, sit.nowMs);
  const ahead = daysBetween(now.date, date);
  if (ahead < 0) return no("date_in_past", "That date has passed.");
  if (ahead > rules.maxDaysAhead) return no("too_far_ahead", `Reservations open ${rules.maxDaysAhead} days ahead.`);
  if (sit.hours.closed) return no("closed", sit.hours.note ? `Closed: ${sit.hours.note}.` : "Closed on that date.");
  const within = sit.hours.periods.some((p) => {
    const open = toMinutes(p.open);
    const lastSeat = toMinutes(p.close) - rules.lastSeatingBeforeCloseMinutes;
    return startMin >= open && startMin <= lastSeat;
  });
  if (!within) return no("outside_hours", `${time} is outside seating hours.`);
  const onGrid = sit.hours.periods.some((p) => startMin >= toMinutes(p.open) && (startMin - toMinutes(p.open)) % rules.slotMinutes === 0);
  if (!onGrid) return no("off_grid", `Reservations start every ${rules.slotMinutes} minutes from opening.`);
  if (ahead === 0 && startMin < now.minute + rules.minLeadMinutes) return no("too_soon", `Book at least ${rules.minLeadMinutes} minutes ahead.`);
  const table = pickTable(sit.tables, sit.bookings, partySize, startMin, endMin, ignoreReservationId);
  if (!table) return no("no_table", `No table for ${partySize} at ${time}.`);
  return { ok: true, table, startMin, endMin };
}

/** Every slot on a date and whether it is bookable for the party. */
export function slotsFor(sit: Situation, date: string, partySize: number): Array<{ time: string; available: boolean }> {
  const out: Array<{ time: string; available: boolean }> = [];
  if (sit.hours.closed) return out;
  for (const p of [...sit.hours.periods].sort((a, b) => toMinutes(a.open) - toMinutes(b.open))) {
    const last = toMinutes(p.close) - sit.rules.lastSeatingBeforeCloseMinutes;
    for (let m = toMinutes(p.open); m <= last; m += sit.rules.slotMinutes) {
      const time = toClock(m);
      out.push({ time, available: checkSlot(sit, date, time, partySize).ok });
    }
  }
  return out;
}

const TRANSITIONS: Record<string, readonly string[]> = {
  booked: ["seated", "cancelled", "no_show"],
  seated: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
export function nextStatuses(from: string): readonly string[] {
  return TRANSITIONS[from] ?? [];
}
