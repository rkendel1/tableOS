/**
 * TableOS: a restaurant front-office application on FeltKit.
 *
 * TableOS owns the restaurant's canonical records and its business rules. FeltKit/FeltDB own
 * durable state, transactions and the activity log; AppPort owns capability contracts and
 * authorization; AppPort Services own notifications and webhook delivery. The public website,
 * webhook subscribers and agents are all projections of — or callers into — these records.
 *
 * Money is integer cents. Dates are "YYYY-MM-DD" and times "HH:MM" in the location's own time zone.
 */
import { feltkit, s } from "@feltdb/feltkit";

// ---- Roles --------------------------------------------------------------------------------------

const READ = [
  "restaurant.read", "hours.read", "menu.read", "reservations.read", "waitlist.read",
  "guests.read", "inquiries.read", "reviews.read", "insights.read", "audit.read",
];

export const app = feltkit({
  name: "tableos",
  version: "0.1.0",
  description: "Restaurant front office: profile, locations, hours, menus, reservations, waitlist, inquiries, guests and reviews.",
  roles: {
    // Owners and managers run the restaurant: canonical information, menus, bookings, guests,
    // customer communication, reviews. Approving an agent's proposal requires holding the permission.
    manager: [
      ...READ,
      "restaurant.write", "hours.write", "tables.write", "menu.write",
      "reservations.write", "reservations.cancel", "reservations.floor", "waitlist.write",
      "guests.write", "inquiries.write", "inquiries.send", "reviews.write", "reviews.draft", "reviews.respond",
      "feltkit.agent.*",
    ],
    // Hosts run the floor: bookings, waitlist, arrivals, guest notes, inquiries. They cannot change
    // canonical restaurant information, menus or publish review responses.
    host: [
      ...READ,
      "reservations.write", "reservations.cancel", "reservations.floor", "waitlist.write",
      "guests.write", "inquiries.write", "inquiries.send", "feltkit.agent.read",
    ],
    // Read-only staff (servers, auditors).
    staff: [...READ, "feltkit.agent.read"],
    // The front-office agent reads everything and drafts. It may book for a guest who confirmed.
    // It holds hours/menu/cancel permissions only through approval: every such function is
    // `approval: "required"`, so an agent can propose it and a person who may perform it approves.
    agent: [
      ...READ,
      "reservations.write", "waitlist.write", "inquiries.write", "reviews.draft",
      "hours.write", "menu.write", "reservations.cancel",
      "feltkit.agent.*",
    ],
    // The publisher application agent (feltkit/publisher.ts): announces committed changes as webhooks.
    publisher: ["webhooks.emit", "webhooks.deliver"],
    // Platform administration in Studio (services, credentials, the model). Not a restaurant role.
    admin: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  // Self-service accounts get read-only staff access; a manager's operator assigns real roles.
  auth: { accounts: { roles: ["staff"] } },
  dev: {
    users: [
      { id: "maria", name: "Maria Rossi (Manager)", roles: ["manager", "admin"] },
      { id: "sam", name: "Sam Okafor (Host)", roles: ["host"] },
      { id: "lee", name: "Lee Chen (Staff)", roles: ["staff"] },
      { id: "frontdesk-agent", name: "Front-desk Agent", roles: ["agent"], type: "agent" },
    ],
  },
  services: {
    // External projections and downstream systems (website builders, listing sync, a mailer) subscribe in
    // Studio → Services → Webhooks. Delivery status, retries and failures are recorded by AppPort Services.
    webhooks: {
      events: [
        "restaurant.changed", "hours.changed", "menu.changed",
        "reservation.booked", "reservation.changed", "reservation.cancelled",
        "inquiry.received", "message.ready", "review.response.approved",
      ],
    },
    configuration: true,
    intelligence: true,
  },
});

// ---- Shared shapes ------------------------------------------------------------------------------

/** "HH:MM", 00:00–24:00. */
export const Clock = s.string({ pattern: "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$" });
export const DateString = s.string({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
export const Period = s.object({ open: Clock, close: Clock });

export { DIETARY, ALLERGENS, RESERVATION_STATUS, INQUIRY_CATEGORIES, REVIEW_SOURCES } from "./_constants.js";
import { DIETARY, ALLERGENS, RESERVATION_STATUS, INQUIRY_CATEGORIES, REVIEW_SOURCES, SUBJECT_TYPES } from "./_constants.js";

// ---- Restaurant and locations -------------------------------------------------------------------

export const restaurant = app.collection("restaurant", {
  key: s.enum(["main"]),
  name: s.string({ minLength: 1, maxLength: 120 }),
  tagline: s.optional(s.string({ maxLength: 200 })),
  description: s.optional(s.string({ maxLength: 4000 })),
  cuisine: s.optional(s.string({ maxLength: 120 })),
  phone: s.optional(s.string({ maxLength: 40 })),
  email: s.optional(s.string({ maxLength: 200 })),
  website: s.optional(s.string({ maxLength: 300 })),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { unique: [["key"]], description: "The restaurant's canonical identity (one per application)." });

export const ReservationRules = s.object({
  accepting: s.boolean(),
  slotMinutes: s.integer({ minimum: 5, maximum: 120 }),
  durationMinutes: s.integer({ minimum: 15, maximum: 480 }),
  minPartySize: s.integer({ minimum: 1, maximum: 100 }),
  maxPartySize: s.integer({ minimum: 1, maximum: 100 }),
  minLeadMinutes: s.integer({ minimum: 0, maximum: 10080 }),
  maxDaysAhead: s.integer({ minimum: 0, maximum: 365 }),
  lastSeatingBeforeCloseMinutes: s.integer({ minimum: 0, maximum: 480 }),
});

export const locations = app.collection("locations", {
  slug: s.string({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
  name: s.string({ minLength: 1, maxLength: 120 }),
  address: s.string({ minLength: 1, maxLength: 300 }),
  city: s.string({ minLength: 1, maxLength: 120 }),
  phone: s.optional(s.string({ maxLength: 40 })),
  /** IANA time zone, e.g. "America/New_York". Every date and time at this location is local to it. */
  timeZone: s.string({ minLength: 1, maxLength: 64 }),
  active: s.boolean(),
  rules: ReservationRules,
  createdAt: s.number(),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { unique: [["slug"]], description: "Where the restaurant operates, and each location's booking rules." });

export const weeklyHours = app.collection("weeklyHours", {
  locationId: s.ref("locations"),
  /** 0 = Sunday … 6 = Saturday. */
  weekday: s.integer({ minimum: 0, maximum: 6 }),
  /** Empty: closed that day. Periods do not overlap and close the same day. */
  periods: s.array(Period),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { unique: [["locationId", "weekday"]], description: "Regular opening hours per location and weekday." });

export const hoursExceptions = app.collection("hoursExceptions", {
  locationId: s.ref("locations"),
  date: DateString,
  closed: s.boolean(),
  periods: s.array(Period),
  note: s.optional(s.string({ maxLength: 200 })),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { unique: [["locationId", "date"]], description: "Special hours and closures that replace the weekly hours on one date." });

export const tables = app.collection("tables", {
  locationId: s.ref("locations"),
  label: s.string({ minLength: 1, maxLength: 20 }),
  minParty: s.integer({ minimum: 1, maximum: 100 }),
  maxParty: s.integer({ minimum: 1, maximum: 100 }),
  active: s.boolean(),
}, { unique: [["locationId", "label"]], description: "Bookable tables and the party sizes each seats." });

// ---- Menus --------------------------------------------------------------------------------------

export const menus = app.collection("menus", {
  name: s.string({ minLength: 1, maxLength: 80 }),
  description: s.optional(s.string({ maxLength: 500 })),
  active: s.boolean(),
  /** Empty: served at every location. */
  locationIds: s.array(s.string()),
  position: s.integer({ minimum: 0 }),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { description: "Menus (dinner, brunch, drinks…)." });

export const menuSections = app.collection("menuSections", {
  menuId: s.ref("menus"),
  name: s.string({ minLength: 1, maxLength: 80 }),
  position: s.integer({ minimum: 0 }),
}, { description: "Sections of a menu." });

export const menuItems = app.collection("menuItems", {
  menuId: s.ref("menus"),
  sectionId: s.ref("menuSections"),
  name: s.string({ minLength: 1, maxLength: 120 }),
  description: s.optional(s.string({ maxLength: 600 })),
  priceCents: s.integer({ minimum: 0, maximum: 10_000_000 }),
  dietary: s.array(s.enum(DIETARY)),
  /** Absent: allergens not yet declared (shown as "ask your server"). Empty: declared none. */
  allergens: s.optional(s.array(s.enum(ALLERGENS))),
  available: s.boolean(),
  position: s.integer({ minimum: 0 }),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { indexes: [{ fields: ["menuId"] }], description: "Dishes and drinks: price, dietary and allergen information, availability." });

// ---- Guests, reservations, waitlist -------------------------------------------------------------

export const guests = app.collection("guests", {
  name: s.string({ minLength: 1, maxLength: 120 }),
  email: s.optional(s.string({ maxLength: 200 })),
  phone: s.optional(s.string({ maxLength: 40 })),
  /** Normalized contact keys used to recognise a returning guest. */
  emailKey: s.optional(s.string()),
  phoneKey: s.optional(s.string()),
  /** Preferences the guest stated or staff observed, each with who recorded it. Never inferred. */
  preferences: s.array(s.object({ note: s.string({ minLength: 1, maxLength: 500 }), recordedBy: s.string(), recordedAt: s.number() })),
  tags: s.array(s.string({ maxLength: 40 })),
  createdAt: s.number(),
}, {
  unique: [{ fields: ["emailKey"], sparse: true }, { fields: ["phoneKey"], sparse: true }],
  search: ["name", "email", "phone"],
  description: "Guest profiles. Contact details are visible only to staff roles.",
});

export const reservations = app.collection("reservations", {
  locationId: s.ref("locations"),
  guestId: s.ref("guests"),
  tableId: s.ref("tables"),
  partySize: s.integer({ minimum: 1, maximum: 100 }),
  date: DateString,
  time: Clock,
  startMin: s.integer({ minimum: 0, maximum: 1440 }),
  endMin: s.integer({ minimum: 0, maximum: 2000 }),
  status: s.enum(RESERVATION_STATUS),
  source: s.enum(["staff", "public", "agent", "waitlist"]),
  specialRequests: s.optional(s.string({ maxLength: 500 })),
  /** Client-chosen key: the same key books once. */
  idempotencyKey: s.string({ minLength: 8, maxLength: 120 }),
  /** Bearer code the guest holds to view or cancel their own booking. */
  code: s.string(),
  cancelReason: s.optional(s.string({ maxLength: 300 })),
  createdAt: s.number(),
  createdBy: s.string(),
  updatedAt: s.number(),
}, {
  unique: [["idempotencyKey"], ["code"]],
  indexes: [{ fields: ["locationId", "date"] }, { fields: ["guestId"] }],
  description: "Reservations. Every change is in the audit trail; nothing is deleted.",
});

export const waitlist = app.collection("waitlist", {
  locationId: s.ref("locations"),
  guestId: s.ref("guests"),
  date: DateString,
  partySize: s.integer({ minimum: 1, maximum: 100 }),
  preferredTime: s.optional(Clock),
  status: s.enum(["waiting", "booked", "removed"]),
  reservationId: s.optional(s.string()),
  note: s.optional(s.string({ maxLength: 300 })),
  createdAt: s.number(),
  createdBy: s.string(),
}, { indexes: [{ fields: ["locationId", "date"] }], description: "Guests waiting for a table on a date." });

// ---- Inquiries and communication ---------------------------------------------------------------

export const inquiries = app.collection("inquiries", {
  guestId: s.ref("guests"),
  locationId: s.optional(s.string()),
  subject: s.string({ minLength: 1, maxLength: 200 }),
  category: s.enum(INQUIRY_CATEGORIES),
  categorizedBy: s.enum(["rules", "person"]),
  channel: s.enum(["web", "phone", "email", "in_person"]),
  status: s.enum(["open", "awaiting_guest", "closed"]),
  createdAt: s.number(),
  lastMessageAt: s.number(),
}, { search: ["subject"], description: "Questions and requests from guests." });

export const messages = app.collection("messages", {
  inquiryId: s.ref("inquiries"),
  direction: s.enum(["inbound", "outbound"]),
  body: s.string({ minLength: 1, maxLength: 8000 }),
  /**
   * inbound: received. outbound: draft → ready (a person approved the text; handed to subscribed
   * senders by webhook) → sent (a person recorded how it reached the guest). TableOS has no
   * outbound e-mail/SMS channel of its own, so it never marks a message sent by itself.
   */
  status: s.enum(["received", "draft", "ready", "sent"]),
  author: s.string(),
  authorType: s.string(),
  approvedBy: s.optional(s.string()),
  sentVia: s.optional(s.string({ maxLength: 200 })),
  sentRecordedBy: s.optional(s.string()),
  at: s.number(),
}, { indexes: [{ fields: ["inquiryId"] }], description: "The communication history of each inquiry." });

// ---- Reviews ------------------------------------------------------------------------------------

export const reviews = app.collection("reviews", {
  source: s.enum(REVIEW_SOURCES),
  /** The source's own id; for directly collected feedback, TableOS assigns one. */
  externalId: s.string({ minLength: 1, maxLength: 200 }),
  url: s.optional(s.string({ maxLength: 500 })),
  locationId: s.optional(s.string()),
  author: s.string({ minLength: 1, maxLength: 120 }),
  rating: s.integer({ minimum: 1, maximum: 5 }),
  text: s.string({ maxLength: 8000 }),
  /** When the review was written, as the source states it. */
  reviewedAt: DateString,
  /** How TableOS came to hold it: who entered or imported it, when, and from what. */
  provenance: s.object({
    method: s.enum(["manual_entry", "import", "guest_feedback"]),
    recordedBy: s.string(),
    recordedAt: s.number(),
    batch: s.optional(s.string({ maxLength: 200 })),
  }),
  response: s.optional(s.object({
    text: s.string({ minLength: 1, maxLength: 4000 }),
    draftedBy: s.string(),
    draftedByType: s.string(),
    draftedAt: s.number(),
    status: s.enum(["draft", "approved", "published"]),
    approvedBy: s.optional(s.string()),
    approvedAt: s.optional(s.number()),
    /** Evidence a person supplied that the response appears on the source. */
    publishedUrl: s.optional(s.string({ maxLength: 500 })),
    publishedRecordedBy: s.optional(s.string()),
    publishedAt: s.optional(s.number()),
  })),
}, { unique: [["source", "externalId"]], search: ["text", "author"], description: "Reviews with their source and provenance, and our responses." });

// ---- Audit trail --------------------------------------------------------------------------------

export const SUBJECTS = SUBJECT_TYPES;

export const events = app.collection("events", {
  subjectType: s.enum(SUBJECTS),
  subjectId: s.string(),
  type: s.string(),
  actor: s.string(),
  actorType: s.string(),
  at: s.number(),
  seq: s.integer({ minimum: 0 }),
  requestId: s.string(),
  data: s.optional(s.record(s.unknown())),
}, {
  indexes: [{ fields: ["subjectType", "subjectId"] }, { fields: ["at"] }],
  description: "Append-only business audit trail, written in the same transaction as each change.",
});
