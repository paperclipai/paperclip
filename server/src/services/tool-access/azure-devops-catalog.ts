import { companyMemberships, connectionGrantMembers, connectionGrants, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import type { ProjectRepository } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { azureDevOpsClient, isAzureDevOpsConnection } from "../connectors/azure-devops/index.js";
import { canBrowseProjectRepositoryGrant, mergeProjectRepository } from "../project-repositories.js";
import type { OAuthCredentialStore } from "./oauth/credential-store.js";
import type { createOAuthGrantRefresh } from "./oauth/grant-refresh.js";
import type { ToolRemoteHttp } from "./remote-http.js";

type Dependencies = {
  resolveOAuthGrantSecret: OAuthCredentialStore["resolveOAuthGrantSecret"];
  refreshOAuthGrantCredentials: ReturnType<typeof createOAuthGrantRefresh>;
  requestRemoteHttpEndpoint: ToolRemoteHttp["requestRemoteHttpEndpoint"];
};

/** Discover only repositories covered by an active, company-installed grant. */
export async function listAzureDevOpsProjectRepositories(db: Db, deps: Dependencies, companyId: string, userId: string | null, localTrusted: boolean) {
  const connections = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.enabled, true), sql`${toolConnections.config}->>'sourceTemplateKey' = 'azure-devops'`));
  if (!connections.length) return { repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 };
  const [grants, members, installs, memberships] = await Promise.all([
    db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
    db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.companyId, companyId)),
    db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, companyId))),
    userId ? db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : Promise.resolve([]),
  ]);
  const usableConnections: Array<{ id: string; name: string }> = [];
  const failedConnections = new Set<string>();
  const observations: Array<{ connection: typeof toolConnections.$inferSelect; grant: typeof connectionGrants.$inferSelect; rows: Awaited<ReturnType<ReturnType<typeof azureDevOpsClient>["probe"]>> }> = [];
  async function inspect(connection: typeof toolConnections.$inferSelect) {
    if (connection.status !== "active" || connection.credentialSource !== "paperclip_vault" || !isAzureDevOpsConnection(connection) ||
        !installs.some((install) => install.connectionId === connection.id)) return;
    const available = grants.filter((grant) => grant.connectionId === connection.id &&
      !(grant.kind === "organization" && ["per_user", "per_agent"].includes(connection.credentialPolicy)) &&
      canBrowseProjectRepositoryGrant({ grant, userId, activeMember: localTrusted || memberships.length > 0,
        audience: members.filter((member) => member.grantId === grant.id).map((member) => member.subjectId) }));
    if (!available.length) return;
    usableConnections.push({ id: connection.id, name: connection.name });
    let failed = false;
    for (const initial of available) {
      try {
        const actor = { actorType: "user" as const, actorId: userId ?? "board" };
        const grant = connection.authKind === "oauth"
          ? await deps.refreshOAuthGrantCredentials({ companyId, connectionId: connection.id, grantId: initial.id, actor })
          : initial;
        if (grant.status !== "active") throw new Error("grant unavailable");
        const ref = grant.credentialSecretRefs.find((item) => connection.authKind === "oauth"
          ? item.configPath === "oauth.access_token" : /authorization|token|api_key|apiKey/i.test(item.configPath));
        if (!ref) throw new Error("credential unavailable");
        const secret = await deps.resolveOAuthGrantSecret(connection, grant, ref, actor, undefined);
        const client = azureDevOpsClient(connection, { Authorization: `Bearer ${secret.value}` },
          (url, init) => deps.requestRemoteHttpEndpoint(new URL(url), init));
        const rows = await client.probe();
        observations.push({ connection, grant, rows });
      } catch { failed = true; }
    }
    if (failed) failedConnections.add(connection.id);
  }
  // Bound parallel provider calls so one slow connection does not serially delay
  // all others, without issuing an unbounded burst for a large company.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, connections.length) }, async () => {
    while (cursor < connections.length) {
      const connection = connections[cursor++]!;
      await inspect(connection);
    }
  }));
  if (!usableConnections.length) return { repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 };

  // Provider calls are asynchronous. Recheck access once after they settle so
  // a revoked grant or removed install cannot publish a late provider result.
  const [currentConnections, currentGrants, currentMembers, currentInstalls, currentMemberships] = await Promise.all([
    db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.enabled, true))),
    db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
    db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.companyId, companyId)),
    db.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, companyId))),
    userId ? db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : Promise.resolve([]),
  ]);
  const allowed = (connectionId: string, grantId?: string) => {
    const connection = currentConnections.find((item) => item.id === connectionId);
    if (!connection || connection.status !== "active" || connection.credentialSource !== "paperclip_vault" || !isAzureDevOpsConnection(connection) ||
        !currentInstalls.some((install) => install.connectionId === connectionId)) return false;
    return currentGrants.some((grant) => grant.connectionId === connectionId && (!grantId || grant.id === grantId) &&
      !(grant.kind === "organization" && ["per_user", "per_agent"].includes(connection.credentialPolicy)) &&
      canBrowseProjectRepositoryGrant({ grant, userId, activeMember: localTrusted || currentMemberships.length > 0,
        audience: currentMembers.filter((member) => member.grantId === grant.id).map((member) => member.subjectId) }));
  };
  const repositories = new Map<string, ProjectRepository>();
  for (const observation of observations) {
    const current = currentConnections.find((connection) => connection.id === observation.connection.id);
    const grant = currentGrants.find((item) => item.id === observation.grant.id);
    if (!allowed(observation.connection.id, observation.grant.id) || !current || !grant ||
        JSON.stringify(current.config) !== JSON.stringify(observation.connection.config) ||
        JSON.stringify(grant.credentialSecretRefs) !== JSON.stringify(observation.grant.credentialSecretRefs)) continue;
    for (const row of observation.rows) mergeProjectRepository(repositories, row, current.name, current.id);
  }
  const stillUsable = usableConnections.filter((connection) => allowed(connection.id)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { repositories: [...repositories.values()], connections: stillUsable, connectionCount: stillUsable.length,
    failedConnectionCount: stillUsable.filter((connection) => failedConnections.has(connection.id)).length };
}
