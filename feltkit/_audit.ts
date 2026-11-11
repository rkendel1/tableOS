/**
 * The business audit trail. Every state change records an event in the same transaction as the
 * change, so the trail cannot disagree with the state: both commit, or neither. Each event carries
 * the request id that links it to FeltKit's activity log (who called which capability, the
 * authorization decision, and the writes FeltDB committed). Events are ordered per subject by a
 * FeltDB sequence, never by wall-clock time alone.
 */
import type { MutationCtx } from "@feltdb/feltkit";
import { events, SUBJECTS } from "./app.js";

type Subject = (typeof SUBJECTS)[number];

export async function record(ctx: MutationCtx, subjectType: Subject, subjectId: string, type: string, data?: Record<string, unknown>) {
  const who = ctx.auth.principal;
  await ctx.db.insert(events, {
    subjectType,
    subjectId,
    type,
    actor: who?.id ?? "public",
    actorType: who?.type ?? "anonymous",
    at: Date.now(),
    seq: await ctx.db.sequence(`audit:${subjectType}:${subjectId}`),
    requestId: ctx.requestId,
    ...(data ? { data } : {}),
  });
}

/** The caller's id and type, or the anonymous public caller. */
export function actorOf(ctx: Pick<MutationCtx, "auth">): { id: string; type: string } {
  const who = ctx.auth.principal;
  return who ? { id: who.id, type: who.type } : { id: "public", type: "anonymous" };
}
