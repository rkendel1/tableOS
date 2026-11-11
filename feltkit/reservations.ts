/**
 * Reservations as operational workflows: availability, booking, modification, cancellation,
 * floor status (seated, completed, no-show) and the waitlist. Nothing is deleted; every change is
 * an audit event with before/after values.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, DateString, Clock, events, guests, reservations, RESERVATION_STATUS, tables, waitlist } from "./app.js";
import { book, resolveGuest, situation } from "./_booking.js";
import { canTransition, checkSlot, nextStatuses, slotsFor } from "./_availability.js";
import { record } from "./_audit.js";
import { BookResult, GuestInput, Slots } from "./_views.js";

export const availability = app.query({
  access: "reservations.read",
  args: { locationId: s.string(), date: DateString, partySize: s.integer({ minimum: 1, maximum: 100 }) },
  returns: Slots,
  capability: { name: "reservations.availability", description: "Bookable times for a party at a location on a date, computed from hours, special hours, booking rules, tables and existing reservations." },
  handler: async (ctx, { locationId, date, partySize }) => {
    const { sit } = await situation(ctx.db, locationId, date);
    return { date, partySize, open: !sit.hours.closed, hoursSource: sit.hours.source, ...(sit.hours.note ? { note: sit.hours.note } : {}), slots: slotsFor(sit, date, partySize) };
  },
});

export const create = app.mutation({
  access: "reservations.write",
  args: {
    locationId: s.string(), date: DateString, time: Clock, partySize: s.integer({ minimum: 1, maximum: 100 }),
    guest: GuestInput, specialRequests: s.optional(s.string({ maxLength: 500 })),
    idempotencyKey: s.string({ minLength: 8, maxLength: 120 }),
  },
  returns: BookResult,
  capability: {
    name: "reservations.create",
    description: "Book a table for a guest who has confirmed the time. Availability is re-checked when the booking commits; a refusal explains why (closed, no table, outside hours…). The same idempotencyKey never books twice. Agents: confirm the exact date, time and party size with the guest first.",
  },
  handler: (ctx, args) => {
    const who = ctx.auth.requirePrincipal();
    return book(ctx, { ...args, source: who.type === "agent" ? "agent" : "staff" });
  },
});

const ReservationRow = s.doc(reservations).omit("code", "idempotencyKey").extend({
  guestName: s.string(),
  guestPhone: s.optional(s.string()),
  guestEmail: s.optional(s.string()),
  tableLabel: s.string(),
  next: s.array(s.string()),
});

export const list = app.query({
  access: "reservations.read",
  args: { locationId: s.string(), date: DateString, includeInactive: s.optional(s.boolean()) },
  returns: s.array(ReservationRow),
  capability: { name: "reservations.list", description: "A location's reservations on a date, in time order, with the guest's name and contact, the table, and the statuses each can move to." },
  handler: async (ctx, { locationId, date, includeInactive }) => {
    const rows = (await ctx.db.find(reservations, { locationId, date })).filter((r) => includeInactive || r.status !== "cancelled");
    const [guestList, tableList] = await Promise.all([Promise.all(rows.map((r) => ctx.db.get(guests, r.guestId))), ctx.db.find(tables, { locationId })]);
    return rows
      .map((r, i) => {
        const { code: _c, idempotencyKey: _k, ...rest } = r;
        const g = guestList[i];
        return {
          ...rest,
          guestName: g?.name ?? "(unknown)",
          ...(g?.phone ? { guestPhone: g.phone } : {}),
          ...(g?.email ? { guestEmail: g.email } : {}),
          tableLabel: tableList.find((t) => t.id === r.tableId)?.label ?? "?",
          next: [...nextStatuses(r.status)],
        };
      })
      .sort((a, b) => a.startMin - b.startMin || a.tableLabel.localeCompare(b.tableLabel));
  },
});

const History = s.array(s.doc(events));

export const history = app.query({
  access: "audit.read",
  args: { id: s.string() },
  returns: History,
  capability: { name: "reservations.history", description: "Every change to a reservation: who made it, when, through which request, and the values before and after." },
  handler: (ctx, { id }) => ctx.db.find(events, { subjectType: "reservation", subjectId: id }, { orderBy: [{ field: "seq", direction: "asc" }] }),
});

export const modify = app.mutation({
  access: "reservations.write",
  args: {
    id: s.string(),
    date: s.optional(DateString), time: s.optional(Clock), partySize: s.optional(s.integer({ minimum: 1, maximum: 100 })),
    specialRequests: s.optional(s.string({ maxLength: 500 })),
  },
  returns: ReservationRow.pick("id", "date", "time", "partySize", "tableLabel", "status"),
  capability: { name: "reservations.modify", description: "Change a booked reservation's date, time, party size or special requests. The new time is checked against availability (its own table is released first); the change is refused if nothing fits." },
  handler: async (ctx, { id, ...change }) => {
    ctx.auth.requirePrincipal();
    const r = await ctx.db.get(reservations, id);
    if (!r) fail("NOT_FOUND", `No reservation ${id}.`);
    if (r.status !== "booked") fail("FAILED_PRECONDITION", `The reservation is ${r.status}; only a booked reservation can be changed.`);
    const date = change.date ?? r.date;
    const time = change.time ?? r.time;
    const partySize = change.partySize ?? r.partySize;
    const timing = date !== r.date || time !== r.time || partySize !== r.partySize;
    let tableId = r.tableId;
    let startMin = r.startMin;
    let endMin = r.endMin;
    if (timing) {
      const { sit } = await situation(ctx.db, r.locationId, date);
      const check = checkSlot(sit, date, time, partySize, r.id);
      if (!check.ok) fail("FAILED_PRECONDITION", check.message!, { reason: check.reason! });
      tableId = check.table!.id;
      startMin = check.startMin;
      endMin = check.endMin;
    }
    const specialRequests = change.specialRequests === undefined ? r.specialRequests : change.specialRequests.trim() || undefined;
    const { specialRequests: _old, ...rest } = r;
    const saved = await ctx.db.replace(reservations, id, { ...rest, date, time, partySize, tableId, startMin, endMin, ...(specialRequests ? { specialRequests } : {}), updatedAt: Date.now() });
    const table = await ctx.db.get(tables, tableId);
    await record(ctx, "reservation", id, "reservation.modified", {
      before: { date: r.date, time: r.time, partySize: r.partySize, tableId: r.tableId, specialRequests: r.specialRequests ?? null },
      after: { date, time, partySize, tableId, table: table?.label, specialRequests: specialRequests ?? null },
    });
    ctx.afterCommit.webhooks.emit("reservation.changed", { reservationId: id, date, time, partySize });
    return { id, date: saved.date, time: saved.time, partySize: saved.partySize, tableLabel: table?.label ?? "?", status: saved.status };
  },
});

export const cancel = app.mutation({
  access: "reservations.cancel",
  approval: "required",
  args: { id: s.string(), reason: s.string({ minLength: 3, maxLength: 300 }) },
  returns: s.object({ id: s.string(), status: s.string() }),
  capability: { name: "reservations.cancel", description: "Cancel a booked reservation, releasing its table. The record and its history are kept. An agent can only propose this; a person approves." },
  handler: async (ctx, { id, reason }) => {
    ctx.auth.requirePrincipal();
    const r = await ctx.db.get(reservations, id);
    if (!r) fail("NOT_FOUND", `No reservation ${id}.`);
    if (!canTransition(r.status, "cancelled")) fail("FAILED_PRECONDITION", `The reservation is ${r.status} and cannot be cancelled.`);
    await ctx.db.patch(reservations, id, { status: "cancelled", cancelReason: reason.trim(), updatedAt: Date.now() });
    await record(ctx, "reservation", id, "reservation.cancelled", { from: r.status, reason: reason.trim(), by: "staff" });
    ctx.afterCommit.webhooks.emit("reservation.cancelled", { reservationId: id, locationId: r.locationId, date: r.date, time: r.time });
    return { id, status: "cancelled" };
  },
});

export const setStatus = app.mutation({
  access: "reservations.floor",
  args: { id: s.string(), status: s.enum(["seated", "completed", "no_show"]) },
  returns: s.object({ id: s.string(), status: s.enum(RESERVATION_STATUS) }),
  capability: { name: "reservations.setstatus", description: "Record what happened on the floor: seated, completed, or no-show. Only valid transitions are accepted (booked → seated → completed; booked → no_show)." },
  handler: async (ctx, { id, status }) => {
    ctx.auth.requirePrincipal();
    const r = await ctx.db.get(reservations, id);
    if (!r) fail("NOT_FOUND", `No reservation ${id}.`);
    if (!canTransition(r.status, status)) fail("FAILED_PRECONDITION", `A ${r.status} reservation cannot become ${status}.`);
    await ctx.db.patch(reservations, id, { status, updatedAt: Date.now() });
    await record(ctx, "reservation", id, `reservation.${status}`, { from: r.status, to: status });
    return { id, status };
  },
});

// ---- Waitlist ------------------------------------------------------------------------------------

const WaitRow = s.doc(waitlist).extend({ guestName: s.string(), guestPhone: s.optional(s.string()), availableTimes: s.array(s.string()) });

export const waitlistList = app.query({
  access: "waitlist.read",
  args: { locationId: s.string(), date: DateString },
  returns: s.array(WaitRow),
  capability: { name: "waitlist.list", description: "Guests waiting for a table on a date, oldest first, each with the times that are bookable for their party right now." },
  handler: async (ctx, { locationId, date }) => {
    const rows = (await ctx.db.find(waitlist, { locationId, date }, { orderBy: [{ field: "createdAt", direction: "asc" }] })).filter((w) => w.status === "waiting");
    if (!rows.length) return [];
    const { sit } = await situation(ctx.db, locationId, date);
    const found = await Promise.all(rows.map((w) => ctx.db.get(guests, w.guestId)));
    return rows.map((w, i) => ({
      ...w,
      guestName: found[i]?.name ?? "(unknown)",
      ...(found[i]?.phone ? { guestPhone: found[i]!.phone } : {}),
      availableTimes: slotsFor(sit, date, w.partySize).filter((x) => x.available).map((x) => x.time),
    }));
  },
});

export const waitlistAdd = app.mutation({
  access: "waitlist.write",
  args: { locationId: s.string(), date: DateString, partySize: s.integer({ minimum: 1, maximum: 100 }), preferredTime: s.optional(Clock), guest: GuestInput, note: s.optional(s.string({ maxLength: 300 })) },
  returns: s.doc(waitlist),
  capability: { name: "waitlist.add", description: "Put a guest on the waitlist for a date." },
  handler: async (ctx, { guest, note, preferredTime, ...rest }) => {
    const who = ctx.auth.requirePrincipal();
    await situation(ctx.db, rest.locationId, rest.date);
    const guestId = await resolveGuest(ctx, guest);
    const id = await ctx.db.insert(waitlist, { ...rest, guestId, ...(preferredTime ? { preferredTime } : {}), ...(note?.trim() ? { note: note.trim() } : {}), status: "waiting", createdAt: Date.now(), createdBy: who.id });
    await record(ctx, "waitlist", id, "waitlist.added", { date: rest.date, partySize: rest.partySize, guestId });
    return (await ctx.db.get(waitlist, id))!;
  },
});

export const waitlistBook = app.mutation({
  access: "waitlist.write",
  args: { id: s.string(), time: Clock, idempotencyKey: s.string({ minLength: 8, maxLength: 120 }) },
  returns: BookResult,
  capability: { name: "waitlist.book", description: "Book a waiting guest into a time that is now available. Uses the same availability checks as any booking." },
  handler: async (ctx, { id, time, idempotencyKey }) => {
    ctx.auth.requirePrincipal();
    const w = await ctx.db.get(waitlist, id);
    if (!w) fail("NOT_FOUND", `No waitlist entry ${id}.`);
    if (w.status !== "waiting") fail("FAILED_PRECONDITION", `The waitlist entry is ${w.status}.`);
    const g = await ctx.db.get(guests, w.guestId);
    const result = await book(ctx, { locationId: w.locationId, date: w.date, time, partySize: w.partySize, guest: { name: g!.name, ...(g!.email ? { email: g!.email } : {}), ...(g!.phone ? { phone: g!.phone } : {}) }, idempotencyKey, source: "waitlist" });
    await ctx.db.patch(waitlist, id, { status: "booked", reservationId: result.reservationId });
    await record(ctx, "waitlist", id, "waitlist.booked", { reservationId: result.reservationId, time });
    return result;
  },
});

export const waitlistRemove = app.mutation({
  access: "waitlist.write",
  args: { id: s.string(), note: s.optional(s.string({ maxLength: 300 })) },
  returns: s.object({ id: s.string(), status: s.string() }),
  capability: { name: "waitlist.remove", description: "Take a guest off the waitlist (they left, or were seated as a walk-in)." },
  handler: async (ctx, { id, note }) => {
    ctx.auth.requirePrincipal();
    const w = await ctx.db.get(waitlist, id);
    if (!w) fail("NOT_FOUND", `No waitlist entry ${id}.`);
    if (w.status !== "waiting") fail("FAILED_PRECONDITION", `The waitlist entry is ${w.status}.`);
    await ctx.db.patch(waitlist, id, { status: "removed" });
    await record(ctx, "waitlist", id, "waitlist.removed", { note: note?.trim() ?? null });
    return { id, status: "removed" };
  },
});
