/**
 * Canonical menus: menus, sections and items with prices (integer cents), dietary tags, allergen
 * declarations and availability. The public menu is a projection of these records (public.ts).
 *
 * Every write is `approval: "required"`: managers edit directly; an agent that spots a problem
 * (menu.issues) proposes the fix, and a person approves it.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { ALLERGENS, app, DIETARY, menuItems, menus, menuSections } from "./app.js";
import { record } from "./_audit.js";
import { announce } from "./_announce.js";
import { menuIssues } from "./_rules.js";

const MenuView = s.doc(menus);
const SectionView = s.doc(menuSections);
const ItemView = s.doc(menuItems);

export const full = app.query({
  access: "menu.read",
  returns: s.object({ menus: s.array(MenuView), sections: s.array(SectionView), items: s.array(ItemView) }),
  capability: { name: "menu.get", description: "Every menu, section and item, including unavailable items and inactive menus." },
  handler: async (ctx) => ({
    menus: await ctx.db.find(menus, {}, { orderBy: [{ field: "position", direction: "asc" }] }),
    sections: await ctx.db.find(menuSections, {}, { orderBy: [{ field: "position", direction: "asc" }] }),
    items: await ctx.db.find(menuItems, {}, { orderBy: [{ field: "position", direction: "asc" }] }),
  }),
});

export const issues = app.query({
  access: "insights.read",
  returns: s.object({
    method: s.string(),
    issues: s.array(s.object({ itemId: s.optional(s.string()), menuId: s.optional(s.string()), sectionId: s.optional(s.string()), severity: s.enum(["error", "warning"]), code: s.string(), message: s.string() })),
  }),
  capability: { name: "menu.issues", description: "Rule-based menu consistency checks: contradictory dietary tags and allergens, missing prices, descriptions or allergen declarations, duplicates, empty sections, published menus with nothing available. Each issue names the record." },
  handler: async (ctx) => {
    const [m, sec, items] = await Promise.all([ctx.db.find(menus, {}), ctx.db.find(menuSections, {}), ctx.db.find(menuItems, {})]);
    return { method: "menu-rules-v1", issues: menuIssues(m, sec, items) };
  },
});

function menuChanged(ctx: Pick<MutationCtx, "afterCommit">, data: Record<string, unknown>) {
  announce(ctx, "menu.changed", data);
}

export const saveMenu = app.mutation({
  access: "menu.write",
  approval: "required",
  args: { id: s.optional(s.string()), name: s.string({ minLength: 1, maxLength: 80 }), description: s.optional(s.string({ maxLength: 500 })), active: s.boolean(), locationIds: s.array(s.string()), position: s.integer({ minimum: 0 }) },
  returns: MenuView,
  capability: { name: "menu.savemenu", description: "Create or change a menu (name, description, whether it is published, which locations serve it)." },
  handler: async (ctx, { id, description, ...fields }) => {
    const who = ctx.auth.requirePrincipal().id;
    const doc = { ...fields, ...(description?.trim() ? { description: description.trim() } : {}), updatedAt: Date.now(), updatedBy: who };
    let saved;
    if (id) {
      const existing = await ctx.db.get(menus, id);
      if (!existing) fail("NOT_FOUND", `No menu ${id}.`);
      saved = await ctx.db.replace(menus, id, doc);
      await record(ctx, "menu", id, "menu.updated", { before: { name: existing.name, active: existing.active }, after: { name: saved.name, active: saved.active } });
    } else {
      saved = (await ctx.db.get(menus, await ctx.db.insert(menus, doc)))!;
      await record(ctx, "menu", saved.id, "menu.created", { name: saved.name });
    }
    menuChanged(ctx, { menuId: saved.id });
    return saved;
  },
});

export const saveSection = app.mutation({
  access: "menu.write",
  approval: "required",
  args: { id: s.optional(s.string()), menuId: s.string(), name: s.string({ minLength: 1, maxLength: 80 }), position: s.integer({ minimum: 0 }) },
  returns: SectionView,
  capability: { name: "menu.savesection", description: "Create or rename a menu section." },
  handler: async (ctx, { id, ...fields }) => {
    ctx.auth.requirePrincipal();
    if (!(await ctx.db.get(menus, fields.menuId))) fail("NOT_FOUND", `No menu ${fields.menuId}.`);
    const saved = id ? await ctx.db.replace(menuSections, id, fields) : (await ctx.db.get(menuSections, await ctx.db.insert(menuSections, fields)))!;
    await record(ctx, "menu", fields.menuId, id ? "section.updated" : "section.created", { sectionId: saved.id, name: saved.name });
    menuChanged(ctx, { menuId: fields.menuId });
    return saved;
  },
});

export const saveItem = app.mutation({
  access: "menu.write",
  approval: "required",
  args: {
    id: s.optional(s.string()),
    sectionId: s.string(),
    name: s.string({ minLength: 1, maxLength: 120 }),
    description: s.optional(s.string({ maxLength: 600 })),
    priceCents: s.integer({ minimum: 0, maximum: 10_000_000 }),
    dietary: s.array(s.enum(DIETARY)),
    /** Omit when allergens have not been checked; [] declares none. */
    allergens: s.optional(s.array(s.enum(ALLERGENS))),
    available: s.boolean(),
    position: s.integer({ minimum: 0 }),
  },
  returns: ItemView,
  capability: { name: "menu.saveitem", description: "Create or change a menu item: name, description, price in cents, dietary tags, allergens (omit if not yet checked; [] for none), availability." },
  handler: async (ctx, { id, description, allergens, ...fields }) => {
    const who = ctx.auth.requirePrincipal().id;
    const section = await ctx.db.get(menuSections, fields.sectionId);
    if (!section) fail("NOT_FOUND", `No section ${fields.sectionId}.`);
    const doc = {
      ...fields,
      menuId: section.menuId,
      dietary: [...new Set(fields.dietary)],
      ...(allergens ? { allergens: [...new Set(allergens)] } : {}),
      ...(description?.trim() ? { description: description.trim() } : {}),
      updatedAt: Date.now(),
      updatedBy: who,
    };
    if (id) {
      const existing = await ctx.db.get(menuItems, id);
      if (!existing) fail("NOT_FOUND", `No menu item ${id}.`);
      const saved = await ctx.db.replace(menuItems, id, doc);
      const changed = (["name", "description", "priceCents", "dietary", "allergens", "available", "sectionId"] as const).filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(saved[k]));
      await record(ctx, "menu", section.menuId, "item.updated", {
        itemId: id,
        name: saved.name,
        changed,
        ...(changed.includes("priceCents") ? { priceCents: { before: existing.priceCents, after: saved.priceCents } } : {}),
        ...(changed.includes("available") ? { available: { before: existing.available, after: saved.available } } : {}),
      });
      menuChanged(ctx, { menuId: section.menuId, itemId: id, changed });
      return saved;
    }
    const newId = await ctx.db.insert(menuItems, doc);
    await record(ctx, "menu", section.menuId, "item.created", { itemId: newId, name: doc.name, priceCents: doc.priceCents });
    menuChanged(ctx, { menuId: section.menuId, itemId: newId });
    return (await ctx.db.get(menuItems, newId))!;
  },
});

export const setAvailability = app.mutation({
  access: "menu.write",
  approval: "required",
  args: { itemId: s.string(), available: s.boolean() },
  returns: ItemView,
  capability: { name: "menu.setavailability", description: "Mark a menu item available or sold out (86'd). Reflected on the public menu immediately." },
  handler: async (ctx, { itemId, available }) => {
    const who = ctx.auth.requirePrincipal().id;
    const existing = await ctx.db.get(menuItems, itemId);
    if (!existing) fail("NOT_FOUND", `No menu item ${itemId}.`);
    const saved = await ctx.db.patch(menuItems, itemId, { available, updatedAt: Date.now(), updatedBy: who });
    await record(ctx, "menu", existing.menuId, "item.availability", { itemId, name: existing.name, before: existing.available, after: available });
    menuChanged(ctx, { menuId: existing.menuId, itemId, changed: ["available"] });
    return saved;
  },
});

export const removeItem = app.mutation({
  access: "menu.write",
  approval: "required",
  args: { itemId: s.string() },
  returns: s.object({ removed: s.boolean() }),
  capability: { name: "menu.removeitem", description: "Remove a menu item. The audit trail keeps what it was." },
  handler: async (ctx, { itemId }) => {
    ctx.auth.requirePrincipal();
    const existing = await ctx.db.get(menuItems, itemId);
    if (!existing) return { removed: false };
    await ctx.db.delete(menuItems, itemId);
    await record(ctx, "menu", existing.menuId, "item.removed", { itemId, was: { name: existing.name, priceCents: existing.priceCents, sectionId: existing.sectionId } });
    menuChanged(ctx, { menuId: existing.menuId, itemId, changed: ["removed"] });
    return { removed: true };
  },
});
