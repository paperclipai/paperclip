import { and, eq } from "drizzle-orm";
import { connectionGrants, projectProviderAuthorizations, projects, projectWorkspaces, toolConnections, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { projectProviderAuthorizationService } from "./project-provider-authorization.js";
import { assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-access.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isCloudManagedInstance } from "./cloud-instance.js";
import { isCurrentCloudOwnerInstanceAdmin, loadCurrentCloudOwnerAuthority } from "./cloud-tenant-authority.js";
import { isAzureDevOpsConnection, azureDevOpsClient } from "./connectors/azure-devops/index.js";
import { azureDevOpsGitInvocation } from "./connectors/azure-devops/git-auth.js";
import { resolveConnectionGrantSecret, validateConnectionGrantSecretOwnership } from "./connection-credentials.js";
import { toolAccessService } from "./tool-access.js";

/** Revalidate the recorded project consent and provider access for one Git operation. */
export async function resolveAzureDevOpsProjectGitCredentials(
  db: Db, input: { companyId: string; projectId: string; repoUrl: string }, deps: { request?: (url: string, init: RequestInit) => Promise<Response> } = {},
) {
  const unavailable = () => forbidden("Project Azure DevOps authorization is unavailable. Reconnect or select a connection.");
  let url: URL;
  try {
    azureDevOpsGitInvocation(input.repoUrl, { kind: "pat", token: "validation" });
    url = new URL(input.repoUrl);
  } catch { throw unavailable(); }
  const scope = url.pathname.split("/")[1]!.toLowerCase();
  const canonical = url.href.replace(/\/$/, "").toLowerCase();
  async function authority() {
    const [project] = await db.select().from(projects).where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)));
    const [authorization] = await db.select().from(projectProviderAuthorizations).where(and(
      eq(projectProviderAuthorizations.companyId, input.companyId), eq(projectProviderAuthorizations.projectId, input.projectId),
      eq(projectProviderAuthorizations.provider, "azure-devops"), eq(projectProviderAuthorizations.scopeKey, scope)));
    if (!project || project.archivedAt || !authorization?.authorizedByUserId) throw unavailable();
    const workspaces = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)));
    const workspace = workspaces.find((workspace) => {
      if (!workspace.repoUrl || workspace.metadata?.repositoryProvider !== "azure-devops") return false;
      try { return new URL(workspace.repoUrl).href.replace(/\/$/, "").toLowerCase() === canonical; } catch { return false; }
    });
    if (!workspace || typeof workspace.metadata?.repositoryId !== "string") throw unavailable();
    const access = await projectProviderAuthorizationService(db).read(input.companyId, input.projectId, authorization.authorizedByUserId, "azure-devops", scope);
    if (access.grantId !== authorization.grantId || !access.options.some((option) => option.grantId === authorization.grantId)) throw unavailable();
    const cloud = isCloudManagedInstance();
    const admin = cloud && await isCurrentCloudOwnerInstanceAdmin(db, authorization.authorizedByUserId,
      await loadCurrentCloudOwnerAuthority(authorization.authorizedByUserId));
    await assertTaskWorkspaceSourceProjectAccess(db, { type: "board", source: cloud ? "cloud_tenant" : "session",
      userId: authorization.authorizedByUserId, isInstanceAdmin: admin }, input.companyId, project.id);
    if (resolveCoreTrustPreset({ companyId: input.companyId, workspaceSourceProject: project }).kind !== "standard") throw unavailable();
    const [row] = await db.select({ connection: toolConnections, grant: connectionGrants }).from(connectionGrants)
      .innerJoin(toolConnections, and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, connectionGrants.connectionId)))
      .where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, authorization.grantId)));
    if (!row || !isAzureDevOpsConnection(row.connection)) throw unavailable();
    return { project, authorization, workspace, ...row };
  }
  try {
    const first = await authority();
    let grant = first.grant;
    const { connection } = first;
    if (connection.authKind === "oauth") grant = await toolAccessService(db).refreshOAuthGrantCredentials({
      companyId: input.companyId, connectionId: connection.id, grantId: grant.id,
      actor: { actorType: "user", actorId: first.authorization.authorizedByUserId },
    });
    const ref = grant.credentialSecretRefs.find((item) => connection.authKind === "oauth"
      ? item.configPath === "oauth.access_token" : /authorization|token|api_key|apiKey/i.test(item.configPath));
    if (!ref || grant.status !== "active") throw unavailable();
    const secret = await validateConnectionGrantSecretOwnership(db, connection, grant, ref);
    if (secret.status !== "active" || secret.deletedAt) throw unavailable();
    const resolved = await resolveConnectionGrantSecret(db, connection, grant, ref, { consumerType: "tool_connection",
      consumerId: connection.id, actorType: "system", actorId: "project-git-credential" });
    const client = azureDevOpsClient(connection, { Authorization: `Bearer ${resolved.value}` },
      (endpoint, init) => (deps.request ?? fetch)(endpoint, init));
    if (!(await client.probe()).some(repo => repo.url.replace(/\/$/, "").toLowerCase() === canonical &&
        `azure-devops:${repo.id}` === first.workspace.metadata?.repositoryId)) throw unavailable();
    const current = await authority();
    if (current.authorization.grantId !== grant.id || current.authorization.authorizedByUserId !== first.authorization.authorizedByUserId ||
        current.workspace.id !== first.workspace.id || current.workspace.metadata?.repositoryId !== first.workspace.metadata?.repositoryId ||
        current.grant.kind !== grant.kind || current.grant.subjectUserId !== grant.subjectUserId ||
        current.grant.subjectAgentId !== grant.subjectAgentId || current.grant.connectionId !== connection.id ||
        JSON.stringify(current.connection.config) !== JSON.stringify(connection.config) ||
        JSON.stringify(current.grant.credentialSecretRefs) !== JSON.stringify(grant.credentialSecretRefs)) throw unavailable();
    const currentSecret = await validateConnectionGrantSecretOwnership(db, current.connection, current.grant, ref);
    if (currentSecret.status !== "active" || currentSecret.deletedAt || currentSecret.latestVersion !== secret.latestVersion) throw unavailable();
    return { ...azureDevOpsGitInvocation(input.repoUrl, { kind: connection.authKind === "oauth" ? "entra" : "pat", token: resolved.value }),
      grantId: grant.id, connectionId: connection.id, credentialSecretId: ref.secretId, credentialSecretVersion: currentSecret.latestVersion,
      repositoryId: first.workspace.metadata!.repositoryId as string };
  } catch { throw unavailable(); }
}
