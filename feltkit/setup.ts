/**
 * First-run state and a sample restaurant for development.
 *
 * The sample is fixture data for trying TableOS locally. It is refused in production and in any
 * environment that already has a restaurant, so it can never mix with a real restaurant's records.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, hoursExceptions, locations, menuItems, menus, menuSections, restaurant, reviews, tables, weeklyHours } from "./app.js";
import { record } from "./_audit.js";
import { DEFAULT_RULES } from "./_defaults.js";
import { addDays, localNow } from "./_time.js";

export const status = app.query({
  access: "restaurant.read",
  returns: s.object({ configured: s.boolean(), locations: s.integer(), production: s.boolean() }),
  handler: async (ctx) => ({
    configured: (await ctx.db.count(restaurant, {})) > 0,
    locations: await ctx.db.count(locations, {}),
    production: ctx.environment.production,
  }),
});

export const loadSample = app.mutation({
  access: "restaurant.write",
  returns: s.object({ locationId: s.string() }),
  handler: async (ctx) => {
    const who = ctx.auth.requirePrincipal().id;
    if (ctx.environment.production) fail("FAILED_PRECONDITION", "The sample restaurant is for development only.");
    if ((await ctx.db.count(restaurant, {})) > 0) fail("FAILED_PRECONDITION", "This environment already has a restaurant.");
    const now = Date.now();
    const meta = { updatedAt: now, updatedBy: who };
    const rid = await ctx.db.insert(restaurant, {
      key: "main", name: "Juniper & Salt", tagline: "Seasonal plates, wood fire, natural wine",
      description: "A neighbourhood restaurant cooking over oak with produce from farms within a hundred miles.",
      cuisine: "New American", phone: "(555) 010-2030", email: "hello@juniper.example", ...meta,
    });
    const timeZone = "America/New_York";
    const locationId = await ctx.db.insert(locations, {
      slug: "main-street", name: "Main Street", address: "214 Main Street", city: "Hudson, NY", phone: "(555) 010-2030", timeZone,
      active: true, rules: DEFAULT_RULES, createdAt: now, ...meta,
    });
    const dinner = [{ open: "17:00", close: "22:00" }];
    for (const [weekday, periods] of [[0, [{ open: "11:00", close: "14:30" }, { open: "17:00", close: "21:00" }]], [1, []], [2, dinner], [3, dinner], [4, dinner], [5, [{ open: "17:00", close: "23:00" }]], [6, [{ open: "11:00", close: "14:30" }, { open: "17:00", close: "23:00" }]]] as const) {
      await ctx.db.insert(weeklyHours, { locationId, weekday, periods: periods.map((p) => ({ ...p })), ...meta });
    }
    const today = localNow(timeZone, now).date;
    await ctx.db.insert(hoursExceptions, { locationId, date: addDays(today, 10), closed: true, periods: [], note: "Private event", ...meta });
    for (const [label, minParty, maxParty] of [["T1", 1, 2], ["T2", 1, 2], ["T3", 2, 4], ["T4", 2, 4], ["T5", 2, 4], ["T6", 4, 6], ["T7", 5, 8]] as const) {
      await ctx.db.insert(tables, { locationId, label, minParty, maxParty, active: true });
    }
    const menuId = await ctx.db.insert(menus, { name: "Dinner", description: "Served from 5pm.", active: true, locationIds: [], position: 0, ...meta });
    const sections: Record<string, string> = {};
    for (const [i, name] of ["Small plates", "Mains", "Desserts"].entries()) sections[name] = await ctx.db.insert(menuSections, { menuId, name, position: i });
    const items: Array<[string, string, string, number, string[], string[] | undefined]> = [
      ["Small plates", "Charred leeks", "Hazelnut romesco, aged sherry vinegar", 1400, ["vegetarian", "gluten_free"], ["tree_nut"]],
      ["Small plates", "Beef tartare", "Smoked yolk, sourdough crisps", 1800, [], ["egg", "gluten"]],
      ["Small plates", "Market greens", "Vegan buttermilk dressing", 1200, ["vegetarian"], undefined],
      ["Mains", "Wood-fired half chicken", "Salsa verde, potatoes", 3200, ["gluten_free"], []],
      ["Mains", "Hake", "Brown butter, capers, fennel", 3400, [], ["fish", "dairy"]],
      ["Mains", "Mushroom farrotto", "Parmesan, thyme", 2600, ["vegetarian"], ["gluten", "dairy"]],
      ["Desserts", "Olive oil cake", "Crème fraîche, poached quince", 1100, ["vegetarian"], ["gluten", "dairy", "egg"]],
    ];
    for (const [i, [section, name, description, priceCents, dietary, allergens]] of items.entries()) {
      await ctx.db.insert(menuItems, { menuId, sectionId: sections[section]!, name, description, priceCents, dietary: dietary as never, ...(allergens ? { allergens: allergens as never } : {}), available: true, position: i, ...meta });
    }
    const sample: Array<[string, number, string, string]> = [
      ["Dana P.", 5, "The wood-fired chicken was delicious and our server was attentive without hovering.", "google"],
      ["Marcus", 2, "We waited 40 minutes past our reservation time and the table wasn't ready. Food was good once it came.", "google"],
      ["Priya", 4, "Lovely atmosphere, a little loud on Saturday. The olive oil cake is worth the trip.", "yelp"],
      ["Tom W.", 1, "Slow service, cold food, and the server was rude when we asked about the wait.", "yelp"],
      ["Ines", 3, "Good food but overpriced for the portion sizes.", "tripadvisor"],
    ];
    for (const [i, [author, rating, text, source]] of sample.entries()) {
      await ctx.db.insert(reviews, {
        source: source as never, externalId: `sample-${i + 1}`, author, rating, text, reviewedAt: addDays(today, -(i * 3 + 1)), locationId,
        provenance: { method: "manual_entry", recordedBy: who, recordedAt: now, batch: "development sample (not real reviews)" },
      });
    }
    await record(ctx, "restaurant", rid, "sample.loaded", { note: "Development sample data" });
    return { locationId };
  },
});
