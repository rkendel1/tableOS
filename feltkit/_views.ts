/** Schemas shared by several function modules (helpers are not loaded as functions). */
import { s } from "@feltdb/feltkit";

export const GuestInput = s.object({ name: s.string({ minLength: 1, maxLength: 120 }), email: s.optional(s.string({ maxLength: 200 })), phone: s.optional(s.string({ maxLength: 40 })) });

export const BookResult = s.object({
  reservationId: s.string(), code: s.string(), status: s.string(), date: s.string(), time: s.string(),
  partySize: s.integer(), locationName: s.string(), tableLabel: s.string(), replayed: s.boolean(),
});

export const Slots = s.object({
  date: s.string(),
  partySize: s.integer(),
  open: s.boolean(),
  hoursSource: s.enum(["weekly", "exception"]),
  note: s.optional(s.string()),
  slots: s.array(s.object({ time: s.string(), available: s.boolean() })),
});
