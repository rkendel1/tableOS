/**
 * Customer inquiries and the communication history.
 *
 * Outbound messages: a draft (by staff or an agent) → ready (a person approved the text; handed to
 * subscribed senders by the `message.ready` webhook) → sent (a person recorded how it reached the
 * guest). TableOS has no e-mail/SMS channel of its own (FeltKit's notifications reach signed-in
 * principals, not guests), so it never marks a message sent on its own say-so.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, guests, inquiries, INQUIRY_CATEGORIES, messages } from "./app.js";
import { record } from "./_audit.js";
import { announce } from "./_announce.js";
import { categorizeInquiry } from "./_rules.js";
import { resolveGuest } from "./_booking.js";
import { GuestInput } from "./_views.js";

const InquiryRow = s.doc(inquiries).extend({ guestName: s.string(), messages: s.integer(), pendingDrafts: s.integer() });

export const list = app.query({
  access: "inquiries.read",
  args: { status: s.optional(s.enum(["open", "awaiting_guest", "closed"])) },
  returns: s.array(InquiryRow),
  capability: { name: "inquiries.list", description: "Guest inquiries, most recent activity first, optionally by status." },
  handler: async (ctx, { status }) => {
    const rows = await ctx.db.find(inquiries, status ? { status } : {}, { orderBy: [{ field: "lastMessageAt", direction: "desc" }] });
    const [gs, ms] = await Promise.all([Promise.all(rows.map((q) => ctx.db.get(guests, q.guestId))), ctx.db.find(messages, {})]);
    return rows.map((q, i) => ({
      ...q,
      guestName: gs[i]?.name ?? "(unknown)",
      messages: ms.filter((m) => m.inquiryId === q.id).length,
      pendingDrafts: ms.filter((m) => m.inquiryId === q.id && m.status === "draft").length,
    }));
  },
});

export const get = app.query({
  access: "inquiries.read",
  args: { id: s.string() },
  returns: s.object({
    inquiry: s.doc(inquiries),
    guest: s.object({ id: s.string(), name: s.string(), email: s.optional(s.string()), phone: s.optional(s.string()) }),
    messages: s.array(s.doc(messages)),
  }),
  capability: { name: "inquiries.get", description: "One inquiry with the guest's contact details and the whole conversation (received, drafts, approved, sent)." },
  handler: async (ctx, { id }) => {
    const q = await ctx.db.get(inquiries, id);
    if (!q) fail("NOT_FOUND", `No inquiry ${id}.`);
    const g = await ctx.db.get(guests, q.guestId);
    return {
      inquiry: q,
      guest: { id: q.guestId, name: g?.name ?? "(unknown)", ...(g?.email ? { email: g.email } : {}), ...(g?.phone ? { phone: g.phone } : {}) },
      messages: await ctx.db.find(messages, { inquiryId: id }, { orderBy: [{ field: "at", direction: "asc" }] }),
    };
  },
});

export const log = app.mutation({
  access: "inquiries.write",
  args: { guest: GuestInput, channel: s.enum(["phone", "email", "in_person", "web"]), subject: s.string({ minLength: 1, maxLength: 200 }), message: s.string({ minLength: 1, maxLength: 8000 }), locationId: s.optional(s.string()) },
  returns: s.object({ inquiryId: s.string(), category: s.enum(INQUIRY_CATEGORIES) }),
  capability: { name: "inquiries.log", description: "Record an inquiry that arrived by phone, e-mail or in person. It is categorized by rules; a person can change the category." },
  handler: async (ctx, { guest, channel, subject, message, locationId }) => {
    const who = ctx.auth.requirePrincipal();
    const guestId = await resolveGuest(ctx, guest);
    const now = Date.now();
    const category = categorizeInquiry(`${subject}\n${message}`);
    const inquiryId = await ctx.db.insert(inquiries, { guestId, ...(locationId ? { locationId } : {}), subject: subject.trim(), category, categorizedBy: "rules", channel, status: "open", createdAt: now, lastMessageAt: now });
    await ctx.db.insert(messages, { inquiryId, direction: "inbound", body: message.trim(), status: "received", author: who.id, authorType: who.type, at: now });
    await record(ctx, "inquiry", inquiryId, "inquiry.received", { channel, category, loggedBy: who.id });
    announce(ctx, "inquiry.received", { inquiryId, category });
    return { inquiryId, category };
  },
});

export const categorize = app.mutation({
  access: "inquiries.write",
  args: { id: s.string(), category: s.enum(INQUIRY_CATEGORIES) },
  returns: s.doc(inquiries),
  capability: { name: "inquiries.categorize", description: "Set an inquiry's category." },
  handler: async (ctx, { id, category }) => {
    const who = ctx.auth.requirePrincipal();
    const q = await ctx.db.get(inquiries, id);
    if (!q) fail("NOT_FOUND", `No inquiry ${id}.`);
    const saved = await ctx.db.patch(inquiries, id, { category, categorizedBy: who.type === "user" ? "person" : "rules" });
    await record(ctx, "inquiry", id, "inquiry.categorized", { before: q.category, after: category });
    return saved;
  },
});

export const draftReply = app.mutation({
  access: "inquiries.write",
  args: { id: s.string(), body: s.string({ minLength: 1, maxLength: 8000 }) },
  returns: s.doc(messages),
  capability: { name: "inquiries.draftreply", description: "Draft a reply to an inquiry. A draft sends nothing; a person with inquiries.send approves the text." },
  handler: async (ctx, { id, body }) => {
    const who = ctx.auth.requirePrincipal();
    const q = await ctx.db.get(inquiries, id);
    if (!q) fail("NOT_FOUND", `No inquiry ${id}.`);
    if (q.status === "closed") fail("FAILED_PRECONDITION", "The inquiry is closed.");
    const mid = await ctx.db.insert(messages, { inquiryId: id, direction: "outbound", body: body.trim(), status: "draft", author: who.id, authorType: who.type, at: Date.now() });
    await record(ctx, "inquiry", id, "reply.drafted", { messageId: mid, by: who.id, byType: who.type });
    return (await ctx.db.get(messages, mid))!;
  },
});

export const approveReply = app.mutation({
  access: "inquiries.send",
  args: { messageId: s.string(), body: s.optional(s.string({ minLength: 1, maxLength: 8000 })) },
  returns: s.doc(messages),
  capability: { name: "inquiries.approvereply", description: "A person approves a drafted reply (optionally editing it). It becomes ready to send and is announced to subscribed senders (message.ready). Nothing is marked sent until someone records how it was sent." },
  handler: async (ctx, { messageId, body }) => {
    const who = ctx.auth.requirePrincipal();
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may approve a message to a guest.");
    const m = await ctx.db.get(messages, messageId);
    if (!m || m.direction !== "outbound") fail("NOT_FOUND", `No drafted reply ${messageId}.`);
    if (m.status !== "draft") fail("FAILED_PRECONDITION", `The reply is ${m.status}.`);
    const finalBody = body?.trim() || m.body;
    const saved = await ctx.db.patch(messages, messageId, { status: "ready", body: finalBody, approvedBy: who.id });
    await ctx.db.patch(inquiries, m.inquiryId, { status: "awaiting_guest", lastMessageAt: Date.now() });
    await record(ctx, "inquiry", m.inquiryId, "reply.approved", { messageId, edited: finalBody !== m.body, draftedBy: m.author, draftedByType: m.authorType });
    announce(ctx, "message.ready", { messageId, inquiryId: m.inquiryId });
    return saved;
  },
});

export const recordSent = app.mutation({
  access: "inquiries.send",
  args: { messageId: s.string(), via: s.string({ minLength: 2, maxLength: 200 }) },
  returns: s.doc(messages),
  capability: { name: "inquiries.recordsent", description: "Record that an approved reply reached the guest, and how (e.g. \"e-mail from host@…\", \"phoned 555-…\"). This is a person's statement, kept as evidence." },
  handler: async (ctx, { messageId, via }) => {
    const who = ctx.auth.requirePrincipal();
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may record that a message was sent.");
    const m = await ctx.db.get(messages, messageId);
    if (!m) fail("NOT_FOUND", `No message ${messageId}.`);
    if (m.status !== "ready") fail("FAILED_PRECONDITION", `Only an approved reply can be recorded as sent; this one is ${m.status}.`);
    const saved = await ctx.db.patch(messages, messageId, { status: "sent", sentVia: via.trim(), sentRecordedBy: who.id });
    await record(ctx, "inquiry", m.inquiryId, "reply.sent.recorded", { messageId, via: via.trim() });
    return saved;
  },
});

export const addInbound = app.mutation({
  access: "inquiries.write",
  args: { id: s.string(), body: s.string({ minLength: 1, maxLength: 8000 }) },
  returns: s.doc(messages),
  capability: { name: "inquiries.addinbound", description: "Record a further message from the guest on an existing inquiry (reopens it)." },
  handler: async (ctx, { id, body }) => {
    const who = ctx.auth.requirePrincipal();
    const q = await ctx.db.get(inquiries, id);
    if (!q) fail("NOT_FOUND", `No inquiry ${id}.`);
    const now = Date.now();
    const mid = await ctx.db.insert(messages, { inquiryId: id, direction: "inbound", body: body.trim(), status: "received", author: who.id, authorType: who.type, at: now });
    await ctx.db.patch(inquiries, id, { status: "open", lastMessageAt: now });
    await record(ctx, "inquiry", id, "inquiry.message.received", { messageId: mid });
    return (await ctx.db.get(messages, mid))!;
  },
});

export const close = app.mutation({
  access: "inquiries.write",
  args: { id: s.string() },
  returns: s.doc(inquiries),
  capability: { name: "inquiries.close", description: "Close an inquiry." },
  handler: async (ctx, { id }) => {
    ctx.auth.requirePrincipal();
    const q = await ctx.db.get(inquiries, id);
    if (!q) fail("NOT_FOUND", `No inquiry ${id}.`);
    const saved = await ctx.db.patch(inquiries, id, { status: "closed" });
    await record(ctx, "inquiry", id, "inquiry.closed", { from: q.status });
    return saved;
  },
});
