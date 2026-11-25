import type { Db } from "@paperclipai/db";
import { companySecrets, connectionGrants, googlePendingRevocations, toolAccessAuditEvents, toolConnections } from "@paperclipai/db";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { ManagedGoogleAccessRemoval, ManagedGoogleRevocationOutcome } from "@paperclipai/shared";
import { logger } from "../../../middleware/logger.js";
import { resolveConnectionGrantSecret } from "../../connection-credentials.js";
import { isPaperclipCloudConnectorStrategy, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { managedConnectorConsentSubject, managedConnectorProfile } from "../oauth/client-settings.js";
import { oauthConfig } from "../oauth/metadata.js";
import {
  dropQueuedGoogleRevocation,
  googleRevocationOutcomeForError,
  isRetryableGoogleRevocationOutcome,
  queueGoogleRevocationFromSecret,
  settleQueuedGoogleRevocation,
  tokenInLiveUse,
} from "./google-pending-revocation.js";
import type { ActorInfo } from "../types.js";
import { actorBinding } from "../actor.js";

export const MANAGED_GOOGLE_REVOKE_TIMEOUT_MS = 5_000;

type RemovedGrant = Pick<typeof connectionGrants.$inferSelect,
  "id" | "companyId" | "connectionId" | "status" | "kind" | "subjectUserId" | "subjectAgentId" | "credentialSecretRefs" | "providerTenant">;

type PreparedRevocation =
  | { kind: "call"; subject: string; token: string; grantId: string; secretId: string; version: number }
  | { kind: "skip"; outcome: ManagedGoogleRevocationOutcome };

export type PreparedGoogleAccessRemoval = {
  send(): Promise<ManagedGoogleAccessRemoval>;
};

export type GoogleAccessRemovalScope = {
  grantId?: string;
  removingConnection: boolean;
  canRemoveSecret?(secretId: string): Promise<boolean>;
  removeSecret(secretId: string, expectedVersion: number): Promise<unknown>;
};

function refreshSecretId(grant: RemovedGrant): string | null {
  return (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token")?.secretId ?? null;
}

export function summarizeManagedGoogleAccess(outcomes: ManagedGoogleRevocationOutcome[], retrying = 0): ManagedGoogleAccessRemoval {
  const revoked = outcomes.filter((outcome) => outcome === "revoked").length;
  const remaining = outcomes.filter((outcome) => outcome === "other_connections_remain").length;
  const result: ManagedGoogleAccessRemoval["result"] = revoked + remaining + retrying < outcomes.length
    ? "not_ended"
    : retrying > 0
      ? "retrying"
      : revoked === outcomes.length
      ? "ended"
      : revoked === 0
        ? "other_connections_remain"
        : "ended_unconfirmed";
  return { provider: "google", result, outcomes };
}

export function createManagedGoogleAccessRemoval(db: Db, deps: {
  currentCloudConnector: () => PaperclipCloudConnector | null;
  timeoutMs?: number;
  now?: () => number;
}) {
  const timeoutMs = deps.timeoutMs ?? MANAGED_GOOGLE_REVOKE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function send(
    connection: typeof toolConnections.$inferSelect,
    profile: string,
    revocations: PreparedRevocation[],
    reason: "connection_removed" | "grant_revoked",
  ): Promise<{ outcomes: ManagedGoogleRevocationOutcome[]; retrying: Array<{ id: string; secretId: string }> }> {
    const outcomes: ManagedGoogleRevocationOutcome[] = [];
    const retrying: Array<{ id: string; secretId: string }> = [];
    let connector: PaperclipCloudConnector | null = null;
    let connectorUnavailable = false;
    try {
      connector = deps.currentCloudConnector();
    } catch {
      connectorUnavailable = true;
    }
    const deadline = now() + timeoutMs;
    for (const revocation of revocations) {
      if (revocation.kind === "skip") {
        outcomes.push(revocation.outcome);
        continue;
      }
      let pendingId: string | null = null;
      try {
        pendingId = await queueGoogleRevocationFromSecret(db, {
          companyId: connection.companyId, connectionId: connection.id, grantId: revocation.grantId,
          subject: revocation.subject, profile, secretId: revocation.secretId, version: revocation.version, reason,
        });
      } catch (error) {
        logger.warn(
          { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
          "Could not keep a Google refresh token for a retry",
        );
      }
      const remaining = deadline - now();
      let outcome: ManagedGoogleRevocationOutcome;
      if (connectorUnavailable || !connector || remaining <= 0) {
        outcome = "broker_unavailable";
      } else {
        try {
          outcome = (await connector.revoke({
            subject: revocation.subject,
            companyId: connection.companyId,
            profile: profile as Parameters<PaperclipCloudConnector["revoke"]>[0]["profile"],
            token: revocation.token,
            timeoutMs: remaining,
          })).outcome ?? "broker_error";
        } catch (error) {
          outcome = googleRevocationOutcomeForError(error);
        }
      }
      outcomes.push(outcome);
      if (!pendingId) continue;
      try {
        if (await settleQueuedGoogleRevocation(db, connection.companyId, pendingId, outcome)) retrying.push({ id: pendingId, secretId: revocation.secretId });
      } catch (error) {
        if (isRetryableGoogleRevocationOutcome(outcome)) retrying.push({ id: pendingId, secretId: revocation.secretId });
        logger.warn(
          { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
          "Could not record the first attempt to end Google access",
        );
      }
    }
    return { outcomes, retrying };
  }

  async function keepRetryingUnusedTokens(
    connection: typeof toolConnections.$inferSelect,
    retrying: Array<{ id: string; secretId: string }>,
  ): Promise<number> {
    let kept = 0;
    for (const entry of retrying) {
      const [row] = await db.select({ tokenSha256: googlePendingRevocations.tokenSha256, reason: googlePendingRevocations.reason })
        .from(googlePendingRevocations)
        .where(and(eq(googlePendingRevocations.id, entry.id), eq(googlePendingRevocations.companyId, connection.companyId)));
      if (row && (row.reason === "instance_removed" || !(await tokenInLiveUse(db, connection.companyId, row.tokenSha256)))) {
        kept += 1;
        continue;
      }
      if (row) await dropQueuedGoogleRevocation(db, connection.companyId, entry.id);
    }
    return kept;
  }


  function unexpectedFailure(connection: typeof toolConnections.$inferSelect, error: unknown): PreparedGoogleAccessRemoval {
    logger.warn(
      { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
      "Could not prepare ending Google access for a removed connection",
    );
    return { send: async () => summarizeManagedGoogleAccess(["unexpected_error"]) };
  }

  async function recordAudit(
    connection: typeof toolConnections.$inferSelect,
    actor: ActorInfo | undefined,
    scope: GoogleAccessRemovalScope,
    providerAccess: ManagedGoogleAccessRemoval,
  ) {
    try {
      const binding = actorBinding(actor);
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection.google_access_removal",
        outcome: providerAccess.result === "not_ended" || providerAccess.result === "retrying" ? "failure" : "success",
        reasonCode: providerAccess.result,
        details: { ...(scope.grantId ? { grantId: scope.grantId } : {}), providerAccess },
      });
    } catch (error) {
      logger.warn(
        { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
        "Could not record the Google access result for a removed connection",
      );
    }
  }

  async function secretsHeldElsewhere(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    secretIds: string[],
    removingConnection: boolean,
  ): Promise<Set<string>> {
    if (secretIds.length === 0) return new Set();
    const wanted = new Set(secretIds);
    const removedGrantIds = new Set(grants.map((grant) => grant.id));
    const held = new Set<string>();
    const liveGrants = await db.select({ id: connectionGrants.id, connectionId: connectionGrants.connectionId, refs: connectionGrants.credentialSecretRefs })
      .from(connectionGrants)
      .where(and(eq(connectionGrants.companyId, connection.companyId), ne(connectionGrants.status, "revoked")));
    for (const row of liveGrants) {
      if (removedGrantIds.has(row.id) || (removingConnection && row.connectionId === connection.id)) continue;
      for (const ref of row.refs ?? []) if (wanted.has(ref.secretId)) held.add(ref.secretId);
    }
    const liveConnections = await db.select({ id: toolConnections.id, refs: toolConnections.credentialRefs, secretRefs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, connection.companyId), ne(toolConnections.status, "archived")));
    for (const row of liveConnections) {
      if (removingConnection && row.id === connection.id) continue;
      for (const ref of [...(row.refs ?? []), ...(row.secretRefs ?? [])]) if (wanted.has(ref.secretId)) held.add(ref.secretId);
    }
    return held;
  }

  async function deleteSentSecrets(
    connection: typeof toolConnections.$inferSelect,
    scope: GoogleAccessRemovalScope,
    sent: Array<{ secretId: string; version: number }>,
  ) {
    for (const { secretId, version } of sent) {
      try {
        if (scope.canRemoveSecret && !(await scope.canRemoveSecret(secretId))) continue;
        await scope.removeSecret(secretId, version);
      } catch (error) {
        logger.warn(
          { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
          "Could not delete a refresh token after ending Google access",
        );
      }
    }
  }

  async function prepare(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    actor: ActorInfo | undefined,
    scope: GoogleAccessRemovalScope,
  ): Promise<PreparedGoogleAccessRemoval | null> {
    const oauth = oauthConfig(connection);
    if (connection.authKind !== "oauth" || !isPaperclipCloudConnectorStrategy(oauth.strategy)) return null;
    const profile = managedConnectorProfile(typeof oauth.connectorProfile === "string" ? oauth.connectorProfile : undefined);
    if (profile?.provider !== "google") return null;
    try {
      const revokedSecretIds = grants.flatMap((grant) => {
        const secretId = grant.status === "revoked" ? refreshSecretId(grant) : null;
        return secretId ? [secretId] : [];
      });
      const stillStored = new Set(revokedSecretIds.length === 0 ? [] : (await db.select({ id: companySecrets.id }).from(companySecrets)
        .where(and(eq(companySecrets.companyId, connection.companyId), inArray(companySecrets.id, revokedSecretIds), isNull(companySecrets.deletedAt))))
        .map((row) => row.id));
      const candidateSecretIds = grants.flatMap((grant) => {
        const secretId = refreshSecretId(grant);
        return secretId ? [secretId] : [];
      });
      const held = await secretsHeldElsewhere(connection, grants, candidateSecretIds, scope.removingConnection);
      const seen = new Set<string>();
      const revocations: PreparedRevocation[] = [];
      const sentSecrets: Array<{ secretId: string; version: number }> = [];
      for (const grant of grants) {
        const secretId = refreshSecretId(grant);
        const refreshRef = (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token");
        if (!secretId || !refreshRef || seen.has(secretId)) continue;
        if (grant.status === "revoked" && !stillStored.has(secretId)) continue;
        if (held.has(secretId)) continue;
        seen.add(secretId);
        const subject = managedConnectorConsentSubject(grant, oauth);
        if (!subject) {
          revocations.push({ kind: "skip", outcome: "credential_unavailable" });
          continue;
        }
        try {
          const { value, latestVersion } = await resolveConnectionGrantSecret(db, connection, grant, refreshRef, {
            consumerType: "tool_connection",
            consumerId: connection.id,
            actorType: actor?.actorType ?? "system",
            actorId: actor?.actorId ?? null,
          });
          const sentVersion = typeof refreshRef.versionSelector === "number" ? refreshRef.versionSelector : latestVersion;
          revocations.push({ kind: "call", subject, token: value, grantId: grant.id, secretId, version: sentVersion });
          sentSecrets.push({ secretId, version: latestVersion });
        } catch {
          revocations.push({ kind: "skip", outcome: "credential_unavailable" });
        }
      }
      if (revocations.length === 0) return null;
      return {
        send: async () => {
          let sent: Awaited<ReturnType<typeof send>> | null = null;
          try {
            sent = await send(connection, profile.id, revocations, scope.grantId ? "grant_revoked" : "connection_removed");
          } catch (error) {
            await unexpectedFailure(connection, error).send();
          }
          await deleteSentSecrets(connection, scope, sentSecrets);
          let retrying = 0;
          if (sent) {
            try {
              retrying = await keepRetryingUnusedTokens(connection, sent.retrying);
            } catch {
              retrying = sent.retrying.length;
            }
          }
          const summary = sent ? summarizeManagedGoogleAccess(sent.outcomes, retrying) : summarizeManagedGoogleAccess(["unexpected_error"]);
          if (summary.result === "not_ended" || summary.result === "retrying") {
            logger.warn(
              { companyId: connection.companyId, connectionId: connection.id, result: summary.result, outcomes: summary.outcomes },
              "Paperclip Cloud did not end Google access for a removed connection",
            );
          }
          await recordAudit(connection, actor, scope, summary);
          return summary;
        },
      };
    } catch (error) {
      const failed = unexpectedFailure(connection, error);
      return {
        send: async () => {
          const summary = await failed.send();
          await recordAudit(connection, actor, scope, summary);
          return summary;
        },
      };
    }
  }

  return { prepare };
}
