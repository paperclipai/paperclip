import { and, eq, sql } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";

export const TOOL_APPROVAL_CONNECTION_REQUIRED = "approved_action_connection_required";
export const TOOL_APPROVAL_CONNECTION_MESSAGE = "Your approval is saved. Reconnect the app to continue. Paperclip will check the account and action again before it runs.";

export function isToolApprovalConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const typed = error as { reasonCode?: string; details?: { code?: string } };
  return ["connector_reauthorization_required", "oauth_reauthorization_required", "oauth_refresh_missing",
    "user_authorization_required", "organization_authorization_required", "agent_authorization_required",
    "vercel_connect_authorization_required"]
    .includes(typed.reasonCode ?? typed.details?.code ?? "");
}

/** Read metadata only. A waiting approval retries on a committed repair, not a timer. */
export async function toolApprovalConnectionRevision(db: Db, companyId: string,
  connectionId: string | null, snapshot: unknown): Promise<string | null> {
  if (!connectionId) return null;
  const grantId = snapshot && typeof snapshot === "object" && "credentialGrantId" in snapshot &&
    typeof snapshot.credentialGrantId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(snapshot.credentialGrantId)
    ? snapshot.credentialGrantId : null;
  const [state] = await db.select({ connectionStatus: toolConnections.status, enabled: toolConnections.enabled,
    connectionUpdatedAt: toolConnections.updatedAt, grantStatus: connectionGrants.status,
    grantUpdatedAt: connectionGrants.updatedAt }).from(toolConnections)
    .leftJoin(connectionGrants, and(eq(connectionGrants.connectionId, toolConnections.id),
      eq(connectionGrants.companyId, companyId), grantId ? eq(connectionGrants.id, grantId) : sql`false`))
    .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId))).limit(1);
  return JSON.stringify(state ?? null);
}

export async function toolApprovalConnectionCanResume(db: Db, companyId: string,
  connectionId: string | null, snapshot: unknown, previousRevision: unknown) {
  const revision = await toolApprovalConnectionRevision(db, companyId, connectionId, snapshot);
  if (revision === previousRevision) return false;
  const state = revision === null ? null : JSON.parse(revision) as { connectionStatus: string; enabled: boolean } | null;
  // Missing connections reach normal target rejection. Draft or disabled
  // connections still need repair; do not convert that wait to tool_not_found.
  return !state || (state.connectionStatus === "active" && state.enabled);
}
