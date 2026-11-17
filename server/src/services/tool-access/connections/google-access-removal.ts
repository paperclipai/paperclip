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
  "id" | "companyId" | "connectionId" | "kind" | "subjectUserId" | "subjectAgentId" | "credentialSecretRefs" | "providerTenant">;

type PreparedRevocation = { subject: string | null; token?: string; outcome?: ManagedGoogleRevocationOutcome };

export type PreparedGoogleAccessRemoval = { send(): Promise<ManagedGoogleAccessRemoval> };

function outcomeForError(error: unknown): ManagedGoogleRevocationOutcome {
  if (!(error instanceof PaperclipCloudConnectorError)) return "broker_error";
  if (error.code === "CONNECTOR_UNAVAILABLE") return "broker_unavailable";
  if (error.status === 409 && error.brokerReason === "REVOCATION_NOT_AVAILABLE") return "revocation_not_available";
  return "broker_error";
}

function resultOf(outcomes: ManagedGoogleRevocationOutcome[]): ManagedGoogleAccessRemoval["result"] {
  if (outcomes.every((outcome) => outcome === "revoked")) return "ended";
  if (outcomes.every((outcome) => outcome === "revoked" || outcome === "other_connections_remain")) return "other_connections_remain";
  return "not_ended";
}

export function summarizeManagedGoogleAccess(
  calls: Array<{ subject: string | null; outcome: ManagedGoogleRevocationOutcome }>,
): ManagedGoogleAccessRemoval {
  const bySubject = new Map<string, ManagedGoogleRevocationOutcome>();
  const unattributed: ManagedGoogleRevocationOutcome[] = [];
  for (const call of calls) {
    if (call.subject === null) {
      unattributed.push(call.outcome);
      continue;
    }
    if (bySubject.get(call.subject) !== "revoked") bySubject.set(call.subject, call.outcome);
  }
  return {
    provider: "google",
    result: resultOf([...bySubject.values(), ...unattributed]),
    outcomes: calls.map((call) => call.outcome),
  };
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
    const calls: Array<{ subject: string | null; outcome: ManagedGoogleRevocationOutcome }> = [];
    let connector: PaperclipCloudConnector | null = null;
    let connectorUnavailable = false;
    try {
      connector = deps.currentCloudConnector();
    } catch {
      connectorUnavailable = true;
    }
    const deadline = now() + timeoutMs;
    for (const revocation of revocations) {
      if (revocation.outcome || !revocation.token || !revocation.subject) {
        calls.push({ subject: revocation.subject, outcome: revocation.outcome ?? "credential_unavailable" });
        continue;
      }
      const remaining = deadline - now();
      if (connectorUnavailable || !connector || remaining <= 0) {
        calls.push({ subject: revocation.subject, outcome: "broker_unavailable" });
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
        calls.push({ subject: revocation.subject, outcome: outcome ?? "broker_error" });
      } catch (error) {
        calls.push({ subject: revocation.subject, outcome: outcomeForError(error) });
      }
    }
    const summary = summarizeManagedGoogleAccess(calls);
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
    return { send: async () => summarizeManagedGoogleAccess([{ subject: null, outcome: "unexpected_error" }]) };
  }

  async function prepare(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    actor: ActorInfo | undefined,
  ): Promise<PreparedGoogleAccessRemoval | null> {
    const oauth = oauthConfig(connection);
    if (connection.authKind !== "oauth" || !isPaperclipCloudConnectorStrategy(oauth.strategy)) return null;
    const profile = managedConnectorProfile(typeof oauth.connectorProfile === "string" ? oauth.connectorProfile : undefined);
    if (profile?.provider !== "google") return null;
    try {
      const seen = new Set<string>();
      const revocations: PreparedRevocation[] = [];
      for (const grant of grants) {
        const refreshRef = (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token");
        if (!refreshRef || seen.has(refreshRef.secretId)) continue;
        seen.add(refreshRef.secretId);
        const subject = managedConnectorSubject(grant, oauth);
        if (!subject) {
          revocations.push({ subject: null, outcome: "credential_unavailable" });
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
          revocations.push({ subject, outcome: "credential_unavailable" });
        }
      }
      if (revocations.length === 0) return null;
      return {
        send: async () => {
          try {
            return await send(connection, profile.id, revocations);
          } catch (error) {
            return unexpectedFailure(connection, error).send();
          }
        },
      };
    } catch (error) {
      return unexpectedFailure(connection, error);
    }
  }

  return { prepare };
}
