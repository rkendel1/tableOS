/**
 * Stage 3: reservations are real workflows. Capacity holds, simultaneous bookings cannot overbook,
 * retries do not duplicate, changes keep their history, and the waitlist books through the same rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { restaurantFixture, AGENT } from "./fixture.js";

const guest = (i: number) => ({ name: `Guest ${i}`, email: `guest${i}@example.com` });

test("a booking takes the smallest fitting table and capacity cannot be exceeded", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const sam = t.as("sam");
    const a = await sam.mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(1), idempotencyKey: key() });
    assert.deepEqual([a.status, a.tableLabel, a.replayed], ["booked", "T1", false]);
    const b = await sam.mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(2), idempotencyKey: key() });
    assert.equal(b.tableLabel, "T2", "T1 is taken, the next table that seats 2");
    // T3 seats 4–6: a party of 2 cannot use it, so 19:00 is full for two.
    await assert.rejects(sam.mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(3), idempotencyKey: key() }), (e: any) => e.code === "FAILED_PRECONDITION" && /No table/.test(e.message));
    // Overlap: 20:00 overlaps a 90-minute 19:00 booking; 20:30 does not.
    await assert.rejects(sam.mutation(api.reservations.create, { locationId, date, time: "20:00", partySize: 2, guest: guest(4), idempotencyKey: key() }), { code: "FAILED_PRECONDITION" });
    assert.equal((await sam.mutation(api.reservations.create, { locationId, date, time: "20:30", partySize: 2, guest: guest(5), idempotencyKey: key() })).tableLabel, "T1");
    const slots = await sam.query(api.reservations.availability, { locationId, date, partySize: 2 });
    assert.equal(slots.slots.find((s) => s.time === "19:30")!.available, false);
    assert.equal(slots.slots.find((s) => s.time === "17:00")!.available, true);
    await assert.rejects(sam.mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 7, guest: guest(6), idempotencyKey: key() }), { code: "FAILED_PRECONDITION" }, "no table seats 7");
  } finally {
    await t.close();
  }
});

test("simultaneous bookings for the last table: exactly one commits, the other is refused and writes nothing", async () => {
  const { t, locationId, date, key } = await restaurantFixture({ tables: [["T1", 1, 4]] });
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => t.as(i % 2 ? "sam" : "maria").mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(10 + i), idempotencyKey: key() })),
    );
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const refused = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
    assert.equal(ok.length, 1, `exactly one booking commits: ${JSON.stringify(attempts.map((a) => a.status === "fulfilled" ? "ok" : (a.reason as any).code))}`);
    for (const r of refused) assert.ok(["CONFLICT", "FAILED_PRECONDITION"].includes(r.reason.code), r.reason.code);
    // The attempts really overlapped: FeltDB refused at commit (a read changed), not the availability check.
    assert.ok(refused.some((r) => r.reason.code === "CONFLICT" && r.reason.retryable === true), "at least one refusal came from FeltDB's commit-time validation");
    const rows = await t.as("lee").query(api.reservations.list, { locationId, date });
    assert.equal(rows.length, 1, "no overbooking was written");
    const events = await t.as("maria").query(api.insights.audit, { subjectType: "reservation" });
    assert.equal(events.filter((e) => e.type === "reservation.booked").length, 1, "and no audit event for a booking that did not commit");
  } finally {
    await t.close();
  }
});

test("simultaneous bookings for different tables can all succeed with a retry on CONFLICT", async () => {
  const { t, locationId, date, key } = await restaurantFixture({ tables: [["T1", 1, 4], ["T2", 1, 4], ["T3", 1, 4]] });
  try {
    const bookWithRetry = async (i: number) => {
      const k = key();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await t.as("sam").mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(20 + i), idempotencyKey: k });
        } catch (e: any) {
          if (e.code !== "CONFLICT") throw e;
        }
      }
      throw new Error("still conflicting");
    };
    const results = await Promise.all([0, 1, 2].map(bookWithRetry));
    assert.deepEqual(results.map((r) => r.tableLabel).sort(), ["T1", "T2", "T3"]);
    await assert.rejects(t.as("sam").mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(29), idempotencyKey: key() }), { code: "FAILED_PRECONDITION" });
  } finally {
    await t.close();
  }
});

test("the same idempotency key books once, even when retried concurrently; a different request under it is refused", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const k = key();
    const req = { locationId, date, time: "18:00", partySize: 2, guest: guest(30), idempotencyKey: k };
    const first = await t.as("sam").mutation(api.reservations.create, req);
    const again = await t.as("sam").mutation(api.reservations.create, req);
    assert.equal(again.reservationId, first.reservationId);
    assert.equal(again.replayed, true);
    await assert.rejects(t.as("sam").mutation(api.reservations.create, { ...req, time: "18:30" }), { code: "FAILED_PRECONDITION" });

    const k2 = key();
    const burst = await Promise.allSettled([1, 2, 3, 4].map(() => t.as("sam").mutation(api.reservations.create, { ...req, time: "20:30", idempotencyKey: k2 })));
    const ids = new Set(burst.filter((b) => b.status === "fulfilled").map((b) => (b as PromiseFulfilledResult<{ reservationId: string }>).value.reservationId));
    assert.ok(ids.size <= 1);
    const rows = (await t.as("lee").query(api.reservations.list, { locationId, date })).filter((r) => r.time === "20:30");
    assert.equal(rows.length, 1, "one reservation for the key, however many attempts");
    assert.equal((await t.as("lee").query(api.guests.list, {})).filter((g) => g.email === "guest30@example.com").length, 1, "and one guest record");
  } finally {
    await t.close();
  }
});

test("modification re-checks availability and keeps history; cancellation keeps the record", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const sam = t.as("sam");
    const r = await sam.mutation(api.reservations.create, { locationId, date, time: "18:00", partySize: 2, guest: guest(40), specialRequests: "Window", idempotencyKey: key() });
    await sam.mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 5, guest: guest(41), idempotencyKey: key() });

    // Party grows to 5 at 19:00: the only table for 5 is taken.
    await assert.rejects(sam.mutation(api.reservations.modify, { id: r.reservationId, time: "19:00", partySize: 5 }), { code: "FAILED_PRECONDITION" });
    const moved = await sam.mutation(api.reservations.modify, { id: r.reservationId, time: "18:30", partySize: 4 });
    assert.deepEqual([moved.time, moved.partySize, moved.tableLabel], ["18:30", 4, "T2"]);
    // Moving within its own slot does not conflict with itself.
    assert.equal((await sam.mutation(api.reservations.modify, { id: r.reservationId, specialRequests: "Birthday" })).time, "18:30");

    await sam.mutation(api.reservations.cancel, { id: r.reservationId, reason: "Guest called" });
    await assert.rejects(sam.mutation(api.reservations.modify, { id: r.reservationId, time: "18:00" }), { code: "FAILED_PRECONDITION" });
    await assert.rejects(sam.mutation(api.reservations.cancel, { id: r.reservationId, reason: "again" }), { code: "FAILED_PRECONDITION" });

    const all = await sam.query(api.reservations.list, { locationId, date, includeInactive: true });
    const kept = all.find((x) => x.id === r.reservationId)!;
    assert.deepEqual([kept.status, kept.cancelReason], ["cancelled", "Guest called"]);
    assert.equal((await sam.query(api.reservations.list, { locationId, date })).some((x) => x.id === r.reservationId), false, "hidden from the active book");

    const history = await t.as("maria").query(api.reservations.history, { id: r.reservationId });
    assert.deepEqual(history.map((e) => e.type), ["reservation.booked", "reservation.modified", "reservation.modified", "reservation.cancelled"]);
    assert.deepEqual(history.map((e) => e.seq), [1, 2, 3, 4], "ordered by a FeltDB sequence");
    assert.deepEqual((history[1]!.data as any).before, { date, time: "18:00", partySize: 2, tableId: (history[1]!.data as any).before.tableId, specialRequests: "Window" });
    assert.ok(history.every((e) => e.actor === "sam" && e.requestId), "who, and the request that did it");

    // The cancelled table is free again.
    assert.equal((await sam.mutation(api.reservations.create, { locationId, date, time: "18:30", partySize: 4, guest: guest(42), idempotencyKey: key() })).tableLabel, "T2");
  } finally {
    await t.close();
  }
});

test("floor status follows valid transitions only", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const r = await t.as("sam").mutation(api.reservations.create, { locationId, date, time: "18:00", partySize: 2, guest: guest(50), idempotencyKey: key() });
    await assert.rejects(t.as("sam").mutation(api.reservations.setStatus, { id: r.reservationId, status: "completed" }), { code: "FAILED_PRECONDITION" });
    await t.as("sam").mutation(api.reservations.setStatus, { id: r.reservationId, status: "seated" });
    await assert.rejects(t.as("sam").mutation(api.reservations.setStatus, { id: r.reservationId, status: "no_show" }), { code: "FAILED_PRECONDITION" });
    await t.as("sam").mutation(api.reservations.setStatus, { id: r.reservationId, status: "completed" });
    await assert.rejects(t.as(AGENT).mutation(api.reservations.setStatus, { id: r.reservationId, status: "seated" }), { code: "FORBIDDEN" }, "the agent does not run the floor");
    const g = (await t.as("lee").query(api.guests.list, {})).find((x) => x.email === "guest50@example.com")!;
    assert.equal(g.visits, 1);
  } finally {
    await t.close();
  }
});

test("the waitlist books through the same availability rules", async () => {
  const { t, locationId, date, key } = await restaurantFixture({ tables: [["T1", 1, 4]] });
  try {
    const sam = t.as("sam");
    const held = await sam.mutation(api.reservations.create, { locationId, date, time: "19:00", partySize: 2, guest: guest(60), idempotencyKey: key() });
    const w = await sam.mutation(api.reservations.waitlistAdd, { locationId, date, partySize: 2, preferredTime: "19:00", guest: { name: "Walk In", phone: "555 010 9999" } });
    let list = await sam.query(api.reservations.waitlistList, { locationId, date });
    assert.equal(list[0]!.availableTimes.includes("19:00"), false);
    await assert.rejects(sam.mutation(api.reservations.waitlistBook, { id: w.id, time: "19:00", idempotencyKey: key() }), { code: "FAILED_PRECONDITION" });

    await sam.mutation(api.reservations.cancel, { id: held.reservationId, reason: "Guest cancelled by phone" });
    list = await sam.query(api.reservations.waitlistList, { locationId, date });
    assert.equal(list[0]!.availableTimes.includes("19:00"), true, "the freed time is offered to the waiting guest");
    const booked = await sam.mutation(api.reservations.waitlistBook, { id: w.id, time: "19:00", idempotencyKey: key() });
    assert.equal(booked.status, "booked");
    assert.deepEqual(await sam.query(api.reservations.waitlistList, { locationId, date }), []);
  } finally {
    await t.close();
  }
});

test("public booking: rules apply, the guest gets a code to view and cancel their own booking, nobody else's", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const visitor = t.as({ id: "visitor", type: "user", roles: [] });
    await assert.rejects(visitor.mutation(api.public.bookTable, { locationId, date, time: "21:30", partySize: 2, name: "Ana", email: "ana@example.com", idempotencyKey: key() }), (e: any) => e.code === "FAILED_PRECONDITION" && e.details?.reason === "outside_hours");
    const r = await visitor.mutation(api.public.bookTable, { locationId, date, time: "19:00", partySize: 2, name: "Ana", email: "ana@example.com", specialRequests: "Anniversary", idempotencyKey: key() });
    assert.ok(r.code.length >= 20);
    const mine = await visitor.query(api.public.myBooking, { code: r.code });
    assert.deepEqual([mine.date, mine.time, mine.status, mine.specialRequests], [date, "19:00", "booked", "Anniversary"]);
    await assert.rejects(visitor.query(api.public.myBooking, { code: "x".repeat(22) }), { code: "NOT_FOUND" });

    const staffView = (await t.as("sam").query(api.reservations.list, { locationId, date }))[0]!;
    assert.equal(staffView.source, "public");
    assert.ok(!("code" in staffView), "staff lists never carry the guest's bearer code");

    assert.equal((await visitor.mutation(api.public.cancelMyBooking, { code: r.code })).status, "cancelled");
    const history = await t.as("maria").query(api.reservations.history, { id: r.reservationId });
    assert.deepEqual(history.map((e) => [e.type, (e.data as any)?.by ?? null]), [["reservation.booked", null], ["reservation.cancelled", "guest"]]);
  } finally {
    await t.close();
  }
});

test("reservations survive a restart", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const r = await t.as("sam").mutation(api.reservations.create, { locationId, date, time: "18:00", partySize: 2, guest: guest(70), idempotencyKey: key() });
    await t.restart();
    const rows = await t.as("lee").query(api.reservations.list, { locationId, date });
    assert.deepEqual(rows.map((x) => x.id), [r.reservationId]);
  } finally {
    await t.close();
  }
});
