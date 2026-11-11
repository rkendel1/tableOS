/**
 * A restaurant built through TableOS's own mutations, as a manager would, on a fresh FeltDB
 * instance per test. Dates are computed in the location's time zone, a week ahead, so tests do not
 * depend on the time of day they run.
 */
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { addDays, localNow, weekdayOf } from "../feltkit/_time.js";

export const TZ = "America/New_York";
export const AGENT = { id: "frontdesk-agent", type: "agent" as const, roles: ["agent"] };

export interface Fixture {
  t: TestApp;
  locationId: string;
  /** A date seven days ahead, local to the location. */
  date: string;
  tables: Record<string, string>;
  key(): string;
}

let n = 0;

export async function restaurantFixture(options: { tables?: Array<[string, number, number]>; rules?: Partial<Record<string, number | boolean>> } = {}): Promise<Fixture> {
  const t = await createTestApp();
  const maria = t.as("maria");
  await maria.mutation(api.restaurant.update, { name: "Juniper & Salt", phone: "(555) 010-2030", cuisine: "New American" });
  const location = await maria.mutation(api.restaurant.createLocation, {
    slug: "main-street", name: "Main Street", address: "214 Main Street", city: "Hudson, NY", timeZone: TZ,
    rules: { accepting: true, slotMinutes: 15, durationMinutes: 90, minPartySize: 1, maxPartySize: 8, minLeadMinutes: 60, maxDaysAhead: 60, lastSeatingBeforeCloseMinutes: 60, ...(options.rules ?? {}) } as never,
  });
  for (let weekday = 0; weekday < 7; weekday++) {
    await maria.mutation(api.restaurant.setWeekly, { locationId: location.id, weekday, periods: [{ open: "17:00", close: "22:00" }] });
  }
  const tables: Record<string, string> = {};
  for (const [label, min, max] of options.tables ?? [["T1", 1, 2], ["T2", 2, 4], ["T3", 4, 6]]) {
    tables[label] = (await maria.mutation(api.restaurant.saveTable, { locationId: location.id, label, minParty: min, maxParty: max, active: true })).id;
  }
  const date = addDays(localNow(TZ, Date.now()).date, 7);
  return { t, locationId: location.id, date, tables, key: () => `test-key-${process.pid}-${++n}-${Math.random().toString(36).slice(2, 8)}` };
}

export { weekdayOf };
