/**
 * Reviews and reputation.
 *
 * No review platform integration exists in this ecosystem today, so reviews enter TableOS by
 * manual entry or import, each with its source, the source's id and URL, and who recorded it when
 * (provenance). Responses: drafted (staff or agent) → approved (a person) → published (a person
 * records the URL where it appears). TableOS never claims a response is published on a review site
 * without that evidence.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, reviews, REVIEW_SOURCES, DateString } from "./app.js";
import { actorOf, record } from "./_audit.js";
import { reviewThemes, THEME_METHOD } from "./_rules.js";
import { isValidDate } from "./_time.js";

const ReviewView = s.doc(reviews);

const ReviewInput = s.object({
  source: s.enum(REVIEW_SOURCES),
  externalId: s.optional(s.string({ minLength: 1, maxLength: 200 })),
  url: s.optional(s.string({ maxLength: 500 })),
  locationId: s.optional(s.string()),
  author: s.string({ minLength: 1, maxLength: 120 }),
  rating: s.integer({ minimum: 1, maximum: 5 }),
  text: s.string({ maxLength: 8000 }),
  reviewedAt: DateString,
});

export const list = app.query({
  access: "reviews.read",
  args: { needsResponse: s.optional(s.boolean()), maxRating: s.optional(s.integer({ minimum: 1, maximum: 5 })) },
  returns: s.array(ReviewView),
  capability: { name: "reviews.list", description: "Reviews, newest first, with source, provenance and response state. needsResponse: only those without an approved response." },
  handler: async (ctx, { needsResponse, maxRating }) =>
    (await ctx.db.find(reviews, {}, { orderBy: [{ field: "reviewedAt", direction: "desc" }] }))
      .filter((r) => (needsResponse ? !r.response || r.response.status === "draft" : true) && (maxRating ? r.rating <= maxRating : true)),
});

export const add = app.mutation({
  access: "reviews.write",
  args: { review: ReviewInput, batch: s.optional(s.string({ maxLength: 200 })) },
  returns: s.object({ id: s.string(), created: s.boolean() }),
  capability: { name: "reviews.add", description: "Record a review with its source and the source's id. The same source + id is recorded once (re-imports are safe)." },
  handler: async (ctx, { review, batch }) => {
    const who = ctx.auth.requirePrincipal();
    if (!isValidDate(review.reviewedAt)) fail("INVALID_ARGUMENT", `${review.reviewedAt} is not a date.`);
    const externalId = review.externalId?.trim() || (review.source === "direct" ? `direct-${await ctx.crypto.token(12)}` : fail("INVALID_ARGUMENT", "A review from an external source needs that source's id (externalId), so it is never recorded twice."));
    const existing = (await ctx.db.find(reviews, { source: review.source, externalId }))[0];
    if (existing) return { id: existing.id, created: false };
    const { externalId: _x, url, locationId, ...rest } = review;
    const id = await ctx.db.insert(reviews, {
      ...rest, externalId, ...(url?.trim() ? { url: url.trim() } : {}), ...(locationId ? { locationId } : {}),
      provenance: { method: batch ? "import" : "manual_entry", recordedBy: who.id, recordedAt: Date.now(), ...(batch ? { batch } : {}) },
    });
    await record(ctx, "review", id, "review.recorded", { source: review.source, externalId, rating: review.rating, method: batch ? "import" : "manual_entry" });
    return { id, created: true };
  },
});

export const importBatch = app.mutation({
  access: "reviews.write",
  args: { batch: s.string({ minLength: 1, maxLength: 200 }), reviews: s.array(ReviewInput, { maxItems: 500 }) },
  returns: s.object({ created: s.integer(), skipped: s.integer() }),
  capability: { name: "reviews.import", description: "Import reviews exported from a review site (each with its source id). Already-recorded reviews are skipped. The batch name is kept as provenance." },
  handler: async (ctx, { batch, reviews: list }) => {
    const who = ctx.auth.requirePrincipal();
    let created = 0;
    for (const r of list) {
      if (!r.externalId?.trim()) fail("INVALID_ARGUMENT", `Every imported review needs its source id (missing for ${r.author}).`);
      if (!isValidDate(r.reviewedAt)) fail("INVALID_ARGUMENT", `${r.reviewedAt} is not a date.`);
      if ((await ctx.db.find(reviews, { source: r.source, externalId: r.externalId.trim() })).length) continue;
      const { url, locationId, externalId, ...rest } = r;
      const id = await ctx.db.insert(reviews, { ...rest, externalId: externalId!.trim(), ...(url?.trim() ? { url: url.trim() } : {}), ...(locationId ? { locationId } : {}), provenance: { method: "import", recordedBy: who.id, recordedAt: Date.now(), batch } });
      await record(ctx, "review", id, "review.recorded", { source: r.source, externalId: externalId!.trim(), rating: r.rating, method: "import", batch });
      created++;
    }
    return { created, skipped: list.length - created };
  },
});

export const themes = app.query({
  access: "insights.read",
  args: { since: s.optional(DateString), locationId: s.optional(s.string()) },
  returns: s.object({
    method: s.string(),
    reviewsConsidered: s.integer(),
    averageRating: s.number(),
    themes: s.array(s.object({
      id: s.string(), label: s.string(), mentions: s.integer(), negativeMentions: s.integer(), averageRating: s.number(),
      evidence: s.array(s.object({ reviewId: s.string(), rating: s.integer(), source: s.string(), reviewedAt: s.string(), excerpt: s.string() })),
    })),
    note: s.string(),
  }),
  capability: { name: "reviews.themes", description: "Recurring themes in reviews, by fixed keyword rules (no model). Each theme lists the reviews it came from with excerpts; negativeMentions counts 1–2 star reviews that match. Observations, not interpretations." },
  handler: async (ctx, { since, locationId }) => {
    const all = (await ctx.db.find(reviews, {})).filter((r) => (!since || r.reviewedAt >= since) && (!locationId || r.locationId === locationId));
    return {
      method: THEME_METHOD,
      reviewsConsidered: all.length,
      averageRating: all.length ? Math.round((all.reduce((n, r) => n + r.rating, 0) / all.length) * 10) / 10 : 0,
      themes: reviewThemes(all),
      note: "Themes are matched words in review text. A review can match several themes. Read the evidence before acting on a theme.",
    };
  },
});

export const draftResponse = app.mutation({
  access: "reviews.draft",
  args: { id: s.string(), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: ReviewView,
  capability: { name: "reviews.draftresponse", description: "Draft a public response to a review. Replaces an earlier draft. Drafts are never published; a person approves." },
  handler: async (ctx, { id, text }) => {
    const who = actorOf(ctx);
    ctx.auth.requirePrincipal();
    const r = await ctx.db.get(reviews, id);
    if (!r) fail("NOT_FOUND", `No review ${id}.`);
    if (r.response && r.response.status !== "draft") fail("FAILED_PRECONDITION", `The response is already ${r.response.status}.`);
    const saved = await ctx.db.patch(reviews, id, { response: { text: text.trim(), draftedBy: who.id, draftedByType: who.type, draftedAt: Date.now(), status: "draft" } });
    await record(ctx, "review", id, "response.drafted", { by: who.id, byType: who.type });
    return saved;
  },
});

export const approveResponse = app.mutation({
  access: "reviews.respond",
  args: { id: s.string(), text: s.optional(s.string({ minLength: 1, maxLength: 4000 })) },
  returns: ReviewView,
  capability: { name: "reviews.approveresponse", description: "A person approves the drafted response (optionally editing it). Approval does not publish: post it on the review site, then record where with reviews.recordpublished." },
  handler: async (ctx, { id, text }) => {
    const who = ctx.auth.requirePrincipal();
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may approve a public response.");
    const r = await ctx.db.get(reviews, id);
    if (!r) fail("NOT_FOUND", `No review ${id}.`);
    if (!r.response || r.response.status !== "draft") fail("FAILED_PRECONDITION", "There is no draft response to approve.");
    const finalText = text?.trim() || r.response.text;
    const saved = await ctx.db.patch(reviews, id, { response: { ...r.response, text: finalText, status: "approved", approvedBy: who.id, approvedAt: Date.now() } });
    await record(ctx, "review", id, "response.approved", { edited: finalText !== r.response.text, draftedBy: r.response.draftedBy, draftedByType: r.response.draftedByType });
    ctx.afterCommit.webhooks.emit("review.response.approved", { reviewId: id, source: r.source, externalId: r.externalId });
    return saved;
  },
});

export const recordPublished = app.mutation({
  access: "reviews.respond",
  args: { id: s.string(), url: s.string({ minLength: 8, maxLength: 500 }) },
  returns: ReviewView,
  capability: { name: "reviews.recordpublished", description: "Record where an approved response now appears on the review site (its URL), as a person's evidence that it was published." },
  handler: async (ctx, { id, url }) => {
    const who = ctx.auth.requirePrincipal();
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may record a publication.");
    if (!/^https?:\/\//.test(url.trim())) fail("INVALID_ARGUMENT", "Give the URL where the response appears.");
    const r = await ctx.db.get(reviews, id);
    if (!r) fail("NOT_FOUND", `No review ${id}.`);
    if (!r.response || r.response.status !== "approved") fail("FAILED_PRECONDITION", "Only an approved response can be recorded as published.");
    const saved = await ctx.db.patch(reviews, id, { response: { ...r.response, status: "published", publishedUrl: url.trim(), publishedRecordedBy: who.id, publishedAt: Date.now() } });
    await record(ctx, "review", id, "response.published.recorded", { url: url.trim() });
    return saved;
  },
});
