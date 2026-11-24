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
const SIGN_IN_CANCELLED = "oauth_sign_in_cancelled";

function signInCancelled(connection: Pick<ConnectionRow, "status" | "lastError">): boolean {
  return connection.status === "disabled" && connection.lastError === SIGN_IN_CANCELLED;
}

export function connectionRemovedOrSignInCancelled(connection: Pick<ConnectionRow, "status" | "lastError">): boolean {
  return connection.status === "archived" || signInCancelled(connection);
}

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
  if (signInCancelled(connection)) return true;
  return connection.status === "draft"
    && connection.authKind === "oauth"
    && oauthConfig(connection).grantType !== "client_credentials"
    && connection.lastError !== "connection_identity_rollback_failed"
    && !connectionHasOAuthCredential(connection, grants);
}

export async function lockConnectionForSignIn(
  tx: ToolAccessMutationDb,
  connection: Pick<ConnectionRow, "id" | "companyId">,
) {
  const [locked] = await tx.select({ status: toolConnections.status, lastError: toolConnections.lastError }).from(toolConnections)
    .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)))
    .for("update");
  if (locked && connectionRemovedOrSignInCancelled(locked)) {
    throw conflict("This sign-in was cancelled. Start the connection again.", { code: SIGN_IN_CANCELLED });
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

class KeptConnection {
  row: ConnectionRow | null = null;
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
    const kept = new KeptConnection();
    try {
      await db.transaction(async (tx) => {
        await tx.delete(toolOauthStates).where(and(eq(toolOauthStates.companyId, companyId), eq(toolOauthStates.connectionId, connectionId)));
        const [row] = await tx.select().from(toolConnections)
          .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)))
          .for("update");
        if (!row) throw notFound("Tool connection not found");
        if (!connectionAwaitsFirstSignIn(row, await grantEvidence(tx, companyId, [row.id]))) {
          kept.row = row;
          throw kept;
        }
        await tx.update(toolConnections).set({ status: "disabled", enabled: false, lastError: SIGN_IN_CANCELLED, updatedAt: new Date() })
          .where(and(eq(toolConnections.id, row.id), eq(toolConnections.companyId, companyId)));
      });
    } catch (error) {
      if (error === kept && kept.row) return { abandoned: false, connection: toConnection(kept.row) };
      throw error;
    }
    return { abandoned: true, ...(await removeConnection(connectionId, companyId, actor)) };
  }

  return { annotateFirstSignInPending, abandonFirstSignIn };
}
