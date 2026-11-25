import { and, eq, sql } from "drizzle-orm";
import { chatEndpoints, chatSdkState, type Db } from "@paperclipai/db";
import { GITHUB_RECOVERY_STATE_KEY } from "./webhook-recovery-state.js";
import type { ChatActivityGitHubContext } from "@paperclipai/shared";

/** Direct callback recovery warnings do not describe Cloud relay delivery. */
export async function githubRecoveryActivity(
  db: Db,
  endpointId: string,
  before?: { createdAt: string; id: string },
) {
  const rows = await db
    .select({ id: chatSdkState.id, value: chatSdkState.value, updatedAt: chatSdkState.updatedAt })
    .from(chatSdkState)
    .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatSdkState.endpointId))
    .where(and(
      eq(chatSdkState.endpointId, endpointId),
      eq(chatSdkState.stateKey, GITHUB_RECOVERY_STATE_KEY),
      sql`nullif(${chatEndpoints.setup}#>>'{github,cloudRegistrationId}', '') is null`,
      before ? sql`(date_trunc('milliseconds', ${chatSdkState.updatedAt}), ${chatSdkState.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)` : undefined,
    ))
    .limit(1);
  return rows.flatMap((row) => {
    const value = row.value as { outcome?: string } | null;
    const detail =
      value?.outcome === "history_limit_reached"
        ? "Recent webhook volume exceeded automatic recovery's bounded scan. No partial history was replayed. Check the App's Recent Deliveries for missed messages."
        : value?.outcome === "callback_mismatch"
          ? "The GitHub App's callback no longer matches this connection. Reconnect the App to repair it; repository access will not change."
          : value?.outcome === "scan_failed"
            ? "Paperclip could not check GitHub's failed deliveries. The check will retry with backoff; normal callbacks are still processed."
            : null;
    return detail
      ? [
          {
            id: row.id,
            kind: "health" as const,
            status: "attention",
            summary: "GitHub webhook recovery needs attention",
            detail,
            createdAt: row.updatedAt.toISOString(),
            replayable: false,
            resolutionActions: [],
          },
        ]
      : [];
  });
}

export function githubFilteredDeliveryContext(value: unknown): ChatActivityGitHubContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" && record[key] ? record[key] as string : undefined;
  const count = (key: string) => Number.isSafeInteger(record[key]) && (record[key] as number) > 0 ? record[key] as number : undefined;
  const deliveryId = text("deliveryId"), event = text("event"), repository = text("repository"), reason = text("reason");
  if (!deliveryId || !event || !repository || !reason) return null;
  const pullNumber = count("pullNumber"), issueNumber = count("issueNumber"), headSha = text("headSha");
  return {
    deliveryId, event, repository,
    ...(pullNumber ? { pullNumber } : {}), ...(issueNumber ? { issueNumber } : {}), ...(headSha ? { headSha } : {}),
    reason,
  };
}
