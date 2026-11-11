/**
 * Canonical restaurant information: identity, locations, booking rules, hours and tables.
 *
 * Hours changes are `approval: "required"`: a manager changes them directly; an agent can only
 * propose, and the change runs after a person who holds hours.write approves it (FeltKit's agent
 * lifecycle records the proposal, the approver and the execution).
 */
import { fail, s } from "@feltdb/feltkit";
import { app, hoursExceptions, locations, Period, ReservationRules, restaurant, tables, weeklyHours, DateString } from "./app.js";
import { record } from "./_audit.js";
import { announce } from "./_announce.js";
import { DEFAULT_RULES } from "./_defaults.js";
import { periodProblems } from "./_availability.js";
import { isValidDate, isValidTimeZone } from "./_time.js";

const RestaurantView = s.doc(restaurant);
const LocationView = s.doc(locations);

async function principalId(ctx: { auth: { requirePrincipal(): { id: string } } }) {
  return ctx.auth.requirePrincipal().id;
}

// ---- Restaurant ----------------------------------------------------------------------------------

export const get = app.query({
  access: "restaurant.read",
  returns: s.nullable(RestaurantView),
  capability: { name: "restaurant.get", description: "The restaurant's canonical identity and contact information." },
  handler: async (ctx) => (await ctx.db.find(restaurant, { key: "main" }))[0] ?? null,
});

export const update = app.mutation({
  access: "restaurant.write",
  args: {
    name: s.string({ minLength: 1, maxLength: 120 }),
    tagline: s.optional(s.string({ maxLength: 200 })),
    description: s.optional(s.string({ maxLength: 4000 })),
    cuisine: s.optional(s.string({ maxLength: 120 })),
    phone: s.optional(s.string({ maxLength: 40 })),
    email: s.optional(s.string({ maxLength: 200 })),
    website: s.optional(s.string({ maxLength: 300 })),
  },
  returns: RestaurantView,
  capability: { name: "restaurant.update", description: "Set the restaurant's name, description and contact details. Published to the public site immediately and announced to subscribed systems (restaurant.changed)." },
  handler: async (ctx, input) => {
    const who = await principalId(ctx);
    const existing = (await ctx.db.find(restaurant, { key: "main" }))[0];
    const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, (v as string).trim()]));
    const fields = { key: "main" as const, ...(clean as { name: string }), updatedAt: Date.now(), updatedBy: who };
    const saved = existing ? await ctx.db.replace(restaurant, existing.id, fields) : await ctx.db.get(restaurant, await ctx.db.insert(restaurant, fields));
    const changed = existing ? Object.keys(fields).filter((k) => k !== "updatedAt" && (existing as Record<string, unknown>)[k] !== (fields as Record<string, unknown>)[k]) : Object.keys(clean);
    await record(ctx, "restaurant", saved!.id, existing ? "restaurant.updated" : "restaurant.created", { changed });
    announce(ctx, "restaurant.changed", { restaurantId: saved!.id, changed });
    return saved!;
  },
});

// ---- Locations -----------------------------------------------------------------------------------


export const listLocations = app.query({
  access: "restaurant.read",
  returns: s.array(LocationView),
  capability: { name: "locations.list", description: "Every location with its address, time zone and reservation rules." },
  handler: (ctx) => ctx.db.find(locations, {}, { orderBy: [{ field: "name", direction: "asc" }] }),
});

const LocationInput = {
  slug: s.string({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
  name: s.string({ minLength: 1, maxLength: 120 }),
  address: s.string({ minLength: 1, maxLength: 300 }),
  city: s.string({ minLength: 1, maxLength: 120 }),
  phone: s.optional(s.string({ maxLength: 40 })),
  timeZone: s.string({ minLength: 1, maxLength: 64 }),
};

export const createLocation = app.mutation({
  access: "restaurant.write",
  args: { ...LocationInput, rules: s.optional(ReservationRules) },
  returns: LocationView,
  capability: { name: "locations.create", description: "Add a location. It starts closed every day until hours are set." },
  handler: async (ctx, { rules, phone, ...input }) => {
    const who = await principalId(ctx);
    if (!isValidTimeZone(input.timeZone)) fail("INVALID_ARGUMENT", `Unknown time zone "${input.timeZone}". Use an IANA name such as America/New_York.`);
    const r = rules ?? DEFAULT_RULES;
    if (r.minPartySize > r.maxPartySize) fail("INVALID_ARGUMENT", "The smallest party size is larger than the largest.");
    const now = Date.now();
    const id = await ctx.db.insert(locations, { ...input, ...(phone?.trim() ? { phone: phone.trim() } : {}), active: true, rules: r, createdAt: now, updatedAt: now, updatedBy: who });
    await record(ctx, "location", id, "location.created", { slug: input.slug, name: input.name });
    return (await ctx.db.get(locations, id))!;
  },
});

export const updateLocation = app.mutation({
  access: "restaurant.write",
  args: { id: s.string(), ...LocationInput, active: s.boolean() },
  returns: LocationView,
  capability: { name: "locations.update", description: "Change a location's details, time zone, or whether it is shown and bookable (active)." },
  handler: async (ctx, { id, phone, ...input }) => {
    const who = await principalId(ctx);
    const existing = await ctx.db.get(locations, id);
    if (!existing) fail("NOT_FOUND", `No location ${id}.`);
    if (!isValidTimeZone(input.timeZone)) fail("INVALID_ARGUMENT", `Unknown time zone "${input.timeZone}".`);
    const { phone: _old, ...rest } = existing;
    const saved = await ctx.db.replace(locations, id, { ...rest, ...input, ...(phone?.trim() ? { phone: phone.trim() } : {}), updatedAt: Date.now(), updatedBy: who });
    await record(ctx, "location", id, "location.updated", { before: { name: existing.name, slug: existing.slug, active: existing.active, timeZone: existing.timeZone }, after: { name: saved.name, slug: saved.slug, active: saved.active, timeZone: saved.timeZone } });
    announce(ctx, "restaurant.changed", { locationId: id });
    return saved;
  },
});

export const setRules = app.mutation({
  access: "restaurant.write",
  args: { locationId: s.string(), rules: ReservationRules },
  returns: LocationView,
  capability: { name: "locations.setrules", description: "Set a location's reservation rules: slot interval, duration, party sizes, lead time, booking window, last seating. Existing reservations are kept." },
  handler: async (ctx, { locationId, rules }) => {
    const who = await principalId(ctx);
    const existing = await ctx.db.get(locations, locationId);
    if (!existing) fail("NOT_FOUND", `No location ${locationId}.`);
    if (rules.minPartySize > rules.maxPartySize) fail("INVALID_ARGUMENT", "The smallest party size is larger than the largest.");
    const saved = await ctx.db.patch(locations, locationId, { rules, updatedAt: Date.now(), updatedBy: who });
    await record(ctx, "location", locationId, "rules.updated", { before: existing.rules, after: rules });
    return saved;
  },
});

// ---- Hours ---------------------------------------------------------------------------------------

const Hours = s.object({
  weekly: s.array(s.doc(weeklyHours)),
  exceptions: s.array(s.doc(hoursExceptions)),
});

export const hours = app.query({
  access: "hours.read",
  args: { locationId: s.string() },
  returns: Hours,
  capability: { name: "hours.get", description: "A location's weekly hours (weekday 0 = Sunday) and its special hours and closures." },
  handler: async (ctx, { locationId }) => ({
    weekly: await ctx.db.find(weeklyHours, { locationId }, { orderBy: [{ field: "weekday", direction: "asc" }] }),
    exceptions: await ctx.db.find(hoursExceptions, { locationId }, { orderBy: [{ field: "date", direction: "asc" }] }),
  }),
});

function checkPeriods(periods: Array<{ open: string; close: string }>) {
  const problems = periodProblems(periods);
  if (problems.length) fail("INVALID_ARGUMENT", problems.join(" "));
}

export const setWeekly = app.mutation({
  access: "hours.write",
  approval: "required",
  args: { locationId: s.string(), weekday: s.integer({ minimum: 0, maximum: 6 }), periods: s.array(Period) },
  returns: s.doc(weeklyHours),
  capability: { name: "hours.setweekly", description: "Set a location's regular opening periods for one weekday (0 = Sunday; empty = closed). Changes what guests can book and the public site." },
  handler: async (ctx, { locationId, weekday, periods }) => {
    const who = await principalId(ctx);
    if (!(await ctx.db.get(locations, locationId))) fail("NOT_FOUND", `No location ${locationId}.`);
    checkPeriods(periods);
    const existing = (await ctx.db.find(weeklyHours, { locationId, weekday }))[0];
    const fields = { locationId, weekday, periods, updatedAt: Date.now(), updatedBy: who };
    const saved = existing ? await ctx.db.replace(weeklyHours, existing.id, fields) : (await ctx.db.get(weeklyHours, await ctx.db.insert(weeklyHours, fields)))!;
    await record(ctx, "hours", locationId, "hours.weekly.set", { weekday, before: existing?.periods ?? [], after: periods });
    announce(ctx, "hours.changed", { locationId, weekday });
    return saved;
  },
});

export const setException = app.mutation({
  access: "hours.write",
  approval: "required",
  args: { locationId: s.string(), date: DateString, closed: s.boolean(), periods: s.array(Period), note: s.optional(s.string({ maxLength: 200 })) },
  returns: s.doc(hoursExceptions),
  capability: { name: "hours.setexception", description: "Set special hours or a closure on one date at a location; it replaces the weekly hours that day. Existing reservations are not cancelled: check reservations.list for that date." },
  handler: async (ctx, { locationId, date, closed, periods, note }) => {
    const who = await principalId(ctx);
    if (!(await ctx.db.get(locations, locationId))) fail("NOT_FOUND", `No location ${locationId}.`);
    if (!isValidDate(date)) fail("INVALID_ARGUMENT", `${date} is not a date.`);
    if (!closed) {
      if (!periods.length) fail("INVALID_ARGUMENT", "Give the opening periods, or mark the date closed.");
      checkPeriods(periods);
    }
    const existing = (await ctx.db.find(hoursExceptions, { locationId, date }))[0];
    const fields = { locationId, date, closed, periods: closed ? [] : periods, ...(note?.trim() ? { note: note.trim() } : {}), updatedAt: Date.now(), updatedBy: who };
    const saved = existing ? await ctx.db.replace(hoursExceptions, existing.id, fields) : (await ctx.db.get(hoursExceptions, await ctx.db.insert(hoursExceptions, fields)))!;
    await record(ctx, "hours", locationId, "hours.exception.set", { date, closed, periods: fields.periods, note: fields.note ?? null, replaced: existing ? { closed: existing.closed, periods: existing.periods } : null });
    announce(ctx, "hours.changed", { locationId, date });
    return saved;
  },
});

export const removeException = app.mutation({
  access: "hours.write",
  approval: "required",
  args: { locationId: s.string(), date: DateString },
  returns: s.object({ removed: s.boolean() }),
  capability: { name: "hours.removeexception", description: "Remove a date's special hours, so the weekly hours apply again." },
  handler: async (ctx, { locationId, date }) => {
    const existing = (await ctx.db.find(hoursExceptions, { locationId, date }))[0];
    if (!existing) return { removed: false };
    await ctx.db.delete(hoursExceptions, existing.id);
    await record(ctx, "hours", locationId, "hours.exception.removed", { date, was: { closed: existing.closed, periods: existing.periods, note: existing.note ?? null } });
    announce(ctx, "hours.changed", { locationId, date });
    return { removed: true };
  },
});

// ---- Tables --------------------------------------------------------------------------------------

export const listTables = app.query({
  access: "restaurant.read",
  args: { locationId: s.string() },
  returns: s.array(s.doc(tables)),
  capability: { name: "tables.list", description: "A location's tables and the party sizes each seats." },
  handler: (ctx, { locationId }) => ctx.db.find(tables, { locationId }, { orderBy: [{ field: "label", direction: "asc" }] }),
});

export const saveTable = app.mutation({
  access: "tables.write",
  args: {
    id: s.optional(s.string()),
    locationId: s.string(),
    label: s.string({ minLength: 1, maxLength: 20 }),
    minParty: s.integer({ minimum: 1, maximum: 100 }),
    maxParty: s.integer({ minimum: 1, maximum: 100 }),
    active: s.boolean(),
  },
  returns: s.doc(tables),
  capability: { name: "tables.save", description: "Add a table or change one (label, party sizes, active). Deactivating a table keeps its existing reservations." },
  handler: async (ctx, { id, ...fields }) => {
    await principalId(ctx);
    if (fields.minParty > fields.maxParty) fail("INVALID_ARGUMENT", "A table's minimum party is larger than its maximum.");
    if (!(await ctx.db.get(locations, fields.locationId))) fail("NOT_FOUND", `No location ${fields.locationId}.`);
    if (id) {
      const existing = await ctx.db.get(tables, id);
      if (!existing || existing.locationId !== fields.locationId) fail("NOT_FOUND", `No table ${id} at this location.`);
      const saved = await ctx.db.replace(tables, id, fields);
      await record(ctx, "table", id, "table.updated", { before: { label: existing.label, minParty: existing.minParty, maxParty: existing.maxParty, active: existing.active }, after: fields });
      return saved;
    }
    const newId = await ctx.db.insert(tables, fields);
    await record(ctx, "table", newId, "table.created", fields);
    return (await ctx.db.get(tables, newId))!;
  },
});
