import { githubAutomaticAdmission } from "../../chat-github-events.js";
import type { Db } from "@paperclipai/db";
import { githubResponseCommentService } from "../../chat-github-response-comments.js";
import type { DbOrTransaction, EndpointRow } from "../runtime-types.js";
import type { chatDeliveries } from "@paperclipai/db";
import type { GitHubAutomaticEventContext } from "@paperclipai/shared";
export async function resolveGitHubWakeAuthority(tx: DbOrTransaction, endpoint: EndpointRow, delivery: typeof chatDeliveries.$inferSelect): Promise<{ kind: "not_automatic" } | { kind: "denied" } | { kind: "allowed"; userId: string | null }> {
  const automatic = (delivery.normalizedEvent.githubAutomatic ?? delivery.normalizedEvent.githubIssue) as { context: GitHubAutomaticEventContext } | undefined;
  if (!automatic) return { kind: "not_automatic" };
  const admission = await githubAutomaticAdmission(tx, endpoint, automatic.context);
  if (!admission?.allowed) return { kind: "denied" };
  return { kind: "allowed", userId: admission.responsibleUserId ?? null };
}

export function isGitHubAutomaticDelivery(delivery: Pick<typeof chatDeliveries.$inferSelect, "normalizedEvent">): boolean { return Boolean(delivery.normalizedEvent.githubAutomatic); }
export async function acknowledgeGitHubWakeup(db: Db, fetchImpl: typeof globalThis.fetch, deliveryId: string): Promise<void> { await githubResponseCommentService(db, fetchImpl).tryAcknowledge(deliveryId); }
