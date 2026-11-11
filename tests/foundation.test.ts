/**
 * Stages 1–2: canonical restaurant records persist, authorization holds, and the public site is a
 * projection of those records (a manager's change is what the public reads next).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { addDays, weekdayOf } from "../feltkit/_time.js";
import { restaurantFixture, AGENT } from "./fixture.js";

test("restaurant, location, hours and tables persist across a restart", async () => {
  const { t, locationId } = await restaurantFixture();
  try {
    await t.restart();
    const r = await t.as("lee").query(api.restaurant.get, {});
    assert.equal(r?.name, "Juniper & Salt");
    const [loc] = await t.as("lee").query(api.restaurant.listLocations, {});
    assert.equal(loc!.id, locationId);
    assert.equal(loc!.timeZone, "America/New_York");
    const hours = await t.as("lee").query(api.restaurant.hours, { locationId });
    assert.equal(hours.weekly.length, 7);
    assert.equal((await t.as("lee").query(api.restaurant.listTables, { locationId })).length, 3);
  } finally {
    await t.close();
  }
});

test("only roles holding the permission can change canonical records", async () => {
  const { t, locationId, date } = await restaurantFixture();
  try {
    await assert.rejects(t.as("lee").mutation(api.restaurant.update, { name: "Nope" }), { code: "FORBIDDEN" }, "staff read only");
    await assert.rejects(t.as("sam").mutation(api.restaurant.setWeekly, { locationId, weekday: 1, periods: [] }), { code: "FORBIDDEN" }, "hosts cannot change hours");
    await assert.rejects(t.as("sam").mutation(api.menu.saveMenu, { name: "X", active: true, locationIds: [], position: 0 }), { code: "FORBIDDEN" }, "hosts cannot edit menus");
    await assert.rejects(t.as(AGENT).mutation(api.restaurant.update, { name: "Agent's Diner" }), { code: "FORBIDDEN" }, "the agent has no restaurant.write");
    // The agent holds hours.write, but the function requires a person's approval: calling it directly is refused.
    await assert.rejects(t.as(AGENT).mutation(api.restaurant.setException, { locationId, date, closed: true, periods: [] }), (e: any) => e.code === "FORBIDDEN" && /approval/.test(e.message));
    // A caller with no session (t itself is anonymous) reaches public functions only; a signed-in
    // account without a staff role is refused differently (FORBIDDEN, not UNAUTHORIZED).
    await assert.rejects(t.query(api.guests.list, {}), { code: "UNAUTHORIZED" });
    await assert.rejects(t.as({ id: "diner", type: "user", roles: [] }).query(api.guests.list, {}), { code: "FORBIDDEN" });
    assert.equal((await t.as("lee").query(api.restaurant.get, {}))?.name, "Juniper & Salt", "nothing changed");
  } finally {
    await t.close();
  }
});

test("hours validation refuses impossible periods", async () => {
  const { t, locationId } = await restaurantFixture();
  try {
    await assert.rejects(t.as("maria").mutation(api.restaurant.setWeekly, { locationId, weekday: 2, periods: [{ open: "22:00", close: "02:00" }] }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(t.as("maria").mutation(api.restaurant.setWeekly, { locationId, weekday: 2, periods: [{ open: "11:00", close: "15:00" }, { open: "14:00", close: "22:00" }] }), { code: "INVALID_ARGUMENT" });
    await assert.rejects(t.as("maria").mutation(api.restaurant.createLocation, { slug: "x", name: "X", address: "a", city: "c", timeZone: "Mars/Olympus" }), { code: "INVALID_ARGUMENT" });
  } finally {
    await t.close();
  }
});

test("special hours change what can be booked and what the public site shows, for that date only", async () => {
  const { t, locationId, date } = await restaurantFixture();
  try {
    const maria = t.as("maria");
    const before = await t.query(api.public.availability, { locationId, date, partySize: 2 });
    assert.equal(before.slots.at(-1)!.time, "21:00");

    // Friday-style late night on one date.
    await maria.mutation(api.restaurant.setException, { locationId, date, closed: false, periods: [{ open: "17:00", close: "23:30" }], note: "Late night" });
    const late = await t.as("lee").query(api.reservations.availability, { locationId, date, partySize: 2 });
    assert.equal(late.hoursSource, "exception");
    assert.equal(late.slots.at(-1)!.time, "22:30");
    const nextDay = await t.as("lee").query(api.reservations.availability, { locationId, date: addDays(date, 1), partySize: 2 });
    assert.equal(nextDay.slots.at(-1)!.time, "21:00", "other dates keep the weekly hours");

    // A closure.
    const closureDate = addDays(date, 2);
    await maria.mutation(api.restaurant.setException, { locationId, date: closureDate, closed: true, periods: [], note: "Private event" });
    const closed = await t.as("lee").query(api.reservations.availability, { locationId, date: closureDate, partySize: 2 });
    assert.deepEqual([closed.open, closed.slots.length, closed.note], [false, 0, "Private event"]);
    const info = await t.query(api.public.info, {});
    const listed = info.locations[0]!.upcomingExceptions.map((e) => [e.date, e.closed, e.note]);
    assert.deepEqual(listed, [[date, false, "Late night"], [closureDate, true, "Private event"]]);

    // Removing the exception restores the weekly hours.
    await maria.mutation(api.restaurant.removeException, { locationId, date });
    assert.equal((await t.as("lee").query(api.reservations.availability, { locationId, date, partySize: 2 })).hoursSource, "weekly");

    // Weekly change for that weekday: closed.
    await maria.mutation(api.restaurant.setWeekly, { locationId, weekday: weekdayOf(date), periods: [] });
    assert.equal((await t.as("lee").query(api.reservations.availability, { locationId, date, partySize: 2 })).open, false);

    const trail = await t.as("maria").query(api.insights.audit, { subjectType: "hours", subjectId: locationId });
    assert.ok(trail.some((e) => e.type === "hours.exception.removed" && e.actor === "maria"));
  } finally {
    await t.close();
  }
});

test("menu changes are reflected in the public menu; unavailable and undeclared states are explicit", async () => {
  const { t } = await restaurantFixture();
  try {
    const maria = t.as("maria");
    const visitor = t;
    const menu = await maria.mutation(api.menu.saveMenu, { name: "Dinner", active: true, locationIds: [], position: 0 });
    const section = await maria.mutation(api.menu.saveSection, { menuId: menu.id, name: "Mains", position: 0 });
    const item = await maria.mutation(api.menu.saveItem, { sectionId: section.id, name: "Hake", description: "Brown butter", priceCents: 3400, dietary: [], allergens: ["fish", "dairy"], available: true, position: 0 });
    const greens = await maria.mutation(api.menu.saveItem, { sectionId: section.id, name: "Greens", priceCents: 1200, dietary: ["vegetarian"], available: true, position: 1 });

    let pub = await visitor.query(api.public.menu, {});
    assert.equal(pub[0]!.sections[0]!.items[0]!.priceCents, 3400);
    assert.equal(pub[0]!.sections[0]!.items[1]!.allergens, null, "undeclared allergens are not presented as 'none'");

    await maria.mutation(api.menu.saveItem, { id: item.id, sectionId: section.id, name: "Hake", description: "Brown butter", priceCents: 3600, dietary: [], allergens: ["fish", "dairy"], available: true, position: 0 });
    await maria.mutation(api.menu.setAvailability, { itemId: greens.id, available: false });
    pub = await visitor.query(api.public.menu, {});
    assert.equal(pub[0]!.sections[0]!.items[0]!.priceCents, 3600);
    assert.equal(pub[0]!.sections[0]!.items[1]!.available, false);

    await maria.mutation(api.menu.saveMenu, { id: menu.id, name: "Dinner", active: false, locationIds: [], position: 0 });
    assert.deepEqual(await visitor.query(api.public.menu, {}), [], "an unpublished menu is not public");

    const trail = await maria.query(api.insights.audit, { subjectType: "menu", subjectId: menu.id });
    const price = trail.find((e) => e.type === "item.updated");
    assert.deepEqual(price!.data!.priceCents, { before: 3400, after: 3600 });

    const issues = await t.as("lee").query(api.menu.issues, {});
    assert.ok(issues.issues.some((i) => i.itemId === greens.id && i.code === "allergens_undeclared"));
  } finally {
    await t.close();
  }
});

test("the public site never exposes guest data or staff-only records", async () => {
  const { t } = await restaurantFixture();
  try {
    const visitor = t;
    for (const fn of [api.guests.list, api.reservations.list, api.inquiries.list, api.reviews.list, api.insights.audit] as const) {
      await assert.rejects((visitor.query as any)(fn, {}), { code: "UNAUTHORIZED" });
    }
    const info = await visitor.query(api.public.info, {});
    assert.equal(info.restaurant?.name, "Juniper & Salt");
    assert.ok(!("updatedBy" in (info.restaurant as object)), "internal fields are not projected");
  } finally {
    await t.close();
  }
});
