/**
 * The public restaurant experience: a projection of the canonical records, served by the same
 * runtime, with `access: "public"`. Nothing here is a copy: the site reads the records managers
 * edit, so a menu or hours change is visible on the next read (live queries re-run).
 *
 * Privacy: no function here returns another guest's data. A guest sees their own booking only by
 * presenting the bearer code they were given when they booked.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, DateString, Clock, hoursExceptions, inquiries, locations, menuItems, menus, menuSections, messages, reservations, restaurant, weeklyHours, ALLERGENS, DIETARY, Period } from "./app.js";
import { book, resolveGuest, situation } from "./_booking.js";
import { canTransition, hoursOn, slotsFor } from "./_availability.js";
import { record } from "./_audit.js";
import { announce } from "./_announce.js";
import { categorizeInquiry } from "./_rules.js";
import { addDays, localNow } from "./_time.js";
import { BookResult, Slots } from "./_views.js";
import type { QueryCtx } from "@feltdb/feltkit";

const PublicLocation = s.object({
  id: s.string(), slug: s.string(), name: s.string(), address: s.string(), city: s.string(), phone: s.optional(s.string()), timeZone: s.string(),
  acceptingReservations: s.boolean(), maxPartySize: s.integer(), maxDaysAhead: s.integer(),
  today: s.string(),
  week: s.array(s.object({ date: s.string(), weekday: s.integer(), closed: s.boolean(), special: s.boolean(), note: s.optional(s.string()), periods: s.array(Period) })),
  upcomingExceptions: s.array(s.object({ date: s.string(), closed: s.boolean(), periods: s.array(Period), note: s.optional(s.string()) })),
});

export const info = app.query({
  access: "public",
  returns: s.object({
    restaurant: s.nullable(s.object({ name: s.string(), tagline: s.optional(s.string()), description: s.optional(s.string()), cuisine: s.optional(s.string()), phone: s.optional(s.string()), email: s.optional(s.string()), website: s.optional(s.string()) })),
    locations: s.array(PublicLocation),
  }),
  capability: { name: "site.info", description: "Public restaurant information: identity, contact, each active location with this week's hours and upcoming special hours." },
  handler: async (ctx) => {
    const r = (await ctx.db.find(restaurant, { key: "main" }))[0];
    const locs = (await ctx.db.find(locations, { active: true }, { orderBy: [{ field: "name", direction: "asc" }] }));
    const out = [];
    for (const l of locs) {
      const [weekly, exceptions] = await Promise.all([ctx.db.find(weeklyHours, { locationId: l.id }), ctx.db.find(hoursExceptions, { locationId: l.id })]);
      const today = localNow(l.timeZone, Date.now()).date;
      const week = Array.from({ length: 7 }, (_, i) => {
        const date = addDays(today, i);
        const h = hoursOn(date, weekly, exceptions.find((e) => e.date === date));
        return { date, weekday: new Date(date + "T00:00:00Z").getUTCDay(), closed: h.closed, special: h.source === "exception", ...(h.note ? { note: h.note } : {}), periods: h.periods };
      });
      out.push({
        id: l.id, slug: l.slug, name: l.name, address: l.address, city: l.city, ...(l.phone ? { phone: l.phone } : {}), timeZone: l.timeZone,
        acceptingReservations: l.rules.accepting, maxPartySize: l.rules.maxPartySize, maxDaysAhead: l.rules.maxDaysAhead,
        today, week,
        upcomingExceptions: exceptions.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10)
          .map((e) => ({ date: e.date, closed: e.closed, periods: e.periods, ...(e.note ? { note: e.note } : {}) })),
      });
    }
    const pick = r ? {
      name: r.name,
      ...(r.tagline ? { tagline: r.tagline } : {}), ...(r.description ? { description: r.description } : {}), ...(r.cuisine ? { cuisine: r.cuisine } : {}),
      ...(r.phone ? { phone: r.phone } : {}), ...(r.email ? { email: r.email } : {}), ...(r.website ? { website: r.website } : {}),
    } : null;
    return { restaurant: pick, locations: out };
  },
});

export const menu = app.query({
  access: "public",
  args: { locationId: s.optional(s.string()) },
  returns: s.array(s.object({
    id: s.string(), name: s.string(), description: s.optional(s.string()),
    sections: s.array(s.object({
      id: s.string(), name: s.string(),
      items: s.array(s.object({
        id: s.string(), name: s.string(), description: s.optional(s.string()), priceCents: s.integer(),
        dietary: s.array(s.enum(DIETARY)), allergens: s.nullable(s.array(s.enum(ALLERGENS))), available: s.boolean(),
      })),
    })),
  })),
  capability: { name: "site.menu", description: "The published menus (optionally for one location) with prices, dietary tags, allergens (null = not declared; ask staff) and whether each item is available today." },
  handler: async (ctx, { locationId }) => {
    const [all, sections, items] = await Promise.all([
      ctx.db.find(menus, { active: true }, { orderBy: [{ field: "position", direction: "asc" }] }),
      ctx.db.find(menuSections, {}, { orderBy: [{ field: "position", direction: "asc" }] }),
      ctx.db.find(menuItems, {}, { orderBy: [{ field: "position", direction: "asc" }] }),
    ]);
    return all
      .filter((m) => !locationId || m.locationIds.length === 0 || m.locationIds.includes(locationId))
      .map((m) => ({
        id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}),
        sections: sections.filter((x) => x.menuId === m.id).map((x) => ({
          id: x.id, name: x.name,
          items: items.filter((i) => i.sectionId === x.id).map((i) => ({
            id: i.id, name: i.name, ...(i.description ? { description: i.description } : {}), priceCents: i.priceCents,
            dietary: i.dietary, allergens: i.allergens ?? null, available: i.available,
          })),
        })).filter((x) => x.items.length > 0),
      }));
  },
});

export const availability = app.query({
  access: "public",
  args: { locationId: s.string(), date: DateString, partySize: s.integer({ minimum: 1, maximum: 100 }) },
  returns: Slots,
  capability: { name: "site.availability", description: "Bookable times for a party on a date (the same rules staff bookings use)." },
  handler: async (ctx, { locationId, date, partySize }) => {
    const { location, sit } = await situation(ctx.db, locationId, date);
    if (!location.active) fail("NOT_FOUND", `No location ${locationId}.`);
    return { date, partySize, open: !sit.hours.closed, hoursSource: sit.hours.source, ...(sit.hours.note ? { note: sit.hours.note } : {}), slots: slotsFor(sit, date, partySize) };
  },
});

export const bookTable = app.mutation({
  access: "public",
  args: {
    locationId: s.string(), date: DateString, time: Clock, partySize: s.integer({ minimum: 1, maximum: 100 }),
    name: s.string({ minLength: 1, maxLength: 120 }), email: s.string({ minLength: 3, maxLength: 200 }), phone: s.optional(s.string({ maxLength: 40 })),
    specialRequests: s.optional(s.string({ maxLength: 500 })),
    idempotencyKey: s.string({ minLength: 8, maxLength: 120 }),
  },
  returns: BookResult,
  capability: { name: "site.book", description: "Book a table from the public site. Availability is checked when the booking commits. Returns a confirmation code the guest keeps to view or cancel." },
  handler: (ctx, { name, email, phone, ...rest }) => book(ctx, { ...rest, guest: { name, email, ...(phone ? { phone } : {}) }, source: "public" }),
});

const MyBooking = s.object({ reservationId: s.string(), status: s.string(), date: s.string(), time: s.string(), partySize: s.integer(), locationName: s.string(), specialRequests: s.optional(s.string()) });

async function byCode(db: QueryCtx["db"], code: string) {
  const r = (await db.find(reservations, { code }))[0];
  // Unknown and malformed codes answer the same way.
  if (!r) fail("NOT_FOUND", "No reservation with that code.");
  return r;
}

export const myBooking = app.query({
  access: "public",
  args: { code: s.string({ minLength: 10, maxLength: 64 }) },
  returns: MyBooking,
  capability: { name: "site.mybooking", description: "A guest's own reservation, by the confirmation code they were given." },
  handler: async (ctx, { code }) => {
    const r = await byCode(ctx.db, code);
    const loc = await ctx.db.get(locations, r.locationId);
    return { reservationId: r.id, status: r.status, date: r.date, time: r.time, partySize: r.partySize, locationName: loc?.name ?? "", ...(r.specialRequests ? { specialRequests: r.specialRequests } : {}) };
  },
});

export const cancelMyBooking = app.mutation({
  access: "public",
  args: { code: s.string({ minLength: 10, maxLength: 64 }) },
  returns: s.object({ status: s.string() }),
  capability: { name: "site.cancelmybooking", description: "A guest cancels their own booking with its confirmation code." },
  handler: async (ctx, { code }) => {
    const r = await byCode(ctx.db, code);
    if (r.status === "cancelled") return { status: "cancelled" };
    if (!canTransition(r.status, "cancelled")) fail("FAILED_PRECONDITION", `This reservation is ${r.status.replace("_", " ")} and can no longer be cancelled online.`);
    await ctx.db.patch(reservations, r.id, { status: "cancelled", cancelReason: "Cancelled by the guest online", updatedAt: Date.now() });
    await record(ctx, "reservation", r.id, "reservation.cancelled", { from: r.status, reason: "guest", by: "guest" });
    announce(ctx, "reservation.cancelled", { reservationId: r.id, locationId: r.locationId, date: r.date, time: r.time });
    return { status: "cancelled" };
  },
});

export const contact = app.mutation({
  access: "public",
  args: {
    name: s.string({ minLength: 1, maxLength: 120 }), email: s.string({ minLength: 3, maxLength: 200 }), phone: s.optional(s.string({ maxLength: 40 })),
    locationId: s.optional(s.string()), subject: s.string({ minLength: 1, maxLength: 200 }), message: s.string({ minLength: 1, maxLength: 8000 }),
  },
  returns: s.object({ inquiryId: s.string(), received: s.boolean() }),
  capability: { name: "site.contact", description: "Send the restaurant a question or request from the public site." },
  handler: async (ctx, { name, email, phone, locationId, subject, message }) => {
    if (locationId && !(await ctx.db.get(locations, locationId))) fail("NOT_FOUND", `No location ${locationId}.`);
    const guestId = await resolveGuest(ctx, { name, email, ...(phone ? { phone } : {}) });
    const now = Date.now();
    const category = categorizeInquiry(`${subject}\n${message}`);
    const inquiryId = await ctx.db.insert(inquiries, { guestId, ...(locationId ? { locationId } : {}), subject: subject.trim(), category, categorizedBy: "rules", channel: "web", status: "open", createdAt: now, lastMessageAt: now });
    await ctx.db.insert(messages, { inquiryId, direction: "inbound", body: message.trim(), status: "received", author: guestId, authorType: "guest", at: now });
    await record(ctx, "inquiry", inquiryId, "inquiry.received", { channel: "web", category, guestId });
    announce(ctx, "inquiry.received", { inquiryId, category });
    return { inquiryId, received: true };
  },
});
