import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  type Db, companySecrets, companySecretBindings, connectionGrants,
  toolConnections, userSecretDefinitions, toolAccessAuditEvents, activityLog,
} from "@paperclipai/db";
import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import { connectionCredentialConfigPath, connectionSecretsUsedByOtherConsumers } from "./connection-credentials.js";

const PAGE_SIZE = 100;
const RECONNECT_MESSAGE = "This personal credential needs its owner to reconnect it.";

/**
 * Bounded keyset pages and one connection per serializable transaction. Never
 * decrypt/copy values or adopt a shared credential. Run before accepting traffic.
 */
export async function backfillPersonalConnectionCredentials(db: Db) {
  const totals = { repairedConnections: 0, repairedSecrets: 0, reconnectRequired: 0 };
  let cursor: string | undefined;
  while (true) {
    const page = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(
      eq(toolConnections.credentialPolicy, "per_user"), eq(toolConnections.status, "active"),
      // Healthy personal connections need no transaction or per-grant scan.
      sql`exists (
        select 1 from ${connectionGrants} as repair_grant
        cross join lateral jsonb_array_elements(repair_grant.credential_secret_refs) as repair_ref
        join ${companySecrets} as repair_secret on repair_secret.id::text = repair_ref->>'secretId'
        where repair_grant.connection_id = ${toolConnections.id}
          and repair_grant.company_id = ${toolConnections.companyId}
          and repair_grant.kind = 'user' and repair_grant.status = 'active'
          and repair_secret.company_id = ${toolConnections.companyId}
          and repair_secret.scope = 'company'
          and repair_ref->>'configPath' <> 'oauth.client_secret'
      )`,
      cursor ? gt(toolConnections.id, cursor) : undefined,
    )).orderBy(asc(toolConnections.id)).limit(PAGE_SIZE);
    if (!page.length) break;
    for (const candidate of page) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await db.transaction(async (tx) => {
            const result = { repairedConnections: 0, repairedSecrets: 0, reconnectRequired: 0 };
            const [connection] = await tx.select().from(toolConnections).where(and(
              eq(toolConnections.id, candidate.id), eq(toolConnections.status, "active"), eq(toolConnections.credentialPolicy, "per_user"),
            )).for("update");
            if (!connection?.createdByUserId) return result;
            const grants = await tx.select().from(connectionGrants).where(and(
              eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.status, "active"),
            )).limit(2);
            const grant = grants.find((row) => row.kind === "user" && row.subjectUserId === connection.createdByUserId);
            if (!grant?.credentialSecretRefs.length) return result;
            const refs = grant.credentialSecretRefs.filter((ref) => ref.configPath !== "oauth.client_secret");
            const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
            if (!secretIds.length) return result;
            // Oversized or ambiguous graphs are reconnect-only, never a large startup mutation.
            const credentialSecrets = await tx.select().from(companySecrets).where(and(
              eq(companySecrets.companyId, connection.companyId),
              inArray(companySecrets.id, secretIds.slice(0, PAGE_SIZE)),
            )).for("update");
            const legacy = credentialSecrets.filter((secret) => secret.scope === "company");
            if (!legacy.length) return result;
            const personalSecrets = credentialSecrets.filter((secret) => secret.scope === "user");
            const definitionIds = personalSecrets.flatMap((secret) => secret.userSecretDefinitionId ? [secret.userSecretDefinitionId] : []);
            const definitions = definitionIds.length ? await tx.select({ id: userSecretDefinitions.id }).from(userSecretDefinitions).where(and(
              eq(userSecretDefinitions.companyId, connection.companyId), inArray(userSecretDefinitions.id, definitionIds),
              eq(userSecretDefinitions.status, "active"), isNull(userSecretDefinitions.deletedAt),
            )) : [];
            const validDefinitionIds = new Set(definitions.map((definition) => definition.id));
            const otherConsumers = await connectionSecretsUsedByOtherConsumers(tx, legacy.map((secret) => secret.id));
            let safe = secretIds.length <= PAGE_SIZE && grants.length === 1
              && credentialSecrets.length === secretIds.length
              && personalSecrets.every((secret) => secret.status === "active" && !secret.deletedAt
                && secret.ownerUserId === grant.subjectUserId && secret.userSecretDefinitionId
                && validDefinitionIds.has(secret.userSecretDefinitionId))
              && otherConsumers.size === 0
              && !connection.createdByAgentId && grant.createdByUserId === grant.subjectUserId
              && connection.credentialSecretRefs.every((ref) => ref.configPath === "oauth.client_secret");
            for (const secret of legacy) {
              safe &&= secret.status === "active" && !secret.deletedAt && secret.provider === "local_encrypted"
                && secret.managedMode === "paperclip_managed" && secret.key.startsWith("tool_app.")
                && secret.createdByUserId === grant.subjectUserId && !secret.createdByAgentId
                && !secret.ownerUserId && !secret.userSecretDefinitionId
                && refs.filter((ref) => ref.secretId === secret.id).every((ref) => connection.credentialRefs.some((shape) =>
                  shape.secretId === secret.id && connectionCredentialConfigPath(shape) === ref.configPath));
              // Include revoked grants, other grants on this connection, and even
              // malformed cross-company JSON refs. Lack of a binding is not proof of exclusivity.
              const reference = JSON.stringify([{ secretId: secret.id }]);
              const [otherConnection] = await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(
                ne(toolConnections.id, connection.id),
                sql`(${toolConnections.credentialRefs} @> ${reference}::jsonb or ${toolConnections.credentialSecretRefs} @> ${reference}::jsonb)`,
              )).limit(1);
              const [otherGrant] = await tx.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
                ne(connectionGrants.id, grant.id), sql`${connectionGrants.credentialSecretRefs} @> ${reference}::jsonb`,
              )).limit(1);
              const [otherBinding] = await tx.select({ id: companySecretBindings.id }).from(companySecretBindings).where(and(
                eq(companySecretBindings.secretId, secret.id),
                sql`not (${companySecretBindings.companyId} = ${connection.companyId} and ${companySecretBindings.targetType} = 'tool_connection' and ${companySecretBindings.targetId} = ${connection.id})`,
              )).limit(1);
              if (otherConnection || otherGrant || otherBinding) safe = false;
            }
            if (!safe) {
              result.reconnectRequired = 1;
              if (connection.lastError !== RECONNECT_MESSAGE) {
                await tx.update(toolConnections).set({ lastError: RECONNECT_MESSAGE, healthMessage: RECONNECT_MESSAGE, healthStatus: "missing_secret", updatedAt: new Date() })
                  .where(eq(toolConnections.id, connection.id));
                await tx.insert(toolAccessAuditEvents).values({ companyId: connection.companyId, connectionId: connection.id,
                  actorType: "system", action: "connection_grant.credential_repair", outcome: "failure",
                  reasonCode: "credential_repair_requires_reconnect", details: { grantId: grant.id } });
              }
              return result;
            }
            for (const secret of legacy) {
              const [definition] = await tx.insert(userSecretDefinitions).values({
                companyId: connection.companyId, key: `tool_app.repaired.${secret.id}`, name: secret.name,
                description: "Personal connection credential repaired from legacy setup.",
                provider: secret.provider, managedMode: secret.managedMode, createdByUserId: grant.subjectUserId,
              }).returning();
              await tx.update(companySecrets).set({ scope: "user", ownerUserId: grant.subjectUserId,
                userSecretDefinitionId: definition!.id, updatedAt: new Date() }).where(and(
                eq(companySecrets.id, secret.id), eq(companySecrets.scope, "company"), isNull(companySecrets.deletedAt),
              ));
              result.repairedSecrets += 1;
            }
            await syncConnectionCredentialBindings(tx, connection);
            // Leave health unchecked until the same resolver verifies the repaired connection.
            await tx.update(toolConnections).set({ healthStatus: "unchecked", healthMessage: null, lastError: null, updatedAt: new Date() })
              .where(eq(toolConnections.id, connection.id));
            await tx.insert(toolAccessAuditEvents).values({ companyId: connection.companyId, connectionId: connection.id,
              actorType: "system", action: "connection_grant.credential_repair", outcome: "success",
              reasonCode: "personal_credential_ownership_repaired", details: { grantId: grant.id, credentialCount: legacy.length } });
            await tx.insert(activityLog).values({ companyId: connection.companyId, actorType: "system", actorId: "credential-backfill",
              action: "connection_grant.credential_repaired", entityType: "tool_connection", entityId: connection.id,
              details: { grantId: grant.id, credentialCount: legacy.length } });
            result.repairedConnections = 1;
            return result;
          }, { isolationLevel: "serializable" });
          totals.repairedConnections += result.repairedConnections;
          totals.repairedSecrets += result.repairedSecrets;
          totals.reconnectRequired += result.reconnectRequired;
          break;
        } catch (error) {
          const code = (error as { code?: string; cause?: { code?: string } }).code
            ?? (error as { cause?: { code?: string } }).cause?.code;
          if (attempt >= 2 || (code !== "40001" && code !== "40P01")) throw error;
        }
      }
    }
    cursor = page.at(-1)!.id;
  }
  return totals;
}
