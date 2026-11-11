#!/usr/bin/env node
/**
 * Anonymous public path against a RUNNING TableOS (`npm run dev` or `npm start`), over real HTTP with
 * no session (tests use createTestApp's own anonymous caller; this checks the real server). Needs a restaurant with at least one bookable
 * location (in development: Today → "Load sample restaurant").
 *
 *   node scripts/smoke-http.mjs [http://localhost:3000]
 *
 * Checks: public info and menu read; staff functions refused; a booking on the first open day commits;
 * the same idempotency key replays it; the guest's code shows and cancels it.
 */
const base = process.argv[2] ?? "http://localhost:3000";
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failures++; };
const call = async (kind, name, args = {}) => {
  const res = await fetch(`${base}/api/${kind}/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) });
  return { status: res.status, body: await res.json() };
};

const info = await call("query", "public:info");
check(info.status === 200 && info.body.value.restaurant, "public info is readable without signing in");
const location = info.body.value.locations.find((l) => l.acceptingReservations);
if (!location) { console.log("No bookable location: load the sample restaurant first."); process.exit(1); }
check((await call("query", "public:menu")).status === 200, "public menu is readable");
for (const fn of ["guests:list", "reservations:list", "inquiries:list", "insights:audit"]) {
  const r = await call("query", fn, fn === "reservations:list" ? { locationId: location.id, date: location.today } : {});
  check(r.status === 401 || r.status === 403, `${fn} is refused to an anonymous caller (${r.status})`);
}

let booked = null;
const key = `smoke-${Date.now()}`;
for (let ahead = 2; ahead < 14 && !booked; ahead++) {
  const date = new Date(Date.parse(location.today + "T12:00:00Z") + ahead * 864e5).toISOString().slice(0, 10);
  const slots = await call("query", "public:availability", { locationId: location.id, date, partySize: 2 });
  const time = slots.body.value?.slots.find((s) => s.available)?.time;
  if (!time) continue;
  const r = await call("mutation", "public:bookTable", { locationId: location.id, date, time, partySize: 2, name: "Smoke Test", email: "smoke@example.com", idempotencyKey: key });
  if (r.body.ok) booked = { ...r.body.value, args: { locationId: location.id, date, time } };
}
check(!!booked, `an anonymous guest books a table${booked ? ` (${booked.date} ${booked.time}, table ${booked.tableLabel})` : ""}`);
if (booked) {
  const again = await call("mutation", "public:bookTable", { ...booked.args, partySize: 2, name: "Smoke Test", email: "smoke@example.com", idempotencyKey: key });
  check(again.body.value?.reservationId === booked.reservationId && again.body.value?.replayed === true, "retrying with the same key returns the same booking");
  const mine = await call("query", "public:myBooking", { code: booked.code });
  check(mine.body.value?.status === "booked", "the guest's code shows their booking");
  const cancelled = await call("mutation", "public:cancelMyBooking", { code: booked.code });
  check(cancelled.body.value?.status === "cancelled", "the guest cancels with their code");
}
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
