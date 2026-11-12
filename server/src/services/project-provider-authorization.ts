import { and, eq } from "drizzle-orm";
import { companyMemberships, connectionGrantMembers, connectionGrants, projectProviderAuthorizations, projects, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { isAzureDevOpsConnection } from "./connectors/azure-devops/index.js";
import { validateConnectionGrantSecretOwnership } from "./connection-credentials.js";
import { canBrowseProjectRepositoryGrant } from "./project-repositories.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { recordProjectLifecycleEvent } from "./resource-lifecycle-events.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

function normalizeScope(provider: string, scope: string) {
  if (provider !== "azure-devops") throw unprocessable("Unsupported Git provider");
  const result = scope.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(result)) throw unprocessable("Invalid Azure DevOps organization");
  return result;
}

function organizationOf(connection: typeof toolConnections.$inferSelect) {
  const config = connection.config.methodConfig;
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const organization = (config as Record<string, unknown>).organization;
  return typeof organization === "string" ? organization.toLowerCase() : null;
}

/** Project-scoped consent, independent for each provider and organization. */
export function projectProviderAuthorizationService(db: Db) {
  async function eligible(reader: Db, companyId: string, userId: string, scopeKey: string) {
    const [member] = await reader.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    ));
    if (!member || member.membershipRole === "viewer") return [];
    const [rows, members] = await Promise.all([
      reader.select({ connection: toolConnections, grant: connectionGrants }).from(connectionGrants)
        .innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, companyId)))
        .innerJoin(toolConnectionInstalls, and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.connectionId, toolConnections.id),
          eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, companyId)))
        .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.status, "active"),
          eq(toolConnections.enabled, true), eq(toolConnections.status, "active"))),
      reader.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.companyId, companyId)),
    ]);
    const options: Array<{ grantId: string; connectionName: string; organization: string }> = [];
    for (const { connection, grant } of rows) {
      if (connection.credentialSource !== "paperclip_vault" || !isAzureDevOpsConnection(connection) || organizationOf(connection) !== scopeKey ||
          (grant.kind === "organization" && ["per_user", "per_agent"].includes(connection.credentialPolicy)) ||
          !canBrowseProjectRepositoryGrant({ grant, userId, activeMember: true,
            audience: members.filter((member) => member.grantId === grant.id).map((member) => member.subjectId) })) continue;
      const ref = grant.credentialSecretRefs.find((item) => connection.authKind === "oauth"
        ? item.configPath === "oauth.access_token" : /authorization|token|api_key|apiKey/i.test(item.configPath));
      if (!ref) continue;
      try {
        const secret = await validateConnectionGrantSecretOwnership(reader, connection, grant, ref);
        if (secret.status !== "active" || secret.deletedAt) continue;
      } catch { continue; }
      options.push({ grantId: grant.id, connectionName: connection.name, organization: scopeKey });
    }
    return options.sort((a, b) => a.connectionName.localeCompare(b.connectionName) || a.grantId.localeCompare(b.grantId));
  }

  async function read(companyId: string, projectId: string, userId: string, provider: string, scope: string) {
    const scopeKey = normalizeScope(provider, scope);
    const [project] = await db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
    if (!project) throw notFound("Project not found");
    const [selected] = await db.select().from(projectProviderAuthorizations).where(and(
      eq(projectProviderAuthorizations.companyId, companyId), eq(projectProviderAuthorizations.projectId, projectId),
      eq(projectProviderAuthorizations.provider, provider), eq(projectProviderAuthorizations.scopeKey, scopeKey),
    ));
    return { provider, scopeKey, grantId: selected?.grantId ?? null, authorizedByUserId: selected?.authorizedByUserId ?? null,
      options: await eligible(db, companyId, userId, scopeKey) };
  }

  return {
    read,
    async set(companyId: string, projectId: string, userId: string, provider: string, scope: string, grantId: string | null) {
      const scopeKey = normalizeScope(provider, scope);
      const publication = await db.transaction(async (tx) => {
        const [project] = await tx.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId))).for("update");
        if (!project || (project.archivedAt && grantId)) throw notFound("Active project not found");
        const reader = tx as unknown as Db;
        const [member] = await tx.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
        if (!member || member.membershipRole === "viewer") throw forbidden("Project Git authorization requires an active company member");
        if (grantId && !(await eligible(reader, companyId, userId, scopeKey)).some((option) => option.grantId === grantId))
          throw forbidden("Select an active Azure DevOps authorization for this organization");
        const identity = and(eq(projectProviderAuthorizations.companyId, companyId), eq(projectProviderAuthorizations.projectId, projectId),
          eq(projectProviderAuthorizations.provider, provider), eq(projectProviderAuthorizations.scopeKey, scopeKey));
        if (grantId) await notifyDeliveryWork(tx, DELIVERY_QUEUES.skillSourceSync);
        if (grantId) await tx.insert(projectProviderAuthorizations).values({ companyId, projectId, provider, scopeKey, grantId, authorizedByUserId: userId })
          .onConflictDoUpdate({ target: [projectProviderAuthorizations.projectId, projectProviderAuthorizations.provider, projectProviderAuthorizations.scopeKey],
            set: { grantId, authorizedByUserId: userId, updatedAt: new Date() } });
        else await tx.delete(projectProviderAuthorizations).where(identity);
        await recordProjectLifecycleEvent(reader, companyId, projectId);
        const { publication } = await persistActivity(reader, { companyId, actorType: "user", actorId: userId,
          action: grantId ? "project.git_authorized" : "project.git_authorization_revoked", entityType: "project", entityId: projectId,
          details: { provider, scopeKey, grantId } });
        return publication;
      });
      publishActivity(publication);
      return read(companyId, projectId, userId, provider, scopeKey);
    },
  };
}
