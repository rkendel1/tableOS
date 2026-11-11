/**
 * Stages 4–5: customer operations, reviews, and agent assistance.
 *
 * Agents draft and propose; people approve; deterministic workflows execute and leave evidence.
 * Everything here works with no model configured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../feltkit/_generated/api.js";
import { restaurantFixture, AGENT } from "./fixture.js";
import { weekdayOf } from "../feltkit/_time.js";

const maria = { id: "maria", type: "user" as const, roles: ["manager", "admin"] };
const sam = { id: "sam", type: "user" as const, roles: ["host"] };

test("inquiries: received from the site, categorized by rules, drafted by the agent, approved by a person, recorded as sent", async () => {
  const { t } = await restaurantFixture();
  try {
    const visitor = t.as({ id: "visitor", type: "user", roles: [] });
    const { inquiryId } = await visitor.mutation(api.public.contact, { name: "Rosa", email: "rosa@example.com", subject: "Rehearsal dinner", message: "Do you have a private room for 20 on a Saturday in June?" });
    let detail = await t.as("sam").query(api.inquiries.get, { id: inquiryId });
    assert.deepEqual([detail.inquiry.category, detail.inquiry.categorizedBy, detail.inquiry.channel, detail.messages.length], ["private_event", "rules", "web", 1]);
    assert.equal(detail.guest.email, "rosa@example.com");

    const draft = await t.as(AGENT).mutation(api.inquiries.draftReply, { id: inquiryId, body: "Thank you, Rosa — our back room seats 24. Which Saturday?" });
    assert.deepEqual([draft.status, draft.authorType], ["draft", "agent"]);
    await assert.rejects(t.as(AGENT).mutation(api.inquiries.approveReply, { messageId: draft.id }), { code: "FORBIDDEN" }, "the agent cannot approve its own text");
    await assert.rejects(t.as("sam").mutation(api.inquiries.recordSent, { messageId: draft.id, via: "e-mail" }), { code: "FAILED_PRECONDITION" }, "a draft cannot be recorded as sent");

    const approved = await t.as("sam").mutation(api.inquiries.approveReply, { messageId: draft.id, body: "Thank you, Rosa — our back room seats 24. Which Saturday in June?" });
    assert.deepEqual([approved.status, approved.approvedBy], ["ready", "sam"]);
    detail = await t.as("lee").query(api.inquiries.get, { id: inquiryId });
    assert.equal(detail.inquiry.status, "awaiting_guest");
    assert.equal(detail.messages[1]!.status, "ready", "approved is not sent: TableOS has no channel of its own");

    const sent = await t.as("sam").mutation(api.inquiries.recordSent, { messageId: draft.id, via: "e-mail from events@juniper.example" });
    assert.equal(sent.status, "sent");
    await t.restart();
    const trail = await t.as("maria").query(api.insights.audit, { subjectType: "inquiry", subjectId: inquiryId });
    assert.deepEqual(trail.map((e) => e.type).reverse(), ["inquiry.received", "reply.drafted", "reply.approved", "reply.sent.recorded"]);
    assert.equal(trail.find((e) => e.type === "reply.approved")!.data!.edited, true);
    assert.equal(trail.find((e) => e.type === "inquiry.received")!.actorType, "user");
  } finally {
    await t.close();
  }
});

test("guests: recognised across channels by e-mail or phone; preferences are explicit and attributed", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    await t.as("sam").mutation(api.reservations.create, { locationId, date, time: "18:00", partySize: 2, guest: { name: "Kim Lee", phone: "(555) 222-3333" }, idempotencyKey: key() });
    await t.as("sam").mutation(api.inquiries.log, { guest: { name: "Kim Lee", email: "kim@example.com", phone: "555-222-3333" }, channel: "phone", subject: "Allergy", message: "I have a severe shellfish allergy." });
    const all = await t.as("lee").query(api.guests.list, {});
    assert.equal(all.length, 1, "the phone number identified the same guest");
    const g = all[0]!;
    assert.equal(g.email, "kim@example.com", "missing contact details are filled in");
    const updated = await t.as("sam").mutation(api.guests.addPreference, { id: g.id, note: "Severe shellfish allergy (told us by phone)" });
    assert.deepEqual([updated.preferences[0]!.recordedBy, updated.preferences[0]!.note], ["sam", "Severe shellfish allergy (told us by phone)"]);
    const profile = await t.as("lee").query(api.guests.get, { id: g.id });
    assert.equal(profile.reservations.length, 1);
    assert.equal(profile.inquiries.length, 1);
    assert.equal((await t.as("lee").query(api.guests.list, { text: "kim" })).length, 1);
    await assert.rejects(t.as("lee").mutation(api.guests.addPreference, { id: g.id, note: "x" }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("reviews: provenance is kept, imports are idempotent, themes cite evidence, responses need a person and publication evidence", async () => {
  const { t } = await restaurantFixture();
  try {
    const batch = [
      { source: "google" as const, externalId: "g-1", url: "https://maps.example/r/g-1", author: "Marcus", rating: 2, text: "We waited 40 minutes past our reservation and the table wasn't ready.", reviewedAt: "2026-11-01" },
      { source: "yelp" as const, externalId: "y-9", author: "Tom", rating: 1, text: "Slow service and the server was rude.", reviewedAt: "2026-11-03" },
      { source: "google" as const, externalId: "g-2", author: "Dana", rating: 5, text: "Delicious chicken, attentive server.", reviewedAt: "2026-11-05" },
    ];
    assert.deepEqual(await t.as("maria").mutation(api.reviews.importBatch, { batch: "google+yelp export 2026-11-06", reviews: batch }), { created: 3, skipped: 0 });
    assert.deepEqual(await t.as("maria").mutation(api.reviews.importBatch, { batch: "re-run", reviews: batch }), { created: 0, skipped: 3 }, "a re-import records nothing twice");
    await assert.rejects(t.as("maria").mutation(api.reviews.add, { review: { source: "google", author: "x", rating: 3, text: "", reviewedAt: "2026-11-01" } }), { code: "INVALID_ARGUMENT" }, "external reviews need the source id");

    const list = await t.as("lee").query(api.reviews.list, {});
    const marcus = list.find((r) => r.externalId === "g-1")!;
    assert.deepEqual([marcus.provenance.method, marcus.provenance.recordedBy, marcus.provenance.batch, marcus.url], ["import", "maria", "google+yelp export 2026-11-06", "https://maps.example/r/g-1"]);

    const themes = await t.as(AGENT).query(api.reviews.themes, {});
    assert.equal(themes.method, "keyword-rules-v1");
    const wait = themes.themes.find((x) => x.id === "wait_times")!;
    assert.deepEqual(wait.evidence.map((e) => e.reviewId).sort(), [list.find((r) => r.externalId === "g-1")!.id, list.find((r) => r.externalId === "y-9")!.id].sort());

    await t.as(AGENT).mutation(api.reviews.draftResponse, { id: marcus.id, text: "Marcus, we're sorry about the wait — that's not the evening we want for you." });
    await assert.rejects(t.as(AGENT).mutation(api.reviews.approveResponse, { id: marcus.id }), { code: "FORBIDDEN" });
    await assert.rejects(t.as("sam").mutation(api.reviews.approveResponse, { id: marcus.id }), { code: "FORBIDDEN" }, "hosts do not publish responses");
    await assert.rejects(t.as("maria").mutation(api.reviews.recordPublished, { id: marcus.id, url: "https://maps.example/r/g-1#reply" }), { code: "FAILED_PRECONDITION" }, "a draft cannot be marked published");
    const approved = await t.as("maria").mutation(api.reviews.approveResponse, { id: marcus.id });
    assert.deepEqual([approved.response!.status, approved.response!.draftedByType, approved.response!.approvedBy], ["approved", "agent", "maria"]);
    const published = await t.as("maria").mutation(api.reviews.recordPublished, { id: marcus.id, url: "https://maps.example/r/g-1#reply" });
    assert.deepEqual([published.response!.status, published.response!.publishedRecordedBy], ["published", "maria"]);
  } finally {
    await t.close();
  }
});

test("agent proposes an hours change; it runs only after a manager approves, as the agent, with the approval on record", async () => {
  const { t, locationId, date } = await restaurantFixture();
  try {
    const runtime = t.runtime;
    const weekday = weekdayOf(date);
    const task = (await runtime.agent.createTask({ objective: "Extend Friday-style hours to 23:30 on " + date, principal: AGENT as never })) as any;
    const taskId = task.task.task_id as string;
    const proposed = (await runtime.agent.propose(taskId, { capability: "hours.setweekly", input: { locationId, weekday, periods: [{ open: "17:00", close: "23:30" }] }, reason: "Manager asked to extend hours; current close is 22:00." } as never, AGENT as never)) as any;
    const actionId = proposed.pending[0].actionId as string;

    // Proposed, not executed.
    let hours = await t.as("lee").query(api.restaurant.hours, { locationId });
    assert.deepEqual(hours.weekly.find((w) => w.weekday === weekday)!.periods, [{ open: "17:00", close: "22:00" }]);

    // Neither the agent nor a host (no hours.write) may approve.
    await assert.rejects(runtime.agent.approve(taskId, actionId, AGENT as never), (e: any) => e.code === "FORBIDDEN");
    await assert.rejects(runtime.agent.approve(taskId, actionId, sam as never), (e: any) => e.code === "FORBIDDEN");
    hours = await t.as("lee").query(api.restaurant.hours, { locationId });
    assert.equal(hours.weekly.find((w) => w.weekday === weekday)!.periods[0]!.close, "22:00");

    const done = (await runtime.agent.approve(taskId, actionId, maria as never)) as any;
    assert.equal(done.actions.find((a: any) => a.actionId === actionId).state, "succeeded");
    hours = await t.as("lee").query(api.restaurant.hours, { locationId });
    assert.equal(hours.weekly.find((w) => w.weekday === weekday)!.periods[0]!.close, "23:30");
    const slots = await t.as("lee").query(api.reservations.availability, { locationId, date, partySize: 2 });
    assert.equal(slots.slots.at(-1)!.time, "22:30", "booking rules follow the new canonical hours");

    // Evidence: the business event names the agent; FeltKit's activity log names the approval.
    const [event] = await t.as("maria").query(api.insights.audit, { subjectType: "hours", subjectId: locationId, limit: 1 });
    assert.deepEqual([event!.type, event!.actor, event!.actorType], ["hours.weekly.set", "frontdesk-agent", "agent"]);
    const ran = (await runtime.activity.list({ name: "restaurant:setWeekly", limit: 50 })).find((e: any) => e.outcome === "success" && e.principal?.id === "frontdesk-agent") as any;
    assert.deepEqual(ran.authority.approval, { taskId, actionId, approvedBy: "user:maria" });
    assert.equal(ran.requestId, event!.requestId, "the audit event links to the activity record");
  } finally {
    await t.close();
  }
});

test("agent cancellation requires approval; booking for a confirmed guest does not", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    const agent = t.as(AGENT);
    const slots = await agent.query(api.reservations.availability, { locationId, date, partySize: 4 });
    const time = slots.slots.find((s) => s.available && s.time === "19:00")!.time;
    const r = await agent.mutation(api.reservations.create, { locationId, date, time, partySize: 4, guest: { name: "Joan", email: "joan@example.com" }, idempotencyKey: key() });
    assert.equal((await t.as("lee").query(api.reservations.list, { locationId, date }))[0]!.source, "agent");
    await assert.rejects(agent.mutation(api.reservations.cancel, { id: r.reservationId, reason: "Guest asked" }), (e: any) => e.code === "FORBIDDEN" && e.details?.approval === "required");
    assert.equal((await t.as("lee").query(api.reservations.list, { locationId, date }))[0]!.status, "booked");
  } finally {
    await t.close();
  }
});

test("the front office works with no model: insights, menu checks and themes are computed from records", async () => {
  const { t, locationId, date, key } = await restaurantFixture();
  try {
    await t.as("sam").mutation(api.reservations.create, { locationId, date, time: "18:00", partySize: 3, guest: { name: "A", email: "a@example.com" }, idempotencyKey: key() });
    await t.as(AGENT).mutation(api.inquiries.log, { guest: { name: "B", email: "b@example.com" }, channel: "email", subject: "Gluten", message: "Is the cake gluten free?" });
    const today = await t.as("lee").query(api.insights.today, {});
    assert.equal(today.locations[0]!.name, "Main Street");
    assert.equal(today.attention.openInquiries, 1);
    assert.equal((await t.as("lee").query(api.menu.issues, {})).method, "menu-rules-v1");
    assert.equal((await t.as("lee").query(api.reviews.themes, {})).reviewsConsidered, 0);
  } finally {
    await t.close();
  }
});
