/**
 * Guest relationships: profiles, visit history, explicitly recorded preferences, and the
 * communication history. Contact details are returned only to roles holding guests.read.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, guests, inquiries, locations, reservations } from "./app.js";
import { record } from "./_audit.js";

const GuestView = s.doc(guests).omit("emailKey", "phoneKey");

export const list = app.query({
  access: "guests.read",
  args: { text: s.optional(s.string({ maxLength: 120 })) },
  returns: s.array(GuestView.extend({ visits: s.integer(), upcoming: s.integer(), noShows: s.integer() })),
  capability: { name: "guests.list", description: "Guests (optionally matching a name, e-mail or phone), with completed visits, upcoming bookings and no-shows." },
  handler: async (ctx, { text }) => {
    const found = text?.trim() ? await ctx.db.search(guests, { text: text.trim(), limit: 100 }) : await ctx.db.find(guests, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 200 });
    const all = await ctx.db.find(reservations, {});
    return found.map(({ emailKey: _e, phoneKey: _p, ...g }) => {
      const mine = all.filter((r) => r.guestId === g.id);
      return { ...g, visits: mine.filter((r) => r.status === "completed").length, upcoming: mine.filter((r) => r.status === "booked").length, noShows: mine.filter((r) => r.status === "no_show").length };
    });
  },
});

export const get = app.query({
  access: "guests.read",
  args: { id: s.string() },
  returns: s.object({
    guest: GuestView,
    reservations: s.array(s.object({ id: s.string(), date: s.string(), time: s.string(), partySize: s.integer(), status: s.string(), locationName: s.string(), specialRequests: s.optional(s.string()) })),
    inquiries: s.array(s.object({ id: s.string(), subject: s.string(), status: s.string(), category: s.string(), createdAt: s.number() })),
  }),
  capability: { name: "guests.get", description: "One guest: contact details, recorded preferences, every reservation and inquiry." },
  handler: async (ctx, { id }) => {
    const g = await ctx.db.get(guests, id);
    if (!g) fail("NOT_FOUND", `No guest ${id}.`);
    const { emailKey: _e, phoneKey: _p, ...guest } = g;
    const [rs, iq, locs] = await Promise.all([ctx.db.find(reservations, { guestId: id }), ctx.db.find(inquiries, { guestId: id }), ctx.db.find(locations, {})]);
    return {
      guest,
      reservations: rs.sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin).map((r) => ({ id: r.id, date: r.date, time: r.time, partySize: r.partySize, status: r.status, locationName: locs.find((l) => l.id === r.locationId)?.name ?? "", ...(r.specialRequests ? { specialRequests: r.specialRequests } : {}) })),
      inquiries: iq.sort((a, b) => b.createdAt - a.createdAt).map((q) => ({ id: q.id, subject: q.subject, status: q.status, category: q.category, createdAt: q.createdAt })),
    };
  },
});

export const addPreference = app.mutation({
  access: "guests.write",
  args: { id: s.string(), note: s.string({ minLength: 1, maxLength: 500 }) },
  returns: GuestView,
  capability: { name: "guests.addpreference", description: "Record a preference the guest stated or staff observed (allergy, seating, occasion). Recorded with who wrote it; never inferred." },
  handler: async (ctx, { id, note }) => {
    const who = ctx.auth.requirePrincipal().id;
    const g = await ctx.db.get(guests, id);
    if (!g) fail("NOT_FOUND", `No guest ${id}.`);
    const { emailKey: _e, phoneKey: _p, ...saved } = await ctx.db.patch(guests, id, { preferences: [...g.preferences, { note: note.trim(), recordedBy: who, recordedAt: Date.now() }] });
    await record(ctx, "guest", id, "guest.preference.added", { note: note.trim() });
    return saved;
  },
});

export const removePreference = app.mutation({
  access: "guests.write",
  args: { id: s.string(), index: s.integer({ minimum: 0 }) },
  returns: GuestView,
  capability: { name: "guests.removepreference", description: "Remove a recorded preference (the audit trail keeps it)." },
  handler: async (ctx, { id, index }) => {
    ctx.auth.requirePrincipal();
    const g = await ctx.db.get(guests, id);
    if (!g) fail("NOT_FOUND", `No guest ${id}.`);
    const removed = g.preferences[index];
    if (!removed) fail("NOT_FOUND", "No such preference.");
    const { emailKey: _e, phoneKey: _p, ...saved } = await ctx.db.patch(guests, id, { preferences: g.preferences.filter((_, i) => i !== index) });
    await record(ctx, "guest", id, "guest.preference.removed", { note: removed.note });
    return saved;
  },
});

export const setTags = app.mutation({
  access: "guests.write",
  args: { id: s.string(), tags: s.array(s.string({ minLength: 1, maxLength: 40 })) },
  returns: GuestView,
  capability: { name: "guests.settags", description: "Set a guest's tags (e.g. regular, vip)." },
  handler: async (ctx, { id, tags }) => {
    ctx.auth.requirePrincipal();
    const g = await ctx.db.get(guests, id);
    if (!g) fail("NOT_FOUND", `No guest ${id}.`);
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const { emailKey: _e, phoneKey: _p, ...saved } = await ctx.db.patch(guests, id, { tags: clean });
    await record(ctx, "guest", id, "guest.tags.set", { before: g.tags, after: clean });
    return saved;
  },
});
