/**
 * The front-office picture, from records only: today's book at each location, what needs a
 * person's attention, and the audit trail. Deterministic; no model involved.
 */
import { s } from "@feltdb/feltkit";
import { app, events, inquiries, locations, messages, reservations, reviews, waitlist, SUBJECTS } from "./app.js";
import { localNow, toMinutes } from "./_time.js";

export const today = app.query({
  access: "insights.read",
  returns: s.object({
    locations: s.array(s.object({
      id: s.string(), name: s.string(), date: s.string(), now: s.string(),
      reservations: s.integer(), covers: s.integer(), seated: s.integer(), completed: s.integer(), noShows: s.integer(), cancelled: s.integer(),
      nextArrivals: s.array(s.object({ id: s.string(), time: s.string(), partySize: s.integer() })),
      waiting: s.integer(),
    })),
    attention: s.object({ openInquiries: s.integer(), draftsAwaitingApproval: s.integer(), repliesReadyToSend: s.integer(), reviewsWithoutResponse: s.integer(), lowRatingsLast30Days: s.integer() }),
  }),
  capability: { name: "insights.today", description: "Today at each location (in its own time zone): bookings, covers, arrivals in the next two hours, waitlist; and what needs attention: open inquiries, drafts awaiting approval, unanswered reviews." },
  handler: async (ctx) => {
    const now = Date.now();
    const out = [];
    for (const l of await ctx.db.find(locations, { active: true })) {
      const local = localNow(l.timeZone, now);
      const rs = await ctx.db.find(reservations, { locationId: l.id, date: local.date });
      const live = rs.filter((r) => r.status === "booked" || r.status === "seated" || r.status === "completed");
      out.push({
        id: l.id, name: l.name, date: local.date, now: `${String(Math.floor(local.minute / 60)).padStart(2, "0")}:${String(local.minute % 60).padStart(2, "0")}`,
        reservations: live.length,
        covers: live.reduce((n, r) => n + r.partySize, 0),
        seated: rs.filter((r) => r.status === "seated").length,
        completed: rs.filter((r) => r.status === "completed").length,
        noShows: rs.filter((r) => r.status === "no_show").length,
        cancelled: rs.filter((r) => r.status === "cancelled").length,
        nextArrivals: rs.filter((r) => r.status === "booked" && toMinutes(r.time) >= local.minute - 15 && toMinutes(r.time) <= local.minute + 120)
          .sort((a, b) => a.startMin - b.startMin).map((r) => ({ id: r.id, time: r.time, partySize: r.partySize })),
        waiting: (await ctx.db.find(waitlist, { locationId: l.id, date: local.date })).filter((w) => w.status === "waiting").length,
      });
    }
    const [iq, ms, rv] = await Promise.all([ctx.db.find(inquiries, {}), ctx.db.find(messages, { direction: "outbound" }), ctx.db.find(reviews, {})]);
    const monthAgo = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
    return {
      locations: out,
      attention: {
        openInquiries: iq.filter((q) => q.status === "open").length,
        draftsAwaitingApproval: ms.filter((m) => m.status === "draft").length + rv.filter((r) => r.response?.status === "draft").length,
        repliesReadyToSend: ms.filter((m) => m.status === "ready").length,
        reviewsWithoutResponse: rv.filter((r) => !r.response).length,
        lowRatingsLast30Days: rv.filter((r) => r.rating <= 2 && r.reviewedAt >= monthAgo).length,
      },
    };
  },
});

export const audit = app.query({
  access: "audit.read",
  args: { subjectType: s.optional(s.enum(SUBJECTS)), subjectId: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  returns: s.array(s.doc(events)),
  capability: { name: "audit.list", description: "The business audit trail, newest first: what changed, who changed it (person, agent or public), and the request id linking it to FeltKit's activity log." },
  handler: async (ctx, { subjectType, subjectId, limit }) => {
    const filter = { ...(subjectType ? { subjectType } : {}), ...(subjectId ? { subjectId } : {}) };
    return ctx.db.find(events, filter, { orderBy: [{ field: "at", direction: "desc" }], limit: limit ?? 100 });
  },
});
