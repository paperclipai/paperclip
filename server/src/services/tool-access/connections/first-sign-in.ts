import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections, toolOauthStates } from "@paperclipai/db";
import type { ToolConnection, ToolConnectionRemovalResult } from "@paperclipai/shared";
import { conflict, notFound } from "../../../errors.js";
import type { ActorInfo, ToolAccessMutationDb } from "../types.js";
import { asRecord, oauthConfig } from "../oauth/metadata.js";
import { oauthSecretRef } from "../oauth/client-settings.js";
import { toConnection } from "./projection.js";
import { INLINE_OAUTH_TOKEN_FIELDS } from "./removal.js";

type ConnectionRow = typeof toolConnections.$inferSelect;
type GrantEvidence = Pick<typeof connectionGrants.$inferSelect, "connectionId" | "credentialSecretRefs" | "providerTenant" | "externalCredential">;

const OAUTH_TOKEN_PATHS = new Set(["oauth.access_token", "oauth.refresh_token"]);

function holdsInlineOAuthToken(config: unknown): boolean {
  const oauth = asRecord(asRecord(config).oauth);
  return INLINE_OAUTH_TOKEN_FIELDS.some((field) => field in oauth);
}

export function connectionHasOAuthCredential(connection: ConnectionRow, grants: GrantEvidence[]): boolean {
  const oauth = oauthConfig(connection);
  return Boolean(oauth.connectedAt || oauth.reauthorizationRequiredAt)
    || Boolean(oauthSecretRef(connection, "oauth.access_token") || oauthSecretRef(connection, "oauth.refresh_token"))
    || (connection.credentialRefs ?? []).some((ref) => OAUTH_TOKEN_PATHS.has(ref.name))
    || holdsInlineOAuthToken(connection.config)
    || holdsInlineOAuthToken(connection.transportConfig)
    || grants.some((grant) =>
      Boolean(grant.externalCredential)
      || Boolean(asRecord(asRecord(grant.providerTenant).oauth).consentedAt)
      || (grant.credentialSecretRefs ?? []).some((ref) => OAUTH_TOKEN_PATHS.has(ref.configPath)));
}

export function connectionAwaitsFirstSignIn(connection: ConnectionRow, grants: GrantEvidence[]): boolean {
  return connection.status === "draft"
    && connection.authKind === "oauth"
    && connection.lastError !== "connection_identity_rollback_failed"
    && !connectionHasOAuthCredential(connection, grants);
}

export async function lockConnectionForSignIn(
  tx: ToolAccessMutationDb,
  connection: Pick<ConnectionRow, "id" | "companyId">,
) {
  const [locked] = await tx.select({ status: toolConnections.status }).from(toolConnections)
    .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)))
    .for("update");
  if (locked?.status === "archived") {
    throw conflict("This sign-in was cancelled. Start the connection again.", { code: "oauth_sign_in_cancelled" });
  }
}

type Dependencies = {
  removeConnection(connectionId: string, companyId?: string, actor?: ActorInfo): Promise<ToolConnectionRemovalResult>;
};

async function grantEvidence(db: ToolAccessMutationDb, companyId: string, connectionIds: string[]): Promise<GrantEvidence[]> {
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

export function createFirstSignInDrafts(db: Db, { removeConnection }: Dependencies) {
  async function annotateFirstSignInPending(companyId: string, rows: ConnectionRow[], connections: ToolConnection[]) {
    const candidates = rows.filter((row) => connectionAwaitsFirstSignIn(row, []));
    if (candidates.length === 0) return;
    const grants = await grantEvidence(db, companyId, candidates.map((row) => row.id));
    const grantsByConnection = new Map<string, GrantEvidence[]>();
    for (const grant of grants) grantsByConnection.set(grant.connectionId, [...(grantsByConnection.get(grant.connectionId) ?? []), grant]);
    const pending = new Set(candidates
      .filter((row) => connectionAwaitsFirstSignIn(row, grantsByConnection.get(row.id) ?? []))
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
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(toolConnections)
        .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)))
        .for("update");
      if (!row) throw notFound("Tool connection not found");
      if (!connectionAwaitsFirstSignIn(row, await grantEvidence(tx, companyId, [row.id]))) return { abandoned: false as const, row };
      await tx.delete(toolOauthStates).where(and(eq(toolOauthStates.companyId, companyId), eq(toolOauthStates.connectionId, row.id)));
      await tx.update(toolConnections).set({ status: "archived", enabled: false, updatedAt: new Date() })
        .where(and(eq(toolConnections.id, row.id), eq(toolConnections.companyId, companyId)));
      return { abandoned: true as const, row };
    });
    if (!outcome.abandoned) return { abandoned: false, connection: toConnection(outcome.row) };
    return { abandoned: true, ...(await removeConnection(connectionId, companyId, actor)) };
  }

  return { annotateFirstSignInPending, abandonFirstSignIn };
}
