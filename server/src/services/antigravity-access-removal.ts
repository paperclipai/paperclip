import { and, eq, isNull } from "drizzle-orm";
import { companySecrets, connectionGrants, userSecretDefinitions, type Db, type toolConnections } from "@paperclipai/db";
import type { ManagedGoogleRevocationOutcome } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { resolveConnectionGrantSecret } from "./connection-credentials.js";
import { quotaCredentialRecovery } from "./quota-credential-recovery.js";
import type { secretService } from "./secrets.js";
import {
  ANTIGRAVITY_REVOCATION_PROFILE,
  antigravityAccountStillConnected,
  antigravityRefreshToken,
  antigravityRevocationSubject,
  isAntigravitySubscriptionConnection,
  revokeGoogleRefreshToken,
  type GoogleTokenRevoker,
} from "./antigravity-google-revocation.js";
import { summarizeManagedGoogleAccess, type PreparedGoogleAccessRemoval } from "./tool-access/connections/google-access-removal.js";
import {
  isRetryableGoogleRevocationOutcome,
  queueGoogleRevocationFromSecret,
  settleQueuedGoogleRevocation,
} from "./tool-access/connections/google-pending-revocation.js";
import type { ActorInfo } from "./tool-access/types.js";

export const ANTIGRAVITY_REVOKE_TIMEOUT_MS = 5_000;

type RemovedGrant = Pick<typeof connectionGrants.$inferSelect,
  "id" | "companyId" | "connectionId" | "status" | "kind" | "subjectUserId" | "credentialSecretRefs" | "providerTenant">;

type PrivateSlot = { secretId: string; latestVersion: number; definitionId: string | null };

type Target = { grant: RemovedGrant; slot: PrivateSlot; refreshToken: string | null };

export function createAntigravityAccessRemoval(db: Db, deps: {
  secrets: Pick<ReturnType<typeof secretService>, "remove" | "removeUserSecretDefinition">;
  revokeAtGoogle?: GoogleTokenRevoker;
  timeoutMs?: number;
  now?: () => number;
}) {
  const revokeAtGoogle = deps.revokeAtGoogle ?? revokeGoogleRefreshToken;
  const timeoutMs = deps.timeoutMs ?? ANTIGRAVITY_REVOKE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  async function privateSlot(companyId: string, grant: RemovedGrant, secretId: string): Promise<PrivateSlot | null> {
    const [row] = await db
      .select({
        id: companySecrets.id,
        name: companySecrets.name,
        scope: companySecrets.scope,
        latestVersion: companySecrets.latestVersion,
        definitionId: userSecretDefinitions.id,
        definitionKey: userSecretDefinitions.key,
      })
      .from(companySecrets)
      .leftJoin(userSecretDefinitions, eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId))
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId), isNull(companySecrets.deletedAt)));
    if (!row) return null;
    const personal = grant.kind === "user";
    const owned = personal
      ? row.scope === "user" && row.definitionKey === `ai_${grant.id.replaceAll("-", "_")}`
      : row.scope === "company" && row.name === `ai-${grant.id}`;
    if (!owned) return null;
    return { secretId: row.id, latestVersion: row.latestVersion, definitionId: personal ? row.definitionId : null };
  }

  async function retireStoredCredential(connection: typeof toolConnections.$inferSelect, target: Target) {
    try {
      if (target.slot.definitionId) await deps.secrets.removeUserSecretDefinition(connection.companyId, target.slot.definitionId);
      else await deps.secrets.remove(target.slot.secretId);
      await db.update(connectionGrants)
        .set({ credentialSecretRefs: [], updatedAt: new Date() })
        .where(and(eq(connectionGrants.id, target.grant.id), eq(connectionGrants.companyId, connection.companyId)));
    } catch (error) {
      logger.warn(
        { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
        "Could not delete a disconnected Google sign-in",
      );
    }
    await quotaCredentialRecovery(connection.companyId, target.grant.id).clear().catch(() => undefined);
  }

  async function revoke(connection: typeof toolConnections.$inferSelect, target: Target, reason: "connection_removed" | "grant_revoked", deadline: number) {
    if (!target.refreshToken) return { outcome: "credential_unavailable" as const, retrying: false };
    const subject = antigravityRevocationSubject(target.grant.providerTenant?.name);
    if (await antigravityAccountStillConnected(db, connection.companyId, subject, [target.grant.id])) {
      return { outcome: "other_connections_remain" as const, retrying: false };
    }
    let pendingId: string | null = null;
    try {
      pendingId = await queueGoogleRevocationFromSecret(db, {
        companyId: connection.companyId, connectionId: connection.id, grantId: target.grant.id, subject,
        profile: ANTIGRAVITY_REVOCATION_PROFILE, secretId: target.slot.secretId, version: target.slot.latestVersion, reason,
      });
    } catch (error) {
      logger.warn(
        { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
        "Could not keep a disconnected Google sign-in for a retry",
      );
    }
    let outcome: ManagedGoogleRevocationOutcome;
    try {
      outcome = await revokeAtGoogle(target.refreshToken, Math.max(1, deadline - now()));
    } catch {
      outcome = "provider_revocation_failed";
    }
    if (!pendingId) return { outcome, retrying: false };
    try {
      return { outcome, retrying: await settleQueuedGoogleRevocation(db, connection.companyId, pendingId, outcome) };
    } catch (error) {
      logger.warn(
        { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
        "Could not record the first attempt to end Google access",
      );
      return { outcome, retrying: isRetryableGoogleRevocationOutcome(outcome) };
    }
  }

  async function prepare(
    connection: typeof toolConnections.$inferSelect,
    grants: RemovedGrant[],
    actor: ActorInfo | undefined,
    reason: "connection_removed" | "grant_revoked",
  ): Promise<PreparedGoogleAccessRemoval | null> {
    if (!isAntigravitySubscriptionConnection(connection)) return null;
    const targets: Target[] = [];
    for (const grant of grants) {
      const ref = (grant.credentialSecretRefs ?? []).find((entry) => entry.configPath === "ai.credential");
      if (!ref) continue;
      const slot = await privateSlot(connection.companyId, grant, ref.secretId);
      if (!slot) continue;
      let refreshToken: string | null = null;
      try {
        const { value } = await resolveConnectionGrantSecret(db, connection, grant, ref, {
          consumerType: "tool_connection",
          consumerId: connection.id,
          actorType: actor?.actorType ?? "system",
          actorId: actor?.actorId ?? null,
        });
        refreshToken = antigravityRefreshToken(value);
      } catch {
        refreshToken = null;
      }
      targets.push({ grant, slot, refreshToken });
    }
    if (targets.length === 0) return null;
    return {
      send: async () => {
        const deadline = now() + timeoutMs;
        const outcomes: ManagedGoogleRevocationOutcome[] = [];
        let retrying = 0;
        for (const target of targets) {
          let result: { outcome: ManagedGoogleRevocationOutcome; retrying: boolean };
          try {
            result = await revoke(connection, target, reason, deadline);
          } catch (error) {
            logger.warn(
              { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
              "Could not end Google access for a disconnected sign-in",
            );
            result = { outcome: "unexpected_error", retrying: false };
          }
          outcomes.push(result.outcome);
          if (result.retrying) retrying += 1;
          await retireStoredCredential(connection, target);
        }
        const summary = summarizeManagedGoogleAccess(outcomes, retrying);
        if (summary.result === "not_ended" || summary.result === "retrying") {
          logger.warn(
            { companyId: connection.companyId, connectionId: connection.id, result: summary.result, outcomes: summary.outcomes },
            "Google did not confirm that a disconnected sign-in was revoked",
          );
        }
        return summary;
      },
    };
  }

  return { prepare };
}
