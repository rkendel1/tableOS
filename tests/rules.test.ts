/** The pure business rules, without a runtime. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSlot, hoursOn, periodProblems, pickTable, slotsFor, canTransition, type Situation } from "../feltkit/_availability.js";
import { categorizeInquiry, menuIssues, phoneKey, emailKey, reviewThemes } from "../feltkit/_rules.js";
import { addDays, localNow, weekdayOf, isValidDate } from "../feltkit/_time.js";

const rules = { accepting: true, slotMinutes: 15, durationMinutes: 90, minPartySize: 1, maxPartySize: 8, minLeadMinutes: 60, maxDaysAhead: 30, lastSeatingBeforeCloseMinutes: 60 };
const TZ = "America/New_York";
const today = localNow(TZ, Date.now()).date;
const date = addDays(today, 3);

function sit(over: Partial<Situation> = {}): Situation {
  return {
    rules, timeZone: TZ, nowMs: Date.now(),
    hours: { periods: [{ open: "17:00", close: "22:00" }], closed: false, source: "weekly" },
    tables: [{ id: "a", label: "T1", minParty: 1, maxParty: 2, active: true }, { id: "b", label: "T2", minParty: 2, maxParty: 4, active: true }],
    bookings: [],
    ...over,
  };
}

test("weekday and date arithmetic are time-zone independent", () => {
  assert.equal(weekdayOf("2026-11-11"), 3); // a Wednesday
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(isValidDate("2026-02-30"), false);
  assert.equal(isValidDate("2028-02-29"), true);
});

test("special hours replace the weekly hours for that date", () => {
  const weekly = [{ weekday: weekdayOf(date), periods: [{ open: "17:00", close: "22:00" }] }];
  assert.equal(hoursOn(date, weekly, null).closed, false);
  const closed = hoursOn(date, weekly, { closed: true, periods: [], note: "Private event" });
  assert.deepEqual([closed.closed, closed.source, closed.note], [true, "exception", "Private event"]);
  const late = hoursOn(date, weekly, { closed: false, periods: [{ open: "17:00", close: "23:30" }] });
  assert.deepEqual(late.periods, [{ open: "17:00", close: "23:30" }]);
});

test("opening periods must close after they open and not overlap", () => {
  assert.deepEqual(periodProblems([{ open: "11:00", close: "14:00" }, { open: "17:00", close: "22:00" }]), []);
  assert.equal(periodProblems([{ open: "22:00", close: "02:00" }]).length, 1);
  assert.equal(periodProblems([{ open: "11:00", close: "15:00" }, { open: "14:00", close: "22:00" }]).length, 1);
});

test("slots run from opening to the last seating, on the grid", () => {
  const slots = slotsFor(sit(), date, 2);
  assert.equal(slots[0]!.time, "17:00");
  assert.equal(slots.at(-1)!.time, "21:00", "last seating is an hour before close");
  assert.equal(slots.length, 17);
  assert.equal(checkSlot(sit(), date, "17:10", 2).reason, "off_grid");
  assert.equal(checkSlot(sit(), date, "21:15", 2).reason, "outside_hours");
  assert.equal(checkSlot(sit(), date, "12:00", 2).reason, "outside_hours");
});

test("rules refuse with a reason: party size, window, past dates, closures, not accepting", () => {
  assert.equal(checkSlot(sit(), date, "18:00", 9).reason, "party_too_large");
  assert.equal(checkSlot(sit(), addDays(today, 31), "18:00", 2).reason, "too_far_ahead");
  assert.equal(checkSlot(sit(), addDays(today, -1), "18:00", 2).reason, "date_in_past");
  assert.equal(checkSlot(sit({ hours: { periods: [], closed: true, source: "exception", note: "Private event" } }), date, "18:00", 2).reason, "closed");
  assert.equal(checkSlot(sit({ rules: { ...rules, accepting: false } }), date, "18:00", 2).reason, "not_accepting");
});

test("the smallest fitting table is chosen, and an overlapping booking blocks a table", () => {
  assert.equal(checkSlot(sit(), date, "18:00", 2).table!.label, "T1");
  assert.equal(checkSlot(sit(), date, "18:00", 3).table!.label, "T2");
  const busy = sit({ bookings: [{ id: "r1", tableId: "a", startMin: 18 * 60, endMin: 19 * 60 + 30, status: "booked" }] });
  assert.equal(checkSlot(busy, date, "19:00", 2).table!.label, "T2", "T1 is taken until 19:30");
  assert.equal(checkSlot(busy, date, "19:30", 2).table!.label, "T1", "a booking ending at 19:30 frees T1 at 19:30");
  const cancelled = sit({ bookings: [{ id: "r1", tableId: "a", startMin: 18 * 60, endMin: 19 * 60 + 30, status: "cancelled" }] });
  assert.equal(checkSlot(cancelled, date, "18:00", 2).table!.label, "T1", "cancelled bookings hold nothing");
  const full = sit({ bookings: [{ id: "r1", tableId: "a", startMin: 1080, endMin: 1170, status: "booked" }, { id: "r2", tableId: "b", startMin: 1080, endMin: 1170, status: "seated" }] });
  assert.equal(checkSlot(full, date, "18:00", 2).reason, "no_table");
  assert.equal(pickTable(full.tables, full.bookings, 2, 1080, 1170, "r2")!.label, "T2", "a reservation being modified does not block itself");
});

test("reservation status transitions", () => {
  assert.ok(canTransition("booked", "seated"));
  assert.ok(canTransition("seated", "completed"));
  assert.ok(canTransition("booked", "no_show"));
  assert.ok(!canTransition("cancelled", "booked"));
  assert.ok(!canTransition("completed", "cancelled"));
  assert.ok(!canTransition("seated", "no_show"));
});

test("contact keys and inquiry triage", () => {
  assert.equal(phoneKey("(555) 010-2030"), "5550102030");
  assert.equal(phoneKey("+1 555 010 2030"), "+15550102030");
  assert.equal(phoneKey("12"), undefined);
  assert.equal(emailKey(" Ada@Example.COM "), "ada@example.com");
  assert.equal(categorizeInquiry("Do you have a private room for a rehearsal dinner?"), "private_event");
  assert.equal(categorizeInquiry("Is the farrotto gluten free?"), "menu_dietary");
  assert.equal(categorizeInquiry("Can I change my reservation to 8pm?"), "reservation");
  assert.equal(categorizeInquiry("Are you open on Thanksgiving?"), "hours_location");
  assert.equal(categorizeInquiry("Hello"), "other");
});

test("menu checks find contradictions and gaps, naming the item", () => {
  const items = [
    { id: "i1", menuId: "m", sectionId: "s", name: "Vegan bowl", description: "Tofu", priceCents: 1200, dietary: ["vegan"], allergens: ["dairy"], available: true },
    { id: "i2", menuId: "m", sectionId: "s", name: "Salad", description: "Gluten-free croutons", priceCents: 0, dietary: [], available: true },
    { id: "i3", menuId: "m", sectionId: "s", name: "salad", description: "x", priceCents: 900, dietary: [], allergens: [], available: false },
  ];
  const issues = menuIssues([{ id: "m", name: "Dinner", active: true }], [{ id: "s", menuId: "m", name: "Mains" }, { id: "e", menuId: "m", name: "Empty" }], items);
  const codes = issues.map((i) => `${i.itemId ?? i.sectionId}:${i.code}`).sort();
  assert.deepEqual(codes, [
    "e:empty_section",
    "i1:vegan_contradiction",
    "i2:allergens_undeclared",
    "i2:dietary_mentioned_not_tagged",
    "i2:zero_price",
    "i3:duplicate_name",
  ]);
});

test("review themes cite the reviews they came from", () => {
  const themes = reviewThemes([
    { id: "r1", rating: 1, text: "We waited an hour and the server was rude.", source: "google", reviewedAt: "2026-11-01", author: "a" },
    { id: "r2", rating: 2, text: "Slow kitchen, cold food.", source: "yelp", reviewedAt: "2026-11-02", author: "b" },
    { id: "r3", rating: 5, text: "Delicious and friendly staff.", source: "google", reviewedAt: "2026-11-03", author: "c" },
  ]);
  const wait = themes.find((t) => t.id === "wait_times")!;
  assert.deepEqual(wait.evidence.map((e) => e.reviewId).sort(), ["r1", "r2"]);
  assert.equal(wait.negativeMentions, 2);
  assert.equal(themes[0]!.negativeMentions >= themes.at(-1)!.negativeMentions, true, "sorted by negative mentions");
  const service = themes.find((t) => t.id === "service")!;
  assert.deepEqual(service.evidence.map((e) => e.reviewId).sort(), ["r1", "r3"]);
  assert.match(service.evidence[0]!.excerpt, /rude/);
});
