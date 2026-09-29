import { and, eq, inArray } from "drizzle-orm";
import { type Db, toolConnections, companySecretBindings, connectionGrants, companySecrets, userSecretDefinitions } from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { secretService } from "./secrets.js";
function credentialRefConfigPath(ref: { name: string }): string { return ref.name.startsWith("credentials.") ? ref.name : `credentials.${ref.name}`; }
export async function syncConnectionCredentialBindings(
    db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
    connection: typeof toolConnections.$inferSelect,
    grantSecretRefs: ToolCredentialSecretRef[] = [],
    dbClient: Pick<Db, "select" | "insert" | "update" | "delete"> = db,
  ) {
    const secrets = secretService(db);
    await dbClient
      .delete(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, connection.companyId),
          eq(companySecretBindings.targetType, "tool_connection"),
          eq(companySecretBindings.targetId, connection.id),
        ),
      );
    // A metadata edit or pause/resume must retain declarations for every
    // active personal/dedicated grant, not just connection-owned credentials.
    const activeGrants = await dbClient.select({ refs: connectionGrants.credentialSecretRefs })
      .from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.status, "active"),
      ));
    const rawBindings = [
      ...connection.credentialRefs.map((ref) => ({
        secretId: ref.secretId,
        configPath: credentialRefConfigPath(ref),
        projectionClass: "unclassified",
        projectionAllowlistKey: null,
        required: true,
        label: null,
      })),
      ...[...connection.credentialSecretRefs, ...grantSecretRefs, ...activeGrants.flatMap((grant) => grant.refs)].map((ref) => ({
        secretId: ref.secretId,
        configPath: ref.configPath,
        projectionClass: ref.projectionClass ?? "unclassified",
        projectionAllowlistKey: ref.projectionAllowlistKey ?? null,
        required: ref.required ?? true,
        label: ref.label ?? null,
      })),
    ];
    // Organization grants can mirror connection-owned credentials, and more
    // than one personal grant can reference the same client registration.
    // Binding rows are unique per secret/config path, so collapse those mirrors
    // before replacing the durable projection declarations.
    const bindings = [...new Map(rawBindings.map((ref) => [
      `${ref.secretId}:${ref.configPath}`,
      ref,
    ])).values()];
    const secretRows = bindings.length > 0
      ? await dbClient.select({
          id: companySecrets.id,
          scope: companySecrets.scope,
          userSecretDefinitionId: companySecrets.userSecretDefinitionId,
        }).from(companySecrets).where(and(
          eq(companySecrets.companyId, connection.companyId),
          inArray(companySecrets.id, [...new Set(bindings.map((ref) => ref.secretId))]),
        ))
      : [];
    const secretById = new Map(secretRows.map((row) => [row.id, row]));
    const definitionIds = [...new Set(secretRows.flatMap((row) => row.userSecretDefinitionId ? [row.userSecretDefinitionId] : []))];
    const definitions = definitionIds.length > 0
      ? await dbClient.select({ id: userSecretDefinitions.id, key: userSecretDefinitions.key })
          .from(userSecretDefinitions)
          .where(and(
            eq(userSecretDefinitions.companyId, connection.companyId),
            inArray(userSecretDefinitions.id, definitionIds),
          ))
      : [];
    const definitionKeyById = new Map(definitions.map((row) => [row.id, row.key]));
    const userDeclarations = [...new Map(bindings.flatMap((ref) => {
      const secret = secretById.get(ref.secretId);
      const definitionKey = secret?.scope === "user" && secret.userSecretDefinitionId
        ? definitionKeyById.get(secret.userSecretDefinitionId)
        : null;
      return definitionKey
        ? [{
            definitionKey,
            configPath: ref.configPath,
            envKey: ref.configPath,
            versionSelector: "latest" as const,
            required: ref.required,
            label: ref.label,
          }]
        : [];
    }).map((ref) => [`${ref.definitionKey}:${ref.configPath}`, ref])).values()];
    await secrets.syncUserSecretDeclarationsForTarget(
      connection.companyId,
      { targetType: "tool_connection", targetId: connection.id },
      userDeclarations,
      { replaceAll: true, db: dbClient },
    );
    const companyBindings = bindings.filter((ref) => secretById.get(ref.secretId)?.scope !== "user");
    if (companyBindings.length === 0) return;
    await dbClient.insert(companySecretBindings).values(companyBindings.map((ref) => ({
      companyId: connection.companyId,
      secretId: ref.secretId,
      targetType: "tool_connection" as const,
      targetId: connection.id,
      configPath: ref.configPath,
      required: ref.required,
      label: ref.label,
      projectionClass: ref.projectionClass,
      projectionAllowlistKey: ref.projectionAllowlistKey,
    })));
  }

