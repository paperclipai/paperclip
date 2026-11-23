import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import type { ToolConnection, ToolConnectionRemovalResult } from "@paperclipai/shared";
import { notFound } from "../../../errors.js";
import type { ActorInfo } from "../types.js";
import { toConnection } from "./projection.js";

type ConnectionRow = typeof toolConnections.$inferSelect;
type GrantEvidence = Pick<typeof connectionGrants.$inferSelect, "connectionId" | "credentialSecretRefs" | "providerTenant" | "externalCredential">;

const OAUTH_TOKEN_PATHS = new Set(["oauth.access_token", "oauth.refresh_token"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function connectionAwaitsFirstSignIn(
  connection: Pick<ConnectionRow, "status" | "authKind" | "config" | "credentialRefs" | "credentialSecretRefs" | "lastError">,
  grants: GrantEvidence[],
): boolean {
  if (connection.status !== "draft" || connection.authKind !== "oauth" || connection.lastError === "connection_identity_rollback_failed") return false;
  const oauth = asRecord(asRecord(connection.config).oauth);
  if (oauth.connectedAt || oauth.reauthorizationRequiredAt) return false;
  if ((connection.credentialSecretRefs ?? []).some((ref) => OAUTH_TOKEN_PATHS.has(ref.configPath))) return false;
  if ((connection.credentialRefs ?? []).some((ref) => OAUTH_TOKEN_PATHS.has(ref.name))) return false;
  return !grants.some((grant) =>
    Boolean(grant.externalCredential)
    || Boolean(asRecord(asRecord(grant.providerTenant).oauth).consentedAt)
    || (grant.credentialSecretRefs ?? []).some((ref) => OAUTH_TOKEN_PATHS.has(ref.configPath)));
}

type Dependencies = {
  removeConnection(connectionId: string, companyId?: string, actor?: ActorInfo): Promise<ToolConnectionRemovalResult>;
};

export function createFirstSignInDrafts(db: Db, { removeConnection }: Dependencies) {
  async function grantEvidence(companyId: string, connectionIds: string[]): Promise<GrantEvidence[]> {
    if (connectionIds.length === 0) return [];
    return db
      .select({
        connectionId: connectionGrants.connectionId,
        credentialSecretRefs: connectionGrants.credentialSecretRefs,
        providerTenant: connectionGrants.providerTenant,
        externalCredential: connectionGrants.externalCredential,
      })
      .from(connectionGrants)
      .where(and(eq(connectionGrants.companyId, companyId), inArray(connectionGrants.connectionId, connectionIds)));
  }

  async function annotateFirstSignInPending(companyId: string, rows: ConnectionRow[], connections: ToolConnection[]) {
    const candidates = rows.filter((row) => connectionAwaitsFirstSignIn(row, []));
    if (candidates.length === 0) return;
    const grants = await grantEvidence(companyId, candidates.map((row) => row.id));
    const pending = new Set(candidates
      .filter((row) => connectionAwaitsFirstSignIn(row, grants.filter((grant) => grant.connectionId === row.id)))
      .map((row) => row.id));
    for (const connection of connections) {
      if (pending.has(connection.id)) connection.firstSignInPending = true;
    }
  }

  async function abandonFirstSignIn(
    connectionId: string,
    companyId: string,
    actor?: ActorInfo,
  ): Promise<{ abandoned: false; connection: ToolConnection } | ({ abandoned: true } & ToolConnectionRemovalResult)> {
    const [row] = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)));
    if (!row) throw notFound("Tool connection not found");
    if (!connectionAwaitsFirstSignIn(row, await grantEvidence(companyId, [row.id]))) {
      return { abandoned: false, connection: toConnection(row) };
    }
    return { abandoned: true, ...(await removeConnection(row.id, companyId, actor)) };
  }

  return { annotateFirstSignInPending, abandonFirstSignIn };
}
