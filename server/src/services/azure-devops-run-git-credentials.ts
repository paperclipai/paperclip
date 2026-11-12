import { and, eq, or } from "drizzle-orm";
import { companyMemberships, connectionGrantMembers, connectionGrants, issues, projectProviderAuthorizations, projectWorkspaces, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import { allowsGitCredentialExport } from "./git-credential-export-policy.js";
import { resolveConnectionGrantSecret, validateConnectionGrantSecretOwnership } from "./connection-credentials.js";
import { azureDevOpsClient, isAzureDevOpsConnection } from "./connectors/azure-devops/index.js";
import { azureDevOpsGitInvocation } from "./connectors/azure-devops/git-auth.js";
import { toolAccessService } from "./tool-access.js";
import { boundRunIssueId } from "./run-task-binding.js";
import { projectProviderAuthorizationService } from "./project-provider-authorization.js";
import { assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-access.js";
import { canBrowseProjectRepositoryGrant } from "./project-repositories.js";

/** Resolve only the run's own connection and verify the exact remote with Azure. */
export async function resolveAzureDevOpsRunGitCredentials(
  db: Db, input: { companyId: string; runId: string; agentId: string; repoUrl: string; projectId?: string; expectedRepositoryId?: string },
  deps: { request?: (url: string, init: RequestInit) => Promise<Response> } = {},
) {
  const unavailable = () => forbidden("Azure DevOps repository authorization is unavailable. Reconnect an authorized account.");
  let url: URL;
  try { url = new URL(input.repoUrl); } catch { throw unavailable(); }
  const match = /^\/([a-z0-9][a-z0-9-]{0,49})\/[^/]+\/_git\/[^/]+\/?$/i.exec(url.pathname);
  if (!match || url.protocol !== "https:" || url.hostname !== "dev.azure.com" || url.port || url.username || url.password || url.search || url.hash) throw unavailable();
  const org = match[1]!.toLowerCase();
  const { run, context } = await captureRunIdentity(db, input, { readScope: "github_credentials" });
  if (!context || !(await allowsGitCredentialExport(db, run))) throw unavailable();
  const userId = context.cause === "company_default" ? null : context.responsibleUserId;
  if (userId) {
    const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
    if (!member || member.membershipRole === "viewer") throw unavailable();
  }
  const eligibleGrants = async () => {
    const [members, memberships] = await Promise.all([
      db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.companyId, input.companyId)),
      userId ? db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : Promise.resolve([]),
    ]);
    const activeMember = memberships.some((member) => member.membershipRole !== "viewer");
    const candidates = await db.select({ connection: toolConnections, grant: connectionGrants }).from(connectionGrants)
      .innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, input.companyId)))
      .innerJoin(toolConnectionInstalls, and(eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, toolConnections.id),
        or(and(eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, input.companyId)),
          and(eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, input.agentId)))))
      .where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.status, "active"),
        eq(toolConnections.status, "active"), eq(toolConnections.enabled, true)));
    const eligible = candidates.filter(({ connection, grant }) => {
      const config = connection.config.methodConfig as Record<string, unknown> | undefined;
      return connection.credentialSource === "paperclip_vault" && isAzureDevOpsConnection(connection) &&
        typeof config?.organization === "string" && config.organization.toLowerCase() === org &&
        ((grant.kind === "user" && !!userId && grant.subjectUserId === userId) ||
          (grant.kind === "agent" && grant.subjectAgentId === input.agentId) ||
          (grant.kind === "organization" && connection.credentialPolicy === "shared" && Boolean(userId) &&
            canBrowseProjectRepositoryGrant({ grant, userId, activeMember,
              audience: members.filter((member) => member.grantId === grant.id && member.subjectType === "user").map((member) => member.subjectId) })));
    });
    const dedicated = eligible.filter(({ grant }) => grant.kind === "agent");
    const selected = dedicated.length ? dedicated : eligible;
    // Duplicate install rows may refer to the same grant; different grants are ambiguous.
    return [...new Map(selected.map((row) => [row.grant.id, row])).values()];
  };
  const unique = await eligibleGrants();
  let expectedRepositoryId: string | null = input.expectedRepositoryId ?? null;
  if (expectedRepositoryId && !expectedRepositoryId.startsWith(`azure-devops:${org}:`)) throw unavailable();
  const selectGrant = async (available = unique, forceConsent = false) => {
    if (available.length === 1 && !forceConsent && !input.projectId) return available[0]!;
    if (!available.length) throw unavailable();
    let projectId = input.projectId;
    if (!projectId) {
      const issueId = boundRunIssueId(run);
      if (!issueId) throw unavailable();
      const [issue] = await db.select({ projectId: issues.projectId }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)));
      projectId = issue?.projectId ?? undefined;
    }
    if (!projectId) throw unavailable();
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId: input.companyId,
      agentId: input.agentId, runId: input.runId, onBehalfOfUserId: userId };
    await assertTaskWorkspaceSourceProjectAccess(db, actor, input.companyId, projectId);
    const workspaces = await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, input.companyId),
      eq(projectWorkspaces.projectId, projectId)));
    const workspace = workspaces.find(item => item.repoUrl && item.metadata?.repositoryProvider === "azure-devops" &&
      item.repoUrl.replace(/\/$/, "").toLowerCase() === url.href.replace(/\/$/, "").toLowerCase());
    const repositoryId = workspace?.metadata?.repositoryId;
    if (!workspace || typeof repositoryId !== "string" || !repositoryId.startsWith(`azure-devops:${org}:`) ||
        (expectedRepositoryId !== null && expectedRepositoryId !== repositoryId)) throw unavailable();
    expectedRepositoryId = repositoryId;
    if (available.length === 1 && !forceConsent) return available[0]!;
    const [consent] = await db.select().from(projectProviderAuthorizations).where(and(
      eq(projectProviderAuthorizations.companyId, input.companyId), eq(projectProviderAuthorizations.projectId, projectId),
      eq(projectProviderAuthorizations.provider, "azure-devops"), eq(projectProviderAuthorizations.scopeKey, org)));
    if (!consent?.authorizedByUserId) throw unavailable();
    const access = await projectProviderAuthorizationService(db).read(input.companyId, projectId, consent.authorizedByUserId, "azure-devops", org);
    if (access.grantId !== consent.grantId || !access.options.some(option => option.grantId === consent.grantId)) throw unavailable();
    const selected = available.find(item => item.grant.id === consent.grantId);
    if (!selected) throw unavailable();
    return selected;
  };
  const selectedGrant = await selectGrant();
  const { connection } = selectedGrant;
  let { grant } = selectedGrant;
  try {
    if (connection.authKind === "oauth") grant = await toolAccessService(db).refreshOAuthGrantCredentials({
      companyId: input.companyId, connectionId: connection.id, grantId: grant.id,
      actor: { actorType: "agent", actorId: input.agentId }, heartbeatRunId: input.runId,
    });
    const ref = grant.credentialSecretRefs.find((item) => connection.authKind === "oauth"
      ? item.configPath === "oauth.access_token" : /authorization|token|api_key|apiKey/i.test(item.configPath));
    if (!ref || grant.status !== "active") throw unavailable();
    const secret = await validateConnectionGrantSecretOwnership(db, connection, grant, ref);
    if (secret.status !== "active" || secret.deletedAt) throw unavailable();
    const resolved = await resolveConnectionGrantSecret(db, connection, grant, ref, { consumerType: "tool_connection",
      consumerId: connection.id, actorType: "agent", actorId: input.agentId, heartbeatRunId: input.runId });
    const client = azureDevOpsClient(connection, { Authorization: `Bearer ${resolved.value}` },
      (endpoint, init) => (deps.request ?? fetch)(endpoint, init), AbortSignal.timeout(8_000));
    const repos = await client.probe();
    const canonical = url.href.replace(/\/$/, "").toLowerCase();
    if (!repos.some((repo) => repo.url.replace(/\/$/, "").toLowerCase() === canonical &&
        (!expectedRepositoryId || `azure-devops:${repo.id}` === expectedRepositoryId))) throw unavailable();
    const [current] = await db.select({ connection: toolConnections, grant: connectionGrants }).from(connectionGrants)
      .innerJoin(toolConnections, and(eq(toolConnections.id, connectionGrants.connectionId), eq(toolConnections.companyId, input.companyId)))
      .innerJoin(toolConnectionInstalls, and(eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, toolConnections.id),
        or(and(eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, input.companyId)),
          and(eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, input.agentId)))))
      .where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, grant.id), eq(connectionGrants.status, "active"),
        eq(toolConnections.enabled, true), eq(toolConnections.status, "active")));
    const again = await captureRunIdentity(db, input, { readScope: "github_credentials" });
    if (!current || !isAzureDevOpsConnection(current.connection) || current.connection.credentialSource !== "paperclip_vault" ||
        JSON.stringify(current.connection.config) !== JSON.stringify(connection.config) ||
        current.grant.kind !== grant.kind || current.grant.subjectUserId !== grant.subjectUserId ||
        current.grant.subjectAgentId !== grant.subjectAgentId || current.grant.connectionId !== connection.id ||
        JSON.stringify(current.grant.credentialSecretRefs) !== JSON.stringify(grant.credentialSecretRefs) ||
        again.context?.id !== context.id || !(await allowsGitCredentialExport(db, again.run))) throw unavailable();
    const refreshedGrants = await eligibleGrants();
    if ((await selectGrant(refreshedGrants, unique.length > 1)).grant.id !== grant.id) throw unavailable();
    if (expectedRepositoryId && !repos.some(repo => repo.url.replace(/\/$/, "").toLowerCase() === canonical &&
      `azure-devops:${repo.id}` === expectedRepositoryId)) throw unavailable();
    const currentSecret = await validateConnectionGrantSecretOwnership(db, current.connection, current.grant, ref);
    if (currentSecret.status !== "active" || currentSecret.deletedAt || currentSecret.latestVersion !== secret.latestVersion) throw unavailable();
    if (userId) {
      const [member] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
      if (!member || member.membershipRole === "viewer") throw unavailable();
    }
    return azureDevOpsGitInvocation(input.repoUrl, { kind: connection.authKind === "oauth" ? "entra" : "pat", token: resolved.value });
  } catch { throw unavailable(); }
}
