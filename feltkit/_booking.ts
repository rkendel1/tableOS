/**
 * The booking workflow, shared by every way a reservation is made (staff, agent, public site,
 * waitlist), so all of them apply the same rules.
 *
 * Correctness comes from FeltDB: the mutation reads the location's reservations for the date and
 * then inserts. FeltDB validates every read at commit — including rows that appeared since — so
 * two simultaneous bookings that both chose the last table cannot both commit: one gets CONFLICT
 * (retryable) and nothing of it is written. The idempotency key is a unique constraint, so a
 * repeated request returns the original booking instead of a second one.
 */
import { fail } from "@feltdb/feltkit";
import type { MutationCtx, QueryCtx } from "@feltdb/feltkit";
import { guests, hoursExceptions, locations, reservations, tables, weeklyHours } from "./app.js";
import { checkSlot, hoursOn, type Situation } from "./_availability.js";
import { actorOf, record } from "./_audit.js";
import { announce } from "./_announce.js";
import { emailKey, looksLikeEmail, phoneKey } from "./_rules.js";
import { isValidDate } from "./_time.js";

export interface GuestInput { name: string; email?: string; phone?: string }

export interface BookInput {
  locationId: string;
  date: string;
  time: string;
  partySize: number;
  guest: GuestInput;
  specialRequests?: string;
  idempotencyKey: string;
  source: "staff" | "public" | "agent" | "waitlist";
}

type Db = QueryCtx["db"];

export async function situation(db: Db, locationId: string, date: string, nowMs = Date.now()): Promise<{ location: NonNullable<Awaited<ReturnType<Db["get"]>>> & { name: string; timeZone: string; active: boolean }; sit: Situation }> {
  if (!isValidDate(date)) fail("INVALID_ARGUMENT", `${date} is not a date (YYYY-MM-DD).`);
  const location = await db.get(locations, locationId);
  if (!location) fail("NOT_FOUND", `No location ${locationId}.`);
  const [weekly, exception, tableList, bookings] = await Promise.all([
    db.find(weeklyHours, { locationId }),
    db.find(hoursExceptions, { locationId, date }),
    db.find(tables, { locationId }),
    db.find(reservations, { locationId, date }),
  ]);
  return {
    location,
    sit: {
      rules: location.active ? location.rules : { ...location.rules, accepting: false },
      timeZone: location.timeZone,
      hours: hoursOn(date, weekly, exception[0]),
      tables: tableList,
      bookings,
      nowMs,
    },
  };
}

/** Find the guest by e-mail or phone, or create one. Missing contact details are filled in, never overwritten. */
export async function resolveGuest(ctx: MutationCtx, input: GuestInput): Promise<string> {
  const name = input.name.trim();
  if (!name) fail("INVALID_ARGUMENT", "The guest's name is required.");
  const email = input.email?.trim() || undefined;
  if (email && !looksLikeEmail(email)) fail("INVALID_ARGUMENT", `${email} is not an e-mail address.`);
  const ek = emailKey(email);
  const pk = phoneKey(input.phone);
  if (!ek && !pk) fail("INVALID_ARGUMENT", "An e-mail address or a phone number is required to reach the guest.");
  const byEmail = ek ? (await ctx.db.find(guests, { emailKey: ek }))[0] : undefined;
  const byPhone = !byEmail && pk ? (await ctx.db.find(guests, { phoneKey: pk }))[0] : undefined;
  const found = byEmail ?? byPhone;
  if (found) {
    const fill: Record<string, string> = {};
    if (ek && !found.emailKey) { fill.email = email!; fill.emailKey = ek; }
    if (pk && !found.phoneKey && !(await ctx.db.find(guests, { phoneKey: pk })).length) { fill.phone = input.phone!.trim(); fill.phoneKey = pk; }
    if (Object.keys(fill).length) {
      await ctx.db.patch(guests, found.id, fill);
      await record(ctx, "guest", found.id, "guest.contact.added", { fields: Object.keys(fill).filter((k) => !k.endsWith("Key")) });
    }
    return found.id;
  }
  const id = await ctx.db.insert(guests, {
    name,
    ...(email ? { email, emailKey: ek } : {}),
    ...(pk ? { phone: input.phone!.trim(), phoneKey: pk } : {}),
    preferences: [],
    tags: [],
    createdAt: Date.now(),
  });
  await record(ctx, "guest", id, "guest.created", { via: "booking" });
  return id;
}

export interface BookResult {
  reservationId: string;
  code: string;
  status: string;
  date: string;
  time: string;
  partySize: number;
  locationName: string;
  tableLabel: string;
  replayed: boolean;
}

export async function book(ctx: MutationCtx, input: BookInput): Promise<BookResult> {
  // Idempotency: the same key returns the original booking (and refuses a different request under it).
  const prior = (await ctx.db.find(reservations, { idempotencyKey: input.idempotencyKey }))[0];
  if (prior) {
    const same = prior.locationId === input.locationId && prior.date === input.date && prior.time === input.time && prior.partySize === input.partySize;
    if (!same) fail("FAILED_PRECONDITION", "This idempotency key was already used for a different booking.");
    const [loc, table] = await Promise.all([ctx.db.get(locations, prior.locationId), ctx.db.get(tables, prior.tableId)]);
    return { reservationId: prior.id, code: prior.code, status: prior.status, date: prior.date, time: prior.time, partySize: prior.partySize, locationName: loc?.name ?? "", tableLabel: table?.label ?? "", replayed: true };
  }

  const { location, sit } = await situation(ctx.db, input.locationId, input.date);
  const check = checkSlot(sit, input.date, input.time, input.partySize);
  if (!check.ok) fail("FAILED_PRECONDITION", check.message!, { reason: check.reason! });

  const guestId = await resolveGuest(ctx, input.guest);
  const who = actorOf(ctx);
  const now = Date.now();
  const code = await ctx.crypto.token(16);
  const id = await ctx.db.insert(reservations, {
    locationId: input.locationId,
    guestId,
    tableId: check.table!.id,
    partySize: input.partySize,
    date: input.date,
    time: input.time,
    startMin: check.startMin,
    endMin: check.endMin,
    status: "booked",
    source: input.source,
    ...(input.specialRequests?.trim() ? { specialRequests: input.specialRequests.trim() } : {}),
    idempotencyKey: input.idempotencyKey,
    code,
    createdAt: now,
    createdBy: who.id,
    updatedAt: now,
  });
  await record(ctx, "reservation", id, "reservation.booked", { source: input.source, date: input.date, time: input.time, partySize: input.partySize, table: check.table!.label, guestId });
  announce(ctx, "reservation.booked", { reservationId: id, locationId: input.locationId, date: input.date, time: input.time, partySize: input.partySize, source: input.source });
  return { reservationId: id, code, status: "booked", date: input.date, time: input.time, partySize: input.partySize, locationName: location.name, tableLabel: check.table!.label, replayed: false };
}
