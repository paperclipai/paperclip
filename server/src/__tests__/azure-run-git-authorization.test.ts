import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  authUsers,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrantMembers,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  projectProviderAuthorizations,
  projectWorkspaces,
  projects,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveAzureDevOpsRunGitCredentials } from "../services/azure-devops-run-git-credentials.js";
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_PAT_METHOD } from "../services/connectors/azure-devops/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const tokenValues = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => tokenValues.get(secretId) ?? "",
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: tokenValues.get(input.definitionId) ?? "" }),
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Azure DevOps run Git authorization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-azure-run-git-auth-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    tokenValues.clear();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const responsibleUserId = randomUUID(), otherUserId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Azure runner", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Clone Azure repository" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: responsibleUserId, status: "active", membershipRole: "admin" },
      { companyId, principalType: "user", principalId: otherUserId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(authUsers).values([
      { id: responsibleUserId, name: "Alice", email: `${responsibleUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() },
      { id: otherUserId, name: "Bob", email: `${otherUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() },
    ]);
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId, cause: "instruction" });
    return { companyId, agentId, runId, issueId, responsibleUserId, otherUserId, repoUrl: "https://dev.azure.com/contoso/Project/_git/repo" };
  }

  async function grant(input: Awaited<ReturnType<typeof seed>>, options: {
    kind?: "user" | "organization" | "agent"; owner?: string; organization?: string; companyId?: string;
    installed?: boolean; targetType?: "company" | "agent"; status?: "active" | "revoked"; enabled?: boolean;
  } = {}) {
    const companyId = options.companyId ?? input.companyId;
    const kind = options.kind ?? "user";
    const userOwned = kind === "user";
    const appId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID(), secretId = randomUUID();
    const definitionId = userOwned ? randomUUID() : undefined;
    await db.insert(toolApplications).values({ id: appId, companyId, applicationKey: `azure-run-${appId}`, name: appId, type: "rest_api", status: "active" });
    if (definitionId) await db.insert(userSecretDefinitions).values({ id: definitionId, companyId, key: `pat-${definitionId}`, name: "Azure DevOps PAT" });
    await db.insert(companySecrets).values({ id: secretId, companyId, key: `pat-${secretId}`, name: "Azure DevOps PAT",
      scope: userOwned ? "user" : "company", ownerUserId: userOwned ? (options.owner ?? input.responsibleUserId) : null,
      userSecretDefinitionId: definitionId ?? null });
    tokenValues.set(secretId, `pat-${secretId}`);
    if (definitionId) tokenValues.set(definitionId, `pat-${secretId}`);
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId: appId, name: connectionId, uid: connectionId,
      transport: "rest_api", authKind: "api_key", credentialSource: "paperclip_vault", status: "active", enabled: options.enabled ?? true,
      credentialPolicy: userOwned ? "per_user" : kind === "agent" ? "per_agent" : "shared",
      config: { sourceTemplateKey: "azure-devops", connectionMethodKey: AZURE_DEVOPS_PAT_METHOD, url: AZURE_DEVOPS_API_URL,
        methodConfig: { organization: options.organization ?? "contoso" } } });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind,
      subjectUserId: userOwned ? (options.owner ?? input.responsibleUserId) : null,
      subjectAgentId: kind === "agent" ? input.agentId : null,
      status: options.status ?? "active",
      credentialSecretRefs: [{ secretId, configPath: "credentials.authorization", versionSelector: "latest" }] });
    if (kind === "organization") await db.insert(connectionGrantMembers).values({ companyId, grantId, subjectType: "user", subjectId: options.owner ?? input.responsibleUserId });
    if (options.installed ?? true) await db.insert(toolConnectionInstalls).values({ companyId, connectionId,
      targetType: options.targetType ?? "agent", targetId: options.targetType === "company" ? companyId : input.agentId });
    return { grantId, connectionId, secretId };
  }

  async function linkProjectAuthorization(input: Awaited<ReturnType<typeof seed>>, grantId: string | null, options: {
    userId?: string; attachToTask?: boolean; repoUrl?: string; repositoryId?: string;
  } = {}) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: input.companyId, name: `Project ${projectId}` });
    await db.insert(projectWorkspaces).values({ companyId: input.companyId, projectId, name: "Azure repository", sourceType: "git",
      repoUrl: options.repoUrl ?? input.repoUrl, metadata: { repositoryProvider: "azure-devops",
        repositoryId: `azure-devops:contoso:${options.repositoryId ?? "12345678-1234-1234-1234-1234567890ab"}` }, isPrimary: true });
    if (grantId) await db.insert(projectProviderAuthorizations).values({ companyId: input.companyId, projectId,
      provider: "azure-devops", scopeKey: "contoso", grantId, authorizedByUserId: options.userId ?? input.responsibleUserId });
    if (options.attachToTask !== false) await db.update(issues).set({ projectId }).where(eq(issues.id, input.issueId));
    return projectId;
  }

  const provider = (repoName = "repo", onRequest?: () => Promise<void>, repositoryId = "12345678-1234-1234-1234-1234567890ab") => async (url: string, init: RequestInit) => {
    expect(url).toContain("https://dev.azure.com/contoso/");
    expect(new Headers(init.headers).get("authorization")).toMatch(/^Basic /);
    expect(init.redirect).toBe("error");
    await onRequest?.();
    return Response.json({ value: [{ id: repositoryId, name: repoName, project: { name: "Project" } }] });
  };

  const resolve = (input: Awaited<ReturnType<typeof seed>>, request = provider(), options: { projectId?: string; repoUrl?: string; expectedRepositoryId?: string } = {}) =>
    resolveAzureDevOpsRunGitCredentials(db, { companyId: input.companyId, runId: input.runId,
      agentId: input.agentId, repoUrl: options.repoUrl ?? input.repoUrl, ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.expectedRepositoryId ? { expectedRepositoryId: options.expectedRepositoryId } : {}) }, { request });
  async function rejectsWithoutPat(promise: Promise<unknown>, secretId: string) {
    let error: unknown;
    try { await promise; } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(`pat-${secretId}`);
  }

  it("authorizes the responsible user's own active PAT grant for the exact organization and repository", async () => {
    const input = await seed();
    const selected = await grant(input);
    const result = await resolve(input);
    expect(result.repositoryAuthority).toEqual({ provider: "azure-devops", url: input.repoUrl });
    expect(result.source).toBe("managed_connection");
    expect(result.env.PAPERCLIP_AZURE_GIT_TOKEN).toBe(`pat-${selected.secretId}`);
    expect(JSON.stringify(result.configArgs)).not.toContain(`pat-${selected.secretId}`);
    expect(Object.values(result.env).join("\n")).toContain(`pat-${selected.secretId}`);
    expect(JSON.stringify({ ...result, env: {} })).not.toContain(`pat-${selected.secretId}`);
  });

  it("rejects a replacement repository at an admitted task URL", async () => {
    const input = await seed();
    const selected = await grant(input);
    const expectedRepositoryId = "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab";
    await expect(resolve(input, provider(), { expectedRepositoryId })).resolves.toMatchObject({ source: "managed_connection" });
    await rejectsWithoutPat(resolve(input, provider("repo", undefined, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), { expectedRepositoryId }), selected.secretId);
  });

  it("allows a dedicated agent grant and a company install when the run's responsible user has no personal grant", async () => {
    const input = await seed();
    await grant(input, { kind: "agent", targetType: "company" });
    await expect(resolve(input)).resolves.toMatchObject({ repositoryAuthority: { provider: "azure-devops", url: input.repoUrl } });
  });

  it("uses a shared grant only for an included active responsible user, and rechecks the audience", async () => {
    const input = await seed();
    const selected = await grant(input, { kind: "organization", targetType: "company" });
    await expect(resolve(input)).resolves.toMatchObject({ repositoryAuthority: { provider: "azure-devops", url: input.repoUrl } });
    await db.delete(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, selected.grantId));
    await db.insert(connectionGrantMembers).values({ companyId: input.companyId, grantId: selected.grantId, subjectType: "user", subjectId: input.otherUserId });
    await rejectsWithoutPat(resolve(input), selected.secretId);
    await db.delete(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, selected.grantId));
    await expect(resolve(input)).resolves.toMatchObject({ repositoryAuthority: { provider: "azure-devops", url: input.repoUrl } });
    await rejectsWithoutPat(resolve(input, provider("repo", async () => {
      await db.insert(connectionGrantMembers).values({ companyId: input.companyId, grantId: selected.grantId, subjectType: "user", subjectId: input.otherUserId });
    })), selected.secretId);
  });

  it("denies a shared grant when the responsible member is suspended while the provider responds", async () => {
    const input = await seed();
    const selected = await grant(input, { kind: "organization", targetType: "company" });
    await rejectsWithoutPat(resolve(input, provider("repo", async () => {
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, input.responsibleUserId));
    })), selected.secretId);
  });

  it("selects the task project's saved eligible grant when multiple same-organization grants exist", async () => {
    const input = await seed();
    await grant(input, { targetType: "company" });
    const selected = await grant(input, { targetType: "company" });
    await linkProjectAuthorization(input, selected.grantId);

    const result = await resolve(input);
    expect(result.repositoryAuthority).toEqual({ provider: "azure-devops", url: input.repoUrl });
    expect(result.env.PAPERCLIP_AZURE_GIT_TOKEN).toBe(`pat-${selected.secretId}`);
  });

  it("uses explicit project B consent for a task anchored to project A", async () => {
    const input = await seed();
    const anchorGrant = await grant(input, { targetType: "company" });
    const projectA = await linkProjectAuthorization(input, anchorGrant.grantId);
    const alternateGrant = await grant(input, { targetType: "company" });
    const selectedB = await grant(input, { targetType: "company" });
    const repositoryIdB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const repoUrlB = "https://dev.azure.com/contoso/Project/_git/repo-b";
    const projectB = await linkProjectAuthorization(input, selectedB.grantId, {
      attachToTask: false, repoUrl: repoUrlB, repositoryId: repositoryIdB,
    });

    const result = await resolve(input, provider("repo-b", undefined, repositoryIdB), { projectId: projectB, repoUrl: repoUrlB });
    expect(result.env.PAPERCLIP_AZURE_GIT_TOKEN).toBe(`pat-${selectedB.secretId}`);
    expect(result.env.PAPERCLIP_AZURE_GIT_TOKEN).not.toBe(`pat-${anchorGrant.secretId}`);
    expect(result.env.PAPERCLIP_AZURE_GIT_TOKEN).not.toBe(`pat-${alternateGrant.secretId}`);
    expect(projectA).not.toBe(projectB);
  });

  it("denies explicit project B when it has no authorization for its repository", async () => {
    const input = await seed();
    const anchorGrant = await grant(input, { targetType: "company" });
    await linkProjectAuthorization(input, anchorGrant.grantId);
    const secondGrant = await grant(input, { targetType: "company" });
    const repoUrlB = "https://dev.azure.com/contoso/Project/_git/repo-b";
    const projectB = await linkProjectAuthorization(input, null, { attachToTask: false, repoUrl: repoUrlB,
      repositoryId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });

    await rejectsWithoutPat(resolve(input, provider("repo-b"), { projectId: projectB, repoUrl: repoUrlB }), secondGrant.secretId);
  });

  it("denies a repository URL that does not match explicit project B's workspace", async () => {
    const input = await seed();
    const first = await grant(input, { targetType: "company" });
    await linkProjectAuthorization(input, first.grantId);
    const selectedB = await grant(input, { targetType: "company" });
    const repoUrlB = "https://dev.azure.com/contoso/Project/_git/repo-b";
    const projectB = await linkProjectAuthorization(input, selectedB.grantId, { attachToTask: false, repoUrl: repoUrlB,
      repositoryId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });

    await rejectsWithoutPat(resolve(input, provider("repo"), { projectId: projectB }), selectedB.secretId);
  });

  it("does not use a saved grant attached to another project", async () => {
    const input = await seed();
    const first = await grant(input, { targetType: "company" });
    await grant(input, { targetType: "company" });
    await linkProjectAuthorization(input, first.grantId, { attachToTask: false });

    await rejectsWithoutPat(resolve(input), first.secretId);
  });

  it("denies an explicit project grant that is ineligible for the run's responsible user", async () => {
    const input = await seed();
    const bobGrant = await grant(input, { owner: input.otherUserId, targetType: "company" });
    await linkProjectAuthorization(input, bobGrant.grantId);

    await rejectsWithoutPat(resolve(input), bobGrant.secretId);
  });

  it("keeps same-organization ambiguity denied when the task project has no saved grant", async () => {
    const input = await seed();
    const first = await grant(input, { targetType: "company" });
    await grant(input, { targetType: "company" });
    await linkProjectAuthorization(input, null);

    await rejectsWithoutPat(resolve(input), first.secretId);
  });

  it.each([
    "revoked-grant", "revoked-connection", "disabled-connection", "missing-install", "other-user", "other-company",
    "wrong-organization", "other-repository", "non-running", "low-trust", "ambiguous-grants",
  ])("fails closed for %s without exposing the PAT", async (failure) => {
    const input = await seed();
    let foreignCompanyId: string | undefined;
    if (failure === "other-company") {
      [foreignCompanyId] = (await db.insert(companies).values({ name: "Foreign Azure company", issuePrefix: randomUUID().slice(0, 8) }).returning({ id: companies.id })).map(row => row.id);
    }
    const selected = await grant(input, { ...(failure === "other-user" ? { owner: input.otherUserId } : {}),
      ...(failure === "revoked-grant" ? { status: "revoked" as const } : {}),
      ...(failure === "revoked-connection" ? { status: "revoked" as const } : {}),
      ...(failure === "disabled-connection" ? { enabled: false } : {}),
      ...(failure === "missing-install" ? { installed: false } : {}),
      ...(failure === "other-company" ? { companyId: foreignCompanyId } : {}),
      ...(failure === "wrong-organization" ? { organization: "fabrikam" } : {}),
    });
    if (failure === "revoked-connection")
      await db.update(toolConnections).set({ status: "disabled" }).where(eq(toolConnections.id, selected.connectionId));
    if (failure === "other-repository") {
      await rejectsWithoutPat(resolve(input, provider("another-repo")), selected.secretId);
    } else if (failure === "non-running") {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
      await rejectsWithoutPat(resolve(input), selected.secretId);
    } else if (failure === "low-trust") {
      await db.update(issues).set({ executionPolicy: { authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET,
        trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: input.companyId, rootIssueId: input.issueId,
          issueIds: [input.issueId], allowedAgentIds: [input.agentId], allowedToolClasses: ["git.read"] } } } })
        .where(eq(issues.id, input.issueId));
      await rejectsWithoutPat(resolve(input), selected.secretId);
    } else if (failure === "ambiguous-grants") {
      await grant(input);
      await rejectsWithoutPat(resolve(input), selected.secretId);
    } else {
      await rejectsWithoutPat(resolve(input), selected.secretId);
    }
  });

  it("rechecks authorization after an in-flight provider response", async () => {
    const input = await seed();
    const selected = await grant(input);
    await rejectsWithoutPat(resolve(input, provider("repo", async () => {
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, selected.grantId));
    })), selected.secretId);
  });

  it("denies and returns no token when project consent changes during the provider request", async () => {
    const input = await seed();
    const selected = await grant(input, { targetType: "company" });
    const replacement = await grant(input, { targetType: "company" });
    const projectId = await linkProjectAuthorization(input, selected.grantId);
    await rejectsWithoutPat(resolve(input, provider("repo", async () => {
      await db.update(projectProviderAuthorizations).set({ grantId: replacement.grantId })
        .where(eq(projectProviderAuthorizations.projectId, projectId));
    })), selected.secretId);
  });

  it("denies if another eligible grant appears during the provider request without project consent", async () => {
    const input = await seed();
    const selected = await grant(input, { targetType: "company" });
    await rejectsWithoutPat(resolve(input, provider("repo", async () => {
      await grant(input, { targetType: "company" });
    })), selected.secretId);
  });
});
