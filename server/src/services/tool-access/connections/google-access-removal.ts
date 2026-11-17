import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import type { ManagedGoogleAccessRemoval, ManagedGoogleRevocationOutcome } from "@paperclipai/shared";
import { logger } from "../../../middleware/logger.js";
import { resolveConnectionGrantSecret } from "../../connection-credentials.js";
import { isPaperclipCloudConnectorStrategy, PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { managedConnectorProfile, managedConnectorSubject } from "../oauth/client-settings.js";
import { oauthConfig } from "../oauth/metadata.js";
import type { ActorInfo } from "../types.js";

export const MANAGED_GOOGLE_REVOKE_TIMEOUT_MS = 5_000;

type RemovedGrant = Pick<typeof connectionGrants.$inferSelect,
  "id" | "companyId" | "connectionId" | "kind" | "subjectUserId" | "subjectAgentId" | "credentialSecretRefs">;

type PreparedRevocation = { subject: string; token: string } | { outcome: ManagedGoogleRevocationOutcome };

function outcomeForError(error: unknown): ManagedGoogleRevocationOutcome {
  if (!(error instanceof PaperclipCloudConnectorError)) return "broker_error";
  if (error.code === "CONNECTOR_UNAVAILABLE") return "broker_unavailable";
  if (error.status === 409 && error.brokerReason === "REVOCATION_NOT_AVAILABLE") return "revocation_not_available";
  return "broker_error";
}

export function summarizeManagedGoogleAccess(outcomes: ManagedGoogleRevocationOutcome[]): ManagedGoogleAccessRemoval {
  const result = outcomes.every((outcome) => outcome === "revoked")
    ? "ended"
    : outcomes.every((outcome) => outcome === "revoked" || outcome === "other_connections_remain")
      ? "other_connections_remain"
      : "not_ended";
  return { provider: "google", result, outcomes };
}

export function createManagedGoogleAccessRemoval(db: Db, deps: {
  currentCloudConnector: () => PaperclipCloudConnector | null;
  timeoutMs?: number;
}) {
  const timeoutMs = deps.timeoutMs ?? MANAGED_GOOGLE_REVOKE_TIMEOUT_MS;

  async function prepare(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    actor: ActorInfo | undefined,
  ): Promise<{ profile: string; revocations: PreparedRevocation[] } | null> {
    const oauth = oauthConfig(connection);
    if (connection.authKind !== "oauth" || !isPaperclipCloudConnectorStrategy(oauth.strategy)) return null;
    const profile = managedConnectorProfile(typeof oauth.connectorProfile === "string" ? oauth.connectorProfile : undefined);
    if (profile?.provider !== "google") return null;
    const seen = new Set<string>();
    const revocations: PreparedRevocation[] = [];
    for (const grant of grants) {
      const refreshRef = (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token");
      if (!refreshRef || seen.has(refreshRef.secretId)) continue;
      seen.add(refreshRef.secretId);
      const subject = managedConnectorSubject(grant, oauth);
      if (!subject) {
        revocations.push({ outcome: "credential_unavailable" });
        continue;
      }
      try {
        const { value } = await resolveConnectionGrantSecret(db, connection, grant, refreshRef, {
          consumerType: "tool_connection",
          consumerId: connection.id,
          actorType: actor?.actorType ?? "system",
          actorId: actor?.actorId ?? null,
        });
        revocations.push({ subject, token: value });
      } catch {
        revocations.push({ outcome: "credential_unavailable" });
      }
    }
    return revocations.length > 0 ? { profile: profile.id, revocations } : null;
  }

  async function send(
    connection: typeof toolConnections.$inferSelect,
    prepared: { profile: string; revocations: PreparedRevocation[] },
  ): Promise<ManagedGoogleAccessRemoval> {
    const connector = deps.currentCloudConnector();
    const outcomes = await Promise.all(prepared.revocations.map(async (revocation): Promise<ManagedGoogleRevocationOutcome> => {
      if ("outcome" in revocation) return revocation.outcome;
      if (!connector) return "broker_unavailable";
      try {
        const { outcome } = await connector.revoke({
          subject: revocation.subject,
          companyId: connection.companyId,
          profile: prepared.profile as Parameters<PaperclipCloudConnector["revoke"]>[0]["profile"],
          token: revocation.token,
          timeoutMs,
        });
        return outcome ?? "broker_error";
      } catch (error) {
        return outcomeForError(error);
      }
    }));
    const summary = summarizeManagedGoogleAccess(outcomes);
    if (summary.result === "not_ended") {
      logger.warn(
        { companyId: connection.companyId, connectionId: connection.id, outcomes },
        "Paperclip Cloud did not end Google access for a removed connection",
      );
    }
    return summary;
  }

  async function begin(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    actor: ActorInfo | undefined,
  ): Promise<{ settled: Promise<ManagedGoogleAccessRemoval> } | null> {
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(connection, grants, actor);
    } catch {
      prepared = null;
    }
    return prepared ? { settled: send(connection, prepared) } : null;
  }

  return { begin };
}
