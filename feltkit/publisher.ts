/**
 * The publisher: TableOS's own application agent (a deterministic handler, not a model) that
 * announces committed changes to subscribed systems as webhooks.
 *
 * Why an application agent: many changes come from the public site, where the caller is anonymous.
 * AppPort Services refuse an effect with no principal, so `ctx.afterCommit.webhooks.emit` cannot be
 * used there. `ctx.afterCommit.agent("publisher", …)` is staged in the mutation's own transaction
 * (recorded if and only if the change commits, even for an anonymous caller), then FeltKit's
 * services worker runs this handler as the publisher's own principal, at least once, with retries.
 * All announcements go through it, so every webhook has one consistent, attributable emitter.
 */
import { app } from "./app.js";

export const publisher = app.agent("publisher", {
  principal: { id: "tableos-publisher", displayName: "TableOS publisher" },
  roles: ["publisher"],
  access: "webhooks.emit",
  description: "Announces committed TableOS changes to subscribed systems (webhooks).",
  handler: async (ctx, input) => {
    const { event, payload } = input as { event: string; payload: Record<string, unknown> };
    // Keyed by the trigger, so a retried run does not announce twice.
    await ctx.services.webhooks.emit(event, { ...payload, announcementId: ctx.trigger.idempotencyKey });
  },
});

