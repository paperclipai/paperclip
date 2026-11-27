import { and, eq } from "drizzle-orm";
import {
  companySecrets,
  connectionGrants,
  userSecretDefinitions,
  type Db,
  type toolConnections,
} from "@paperclipai/db";
import { aiConnectionMetadataSchema, type AiSignInRemoval } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { findSecretConsumers } from "./connection-secret-consumers.js";
import { quotaCredentialRecovery } from "./quota-credential-recovery.js";
import type { secretService } from "./secrets.js";

type RemovedGrant = Pick<typeof connectionGrants.$inferSelect, "id" | "kind" | "credentialSecretRefs">;
type Connection = typeof toolConnections.$inferSelect;
type Target = { grantId: string; secretId: string; expectedVersion: number; definitionId: string | null; state: "live" | "claimed" | "gone" };
type CredentialResult = AiSignInRemoval["savedSignIn"] | "reconnected";

export type PreparedAiSignInRemoval = {
  send(): Promise<AiSignInRemoval | null>;
  retainedGrantIds(): string[];
};

export function isAntigravitySubscriptionConnection(connection: Pick<Connection, "connectionPurpose" | "config">): boolean {
  if (connection.connectionPurpose !== "ai") return false;
  const metadata = aiConnectionMetadataSchema.safeParse(connection.config?.ai);
  return metadata.success && metadata.data.provider === "google" && metadata.data.method === "subscription";
}

export function summarizeAiSignInRemoval(results: AiSignInRemoval["savedSignIn"][]): AiSignInRemoval {
  const savedSignIn = results.includes("not_deleted") ? "not_deleted"
    : results.includes("kept_shared") ? "kept_shared"
      : "deleted";
  return { provider: "google", savedSignIn, providerSignIn: "still_valid" };
}

export function createAntigravitySignInRemoval(db: Db, deps: {
  secrets: Pick<ReturnType<typeof secretService>, "remove">;
}) {
  async function privateSlot(connection: Connection, grant: RemovedGrant, secretId: string): Promise<Target | null> {
    const [row] = await db
      .select({
        id: companySecrets.id,
        name: companySecrets.name,
        scope: companySecrets.scope,
        latestVersion: companySecrets.latestVersion,
        deletedAt: companySecrets.deletedAt,
        definitionId: userSecretDefinitions.id,
        definitionKey: userSecretDefinitions.key,
      })
      .from(companySecrets)
      .leftJoin(userSecretDefinitions, eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId))
      .where(and(eq(companySecrets.companyId, connection.companyId), eq(companySecrets.id, secretId)));
    if (!row) return { grantId: grant.id, secretId, expectedVersion: 0, definitionId: null, state: "gone" };
    const personal = grant.kind === "user";
    const claimed = row.deletedAt !== null;
    const name = `ai-${grant.id}`;
    const owned = personal
      ? row.scope === "user" && row.definitionKey === `ai_${grant.id.replaceAll("-", "_")}`
      : row.scope === "company" && (row.name === name || (claimed && row.name === `${name}__deleted__${row.id}`));
    if (!owned) return null;
    return {
      grantId: grant.id, secretId: row.id, expectedVersion: row.latestVersion,
      definitionId: personal ? row.definitionId : null, state: claimed ? "claimed" : "live",
    };
  }

  async function usedElsewhere(connection: Connection, target: Target, removingConnection: boolean): Promise<boolean> {
    const held = await findSecretConsumers(db, {
      companyId: connection.companyId, connectionId: connection.id, secretIds: [target.secretId],
      excludeGrantIds: [target.grantId], removingConnection, liveOnly: true,
    });
    return held.has(target.secretId);
  }

  async function clearRevokedRef(connection: Connection, target: Target) {
    const [grant] = await db.select({ refs: connectionGrants.credentialSecretRefs }).from(connectionGrants)
      .where(and(eq(connectionGrants.id, target.grantId), eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.status, "revoked")));
    if (!grant) return;
    const refs = (grant.refs ?? []).filter((ref) => ref.secretId !== target.secretId);
    await db.update(connectionGrants)
      .set({ credentialSecretRefs: refs, updatedAt: new Date() })
      .where(and(eq(connectionGrants.id, target.grantId), eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.status, "revoked")));
  }

  async function stillRevoked(connection: Connection, target: Target) {
    const [grant] = await db.select({ status: connectionGrants.status }).from(connectionGrants)
      .where(and(eq(connectionGrants.id, target.grantId), eq(connectionGrants.companyId, connection.companyId)));
    return grant?.status === "revoked";
  }

  async function secretStillStored(connection: Connection, target: Target) {
    const rows = await db.select({ id: companySecrets.id }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, connection.companyId), eq(companySecrets.id, target.secretId)));
    return rows.length > 0;
  }

  async function retire(connection: Connection, target: Target, removingConnection: boolean): Promise<CredentialResult> {
    if (!(await stillRevoked(connection, target))) return "reconnected";
    if (await usedElsewhere(connection, target, removingConnection)) {
      await clearRevokedRef(connection, target);
      return "kept_shared";
    }
    if (target.state === "gone") {
      await clearRevokedRef(connection, target);
      return "deleted";
    }
    const removed = target.state === "claimed"
      ? await deps.secrets.remove(target.secretId)
      : await deps.secrets.remove(target.secretId, { expectedVersion: target.expectedVersion });
    if (!removed && await secretStillStored(connection, target)) {
      return (await stillRevoked(connection, target)) ? "not_deleted" : "reconnected";
    }
    await clearRevokedRef(connection, target);
    await quotaCredentialRecovery(connection.companyId, target.grantId).clear().catch(() => undefined);
    return "deleted";
  }

  async function prepare(connection: Connection, grants: RemovedGrant[], scope: { removingConnection: boolean }): Promise<PreparedAiSignInRemoval | null> {
    if (!isAntigravitySubscriptionConnection(connection)) return null;
    const targets: Target[] = [];
    for (const grant of grants) {
      const ref = (grant.credentialSecretRefs ?? []).find((entry) => entry.configPath === "ai.credential");
      if (!ref) continue;
      const target = await privateSlot(connection, grant, ref.secretId);
      if (target) targets.push(target);
    }
    if (targets.length === 0) return null;
    const retained: string[] = [];
    return {
      retainedGrantIds: () => [...retained],
      send: async () => {
        const results: AiSignInRemoval["savedSignIn"][] = [];
        for (const target of targets) {
          let result: CredentialResult;
          try {
            result = await retire(connection, target, scope.removingConnection);
          } catch (error) {
            logger.warn(
              { companyId: connection.companyId, connectionId: connection.id, errorName: error instanceof Error ? error.name : typeof error },
              "Could not delete a disconnected Google sign-in",
            );
            result = "not_deleted";
          }
          if (result === "reconnected") continue;
          if (result === "not_deleted") retained.push(target.grantId);
          results.push(result);
        }
        return results.length > 0 ? summarizeAiSignInRemoval(results) : null;
      },
    };
  }

  return { prepare };
}
