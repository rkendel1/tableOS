/** Enumerations shared by the backend schema and the frontend. No imports: safe in the browser bundle. */
export const DIETARY = ["vegetarian", "vegan", "gluten_free", "dairy_free", "nut_free", "halal", "kosher", "spicy"] as const;
export const ALLERGENS = ["gluten", "dairy", "egg", "peanut", "tree_nut", "soy", "fish", "shellfish", "sesame", "mustard", "celery", "sulphites"] as const;
export const RESERVATION_STATUS = ["booked", "seated", "completed", "cancelled", "no_show"] as const;
export const INQUIRY_CATEGORIES = ["reservation", "private_event", "menu_dietary", "feedback", "hours_location", "other"] as const;
export const REVIEW_SOURCES = ["direct", "google", "yelp", "tripadvisor", "opentable", "other"] as const;
export const SUBJECT_TYPES = ["restaurant", "location", "hours", "table", "menu", "reservation", "waitlist", "guest", "inquiry", "review"] as const;
