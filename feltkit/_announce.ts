/** Announce a change to subscribed systems once the mutation commits (see publisher.ts). */
import type { MutationCtx } from "@feltdb/feltkit";

export function announce(ctx: Pick<MutationCtx, "afterCommit">, event: string, payload: Record<string, unknown>) {
  ctx.afterCommit.agent("publisher", { event, payload });
}
