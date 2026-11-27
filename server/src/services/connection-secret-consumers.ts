import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  companySecretBindings,
  companySecrets,
  connectionGrants,
  toolConnections,
  userSecretDeclarations,
  type Db,
} from "@paperclipai/db";
import { connectionSecretsUsedByOtherConsumers } from "./connection-credentials.js";

export type SecretConsumerScope = {
  companyId: string;
  connectionId: string;
  secretIds: readonly string[];
  excludeGrantIds?: readonly string[];
  removingConnection: boolean;
  liveOnly: boolean;
};

export async function findSecretConsumers(db: Db, scope: SecretConsumerScope): Promise<Set<string>> {
  const wanted = [...new Set(scope.secretIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (wanted.length === 0) return new Set();
  const wantedSet = new Set(wanted);
  const held = await connectionSecretsUsedByOtherConsumers(db, wanted);
  const excludedGrants = new Set(scope.excludeGrantIds ?? []);

  const grantFilters: SQL[] = [eq(connectionGrants.companyId, scope.companyId)];
  if (scope.liveOnly) grantFilters.push(ne(connectionGrants.status, "revoked"));
  if (scope.removingConnection) grantFilters.push(ne(connectionGrants.connectionId, scope.connectionId));
  const grants = await db.select({ id: connectionGrants.id, refs: connectionGrants.credentialSecretRefs })
    .from(connectionGrants).where(and(...grantFilters));
  for (const row of grants) {
    if (excludedGrants.has(row.id)) continue;
    for (const ref of row.refs ?? []) if (wantedSet.has(ref.secretId)) held.add(ref.secretId);
  }

  const connectionFilters: SQL[] = [eq(toolConnections.companyId, scope.companyId)];
  if (scope.liveOnly) connectionFilters.push(ne(toolConnections.status, "archived"));
  if (scope.removingConnection) connectionFilters.push(ne(toolConnections.id, scope.connectionId));
  const connections = await db.select({ refs: toolConnections.credentialRefs, secretRefs: toolConnections.credentialSecretRefs })
    .from(toolConnections).where(and(...connectionFilters));
  for (const row of connections) {
    for (const ref of [...(row.refs ?? []), ...(row.secretRefs ?? [])]) if (wantedSet.has(ref.secretId)) held.add(ref.secretId);
  }

  const bindings = await db.select({ secretId: companySecretBindings.secretId }).from(companySecretBindings)
    .where(and(
      eq(companySecretBindings.companyId, scope.companyId),
      inArray(companySecretBindings.secretId, wanted),
      sql`not (${companySecretBindings.targetType} = 'tool_connection' and ${companySecretBindings.targetId} = ${scope.connectionId})`,
    ));
  for (const row of bindings) held.add(row.secretId);

  const definitions = await db.select({ id: companySecrets.id, definitionId: companySecrets.userSecretDefinitionId })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, scope.companyId), inArray(companySecrets.id, wanted)));
  const definitionIds = [...new Set(definitions.flatMap((row) => row.definitionId ? [row.definitionId] : []))];
  if (definitionIds.length > 0) {
    const declared = await db.select({ definitionId: userSecretDeclarations.userSecretDefinitionId }).from(userSecretDeclarations)
      .where(and(
        inArray(userSecretDeclarations.userSecretDefinitionId, definitionIds),
        sql`not (${userSecretDeclarations.targetType} = 'tool_connection' and ${userSecretDeclarations.targetId} = ${scope.connectionId})`,
      ));
    const shared = new Set(declared.map((row) => row.definitionId));
    for (const row of definitions) if (row.definitionId && shared.has(row.definitionId)) held.add(row.id);
  }
  return held;
}
