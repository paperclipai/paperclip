import type { Db } from "@paperclipai/db";
import { companySecrets, connectionGrants, toolAccessAuditEvents, toolConnections } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ManagedGoogleAccessRemoval, ManagedGoogleRevocationOutcome } from "@paperclipai/shared";
import { logger } from "../../../middleware/logger.js";
import { resolveConnectionGrantSecret } from "../../connection-credentials.js";
import { isPaperclipCloudConnectorStrategy, PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { managedConnectorConsentSubject, managedConnectorProfile } from "../oauth/client-settings.js";
import { oauthConfig } from "../oauth/metadata.js";
import type { ActorInfo } from "../types.js";
import { actorBinding } from "../actor.js";

export const MANAGED_GOOGLE_REVOKE_TIMEOUT_MS = 5_000;

type RemovedGrant = Pick<typeof connectionGrants.$inferSelect,
  "id" | "companyId" | "connectionId" | "status" | "kind" | "subjectUserId" | "subjectAgentId" | "credentialSecretRefs" | "providerTenant">;

type PreparedRevocation =
  | { kind: "call"; subject: string; token: string }
  | { kind: "skip"; outcome: ManagedGoogleRevocationOutcome };

export type PreparedGoogleAccessRemoval = {
  refreshSecretIds: string[];
  send(): Promise<ManagedGoogleAccessRemoval>;
};

function refreshSecretId(grant: RemovedGrant): string | null {
  return (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token")?.secretId ?? null;
}

function outcomeForError(error: unknown): ManagedGoogleRevocationOutcome {
  if (!(error instanceof PaperclipCloudConnectorError)) return "broker_error";
  if (error.code === "CONNECTOR_UNAVAILABLE") return "broker_unavailable";
  if (error.status === 409 && error.brokerReason === "REVOCATION_NOT_AVAILABLE") return "revocation_not_available";
  return "broker_error";
}

export function summarizeManagedGoogleAccess(outcomes: ManagedGoogleRevocationOutcome[]): ManagedGoogleAccessRemoval {
  const revoked = outcomes.filter((outcome) => outcome === "revoked").length;
  const remaining = outcomes.filter((outcome) => outcome === "other_connections_remain").length;
  const result: ManagedGoogleAccessRemoval["result"] = revoked + remaining < outcomes.length
    ? "not_ended"
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
  ): Promise<ManagedGoogleAccessRemoval> {
    const outcomes: ManagedGoogleRevocationOutcome[] = [];
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
      const remaining = deadline - now();
      if (connectorUnavailable || !connector || remaining <= 0) {
        outcomes.push("broker_unavailable");
        continue;
      }
      try {
        const { outcome } = await connector.revoke({
          subject: revocation.subject,
          companyId: connection.companyId,
          profile: profile as Parameters<PaperclipCloudConnector["revoke"]>[0]["profile"],
          token: revocation.token,
          timeoutMs: remaining,
        });
        outcomes.push(outcome ?? "broker_error");
      } catch (error) {
        outcomes.push(outcomeForError(error));
      }
    }
    const summary = summarizeManagedGoogleAccess(outcomes);
    if (summary.result === "not_ended") {
      logger.warn(
        { companyId: connection.companyId, connectionId: connection.id, outcomes: summary.outcomes },
        "Paperclip Cloud did not end Google access for a removed connection",
      );
    }
    return summary;
  }

  function unexpectedFailure(connection: typeof toolConnections.$inferSelect, error: unknown): PreparedGoogleAccessRemoval {
    logger.warn(
      { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
      "Could not prepare ending Google access for a removed connection",
    );
    return { refreshSecretIds: [], send: async () => summarizeManagedGoogleAccess(["unexpected_error"]) };
  }

  async function recordAudit(
    connection: typeof toolConnections.$inferSelect,
    actor: ActorInfo | undefined,
    scope: { grantId?: string },
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
        outcome: providerAccess.result === "not_ended" ? "failure" : "success",
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

  async function prepare(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    actor: ActorInfo | undefined,
    scope: { grantId?: string } = {},
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
      const seen = new Set<string>();
      const revocations: PreparedRevocation[] = [];
      const refreshSecretIds: string[] = [];
      for (const grant of grants) {
        const secretId = refreshSecretId(grant);
        const refreshRef = (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token");
        if (!secretId || !refreshRef || seen.has(secretId)) continue;
        if (grant.status === "revoked" && !stillStored.has(secretId)) continue;
        seen.add(secretId);
        const subject = managedConnectorConsentSubject(grant, oauth);
        if (!subject) {
          revocations.push({ kind: "skip", outcome: "credential_unavailable" });
          continue;
        }
        try {
          const { value } = await resolveConnectionGrantSecret(db, connection, grant, refreshRef, {
            consumerType: "tool_connection",
            consumerId: connection.id,
            actorType: actor?.actorType ?? "system",
            actorId: actor?.actorId ?? null,
          });
          revocations.push({ kind: "call", subject, token: value });
          refreshSecretIds.push(secretId);
        } catch {
          revocations.push({ kind: "skip", outcome: "credential_unavailable" });
        }
      }
      if (revocations.length === 0) return null;
      return {
        refreshSecretIds,
        send: async () => {
          let summary: ManagedGoogleAccessRemoval;
          try {
            summary = await send(connection, profile.id, revocations);
          } catch (error) {
            summary = await unexpectedFailure(connection, error).send();
          }
          await recordAudit(connection, actor, scope, summary);
          return summary;
        },
      };
    } catch (error) {
      const failed = unexpectedFailure(connection, error);
      return {
        refreshSecretIds: [],
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
