/**
 * Deterministic restaurant rules that need no model: contact normalization, inquiry triage,
 * menu consistency checks, and review theme grouping. Each result says how it was produced, and
 * every conclusion links to the records it came from. A model (through MCP) may add judgement;
 * TableOS stays fully useful without one.
 */

export function emailKey(email: string | undefined): string | undefined {
  const e = email?.trim().toLowerCase();
  return e ? e : undefined;
}

/** Digits only, keeping a leading "+": "(555) 010-2030" → "5550102030". */
export function phoneKey(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const plus = phone.trim().startsWith("+");
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? (plus ? "+" : "") + digits : undefined;
}

export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ---- Inquiry triage ------------------------------------------------------------------------------

export type InquiryCategory = "reservation" | "private_event" | "menu_dietary" | "feedback" | "hours_location" | "other";

const CATEGORY_WORDS: Array<[InquiryCategory, RegExp]> = [
  ["private_event", /\b(private (event|dining|room|party)|buyout|rehearsal|wedding|corporate|banquet|large group|event)\b/i],
  ["menu_dietary", /\b(allerg\w*|gluten|vegan|vegetarian|dairy|nut|celiac|coeliac|kosher|halal|menu|dish|ingredient)s?\b/i],
  ["reservation", /\b(reserv\w*|book(ing)?|table for|party of|cancel\w*|resched\w*|waitlist)\b/i],
  ["hours_location", /\b(hours|open(ing)?|close[ds]?|parking|address|directions|holiday)\b/i],
  ["feedback", /\b(complain\w*|feedback|disappoint\w*|terrible|rude|cold food|great experience|thank you|loved)\b/i],
];

/** First matching rule wins, in the order above. "other" when nothing matches. */
export function categorizeInquiry(text: string): InquiryCategory {
  for (const [category, pattern] of CATEGORY_WORDS) if (pattern.test(text)) return category;
  return "other";
}

// ---- Menu consistency ----------------------------------------------------------------------------

export interface MenuItemLike {
  id: string;
  menuId: string;
  sectionId: string;
  name: string;
  description?: string;
  priceCents: number;
  dietary: string[];
  allergens?: string[];
  available: boolean;
}
export interface MenuIssue { itemId?: string; menuId?: string; sectionId?: string; severity: "error" | "warning"; code: string; message: string }

const ANIMAL_ALLERGENS = new Set(["dairy", "egg", "fish", "shellfish"]);

export function menuIssues(
  menus: Array<{ id: string; name: string; active: boolean }>,
  sections: Array<{ id: string; menuId: string; name: string }>,
  items: MenuItemLike[],
): MenuIssue[] {
  const out: MenuIssue[] = [];
  for (const menu of menus) {
    const mine = items.filter((i) => i.menuId === menu.id);
    if (menu.active && !mine.some((i) => i.available)) out.push({ menuId: menu.id, severity: "warning", code: "menu_nothing_available", message: `“${menu.name}” is published but has no available items.` });
    const seen = new Map<string, string>();
    for (const item of mine) {
      const key = item.name.trim().toLowerCase();
      if (seen.has(key)) out.push({ itemId: item.id, menuId: menu.id, severity: "warning", code: "duplicate_name", message: `“${item.name}” appears more than once on “${menu.name}”.` });
      seen.set(key, item.id);
    }
  }
  for (const section of sections) {
    if (!items.some((i) => i.sectionId === section.id)) out.push({ sectionId: section.id, menuId: section.menuId, severity: "warning", code: "empty_section", message: `Section “${section.name}” has no items.` });
  }
  for (const item of items) {
    const at = { itemId: item.id, menuId: item.menuId };
    if (item.priceCents === 0) out.push({ ...at, severity: "warning", code: "zero_price", message: `“${item.name}” has no price.` });
    if (!item.description?.trim()) out.push({ ...at, severity: "warning", code: "no_description", message: `“${item.name}” has no description.` });
    if (item.allergens === undefined) out.push({ ...at, severity: "warning", code: "allergens_undeclared", message: `“${item.name}” has no allergen declaration.` });
    const allergens = new Set(item.allergens ?? []);
    const diet = new Set(item.dietary);
    if (diet.has("vegan")) {
      const animal = [...allergens].filter((a) => ANIMAL_ALLERGENS.has(a));
      if (animal.length) out.push({ ...at, severity: "error", code: "vegan_contradiction", message: `“${item.name}” is marked vegan but declares ${animal.join(", ")}.` });
    }
    if (diet.has("gluten_free") && allergens.has("gluten")) out.push({ ...at, severity: "error", code: "gluten_free_contradiction", message: `“${item.name}” is marked gluten-free but declares gluten.` });
    if (diet.has("dairy_free") && allergens.has("dairy")) out.push({ ...at, severity: "error", code: "dairy_free_contradiction", message: `“${item.name}” is marked dairy-free but declares dairy.` });
    if (diet.has("nut_free") && (allergens.has("peanut") || allergens.has("tree_nut"))) out.push({ ...at, severity: "error", code: "nut_free_contradiction", message: `“${item.name}” is marked nut-free but declares nuts.` });
    const text = `${item.name} ${item.description ?? ""}`.toLowerCase();
    if (/\b(vegan)\b/.test(text) && !diet.has("vegan")) out.push({ ...at, severity: "warning", code: "dietary_mentioned_not_tagged", message: `“${item.name}” mentions vegan but is not tagged vegan.` });
    if (/\b(gluten[- ]free)\b/.test(text) && !diet.has("gluten_free")) out.push({ ...at, severity: "warning", code: "dietary_mentioned_not_tagged", message: `“${item.name}” mentions gluten-free but is not tagged gluten-free.` });
  }
  return out;
}

// ---- Review themes -------------------------------------------------------------------------------

export const THEME_METHOD = "keyword-rules-v1";

export const THEMES: Array<{ id: string; label: string; pattern: RegExp }> = [
  { id: "wait_times", label: "Waiting and pace", pattern: /\b(wait(ed|ing)?|slow|took (forever|ages)|long time|delay(ed)?|hour late|minutes for)\b/i },
  { id: "service", label: "Service and staff", pattern: /\b(server|waiter|waitress|staff|service|host(ess)?|rude|attentive|friendly|ignored)\b/i },
  { id: "food_quality", label: "Food quality", pattern: /\b(cold|bland|overcooked|undercooked|delicious|tasty|fresh|stale|salty|burnt|flavou?r)\b/i },
  { id: "value", label: "Price and value", pattern: /\b(price[ds]?|expensive|overpriced|value|worth|cheap|pricey)\b/i },
  { id: "noise_ambience", label: "Noise and ambience", pattern: /\b(noisy|loud|noise|ambien(ce|t)|atmosphere|music|cramped|cozy|cosy)\b/i },
  { id: "cleanliness", label: "Cleanliness", pattern: /\b(dirty|clean|sticky|bathroom|restroom|hygien\w*)\b/i },
  { id: "booking", label: "Reservations and seating", pattern: /\b(reservation|booking|booked|table wasn'?t ready|seated|seating)\b/i },
];

export interface ReviewLike { id: string; rating: number; text: string; source: string; reviewedAt: string; author: string }

export interface Theme {
  id: string;
  label: string;
  mentions: number;
  /** Reviews rated 1–2 that match the theme: an observation (rating + matched words), not a sentiment model. */
  negativeMentions: number;
  averageRating: number;
  evidence: Array<{ reviewId: string; rating: number; source: string; reviewedAt: string; excerpt: string }>;
}

function excerpt(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match) return text.slice(0, 160);
  const start = Math.max(0, match.index - 60);
  return (start > 0 ? "…" : "") + text.slice(start, match.index + match[0].length + 80).trim() + (match.index + match[0].length + 80 < text.length ? "…" : "");
}

/** Group reviews by keyword themes. Sorted by negative mentions, then mentions. */
export function reviewThemes(reviews: ReviewLike[]): Theme[] {
  return THEMES.map((t) => {
    const hits = reviews.filter((r) => t.pattern.test(r.text));
    return {
      id: t.id,
      label: t.label,
      mentions: hits.length,
      negativeMentions: hits.filter((r) => r.rating <= 2).length,
      averageRating: hits.length ? Math.round((hits.reduce((n, r) => n + r.rating, 0) / hits.length) * 10) / 10 : 0,
      evidence: hits
        .sort((a, b) => a.rating - b.rating || b.reviewedAt.localeCompare(a.reviewedAt))
        .map((r) => ({ reviewId: r.id, rating: r.rating, source: r.source, reviewedAt: r.reviewedAt, excerpt: excerpt(r.text, t.pattern) })),
    };
  })
    .filter((t) => t.mentions > 0)
    .sort((a, b) => b.negativeMentions - a.negativeMentions || b.mentions - a.mentions);
}
