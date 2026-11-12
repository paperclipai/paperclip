import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies, companyMemberships, companySecrets, connectionGrantMembers, connectionGrants,
  createDb, projectProviderAuthorizations, projectWorkspaces, projects, toolApplications,
  toolConnectionInstalls, toolConnections, userSecretDefinitions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { resolveAzureDevOpsProjectGitCredentials } from "../services/azure-project-git-credentials.js";
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_PAT_METHOD } from "../services/connectors/azure-devops/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const tokenValues = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => tokenValues.get(secretId) ?? "",
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: tokenValues.get(input.definitionId) ?? "" }),
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Azure DevOps project Git credentials", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  const repoUrl = "https://dev.azure.com/contoso/Project/_git/repo";
  const secretValue = "private-azure-project-pat";

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-azure-project-git-auth-");
    db = createDb(database.connectionString);
  }, 30_000);
  beforeEach(async () => {
    tokenValues.clear();
    [companyId] = (await db.insert(companies).values({ name: `Azure project ${crypto.randomUUID()}`, issuePrefix: crypto.randomUUID().slice(0, 8) }).returning({ id: companies.id })).map(row => row.id);
    [otherCompanyId] = (await db.insert(companies).values({ name: `Other Azure ${crypto.randomUUID()}`, issuePrefix: crypto.randomUUID().slice(0, 8) }).returning({ id: companies.id })).map(row => row.id);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "alice", membershipRole: "admin", status: "active" },
      { companyId, principalType: "user", principalId: "viewer", membershipRole: "viewer", status: "active" },
      { companyId, principalType: "user", principalId: "inactive", membershipRole: "admin", status: "inactive" },
    ]);
    [projectId] = (await db.insert(projects).values({ companyId, name: "Azure project" }).returning({ id: projects.id })).map(row => row.id);
    await db.insert(projectWorkspaces).values({ companyId, projectId, name: "repo", sourceType: "git", repoUrl,
      metadata: { repositoryProvider: "azure-devops", repositoryId: "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab" }, isPrimary: true });
  });
  afterEach(() => tokenValues.clear());
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function connection(options: { installed?: boolean; enabled?: boolean; status?: "active" | "revoked"; owner?: string; organization?: string } = {}) {
    const targetCompany = companyId;
    const [app] = await db.insert(toolApplications).values({ companyId: targetCompany, name: `Azure ${crypto.randomUUID()}`, type: "rest_api" }).returning();
    const definition = await db.insert(userSecretDefinitions).values({ companyId: targetCompany, name: "Azure PAT", key: `azure-pat-${crypto.randomUUID()}` }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId: targetCompany, name: "Azure PAT", key: `azure-pat-${crypto.randomUUID()}`,
      scope: "user", ownerUserId: options.owner ?? "alice", userSecretDefinitionId: definition[0]!.id }).returning();
    tokenValues.set(secret.id, secretValue);
    tokenValues.set(definition[0]!.id, secretValue);
    const [conn] = await db.insert(toolConnections).values({ companyId: targetCompany, applicationId: app.id, name: "Azure DevOps", uid: crypto.randomUUID(),
      transport: "rest_api", authKind: "api_key", credentialSource: "paperclip_vault", credentialPolicy: "per_user",
      status: "active", enabled: options.enabled ?? true,
      config: { sourceTemplateKey: "azure-devops", connectionMethodKey: AZURE_DEVOPS_PAT_METHOD, url: AZURE_DEVOPS_API_URL,
        methodConfig: { organization: options.organization ?? "contoso" } } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: targetCompany, connectionId: conn.id, kind: "user",
      subjectUserId: options.owner ?? "alice", status: options.status ?? "active",
      credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.authorization", versionSelector: "latest" }] }).returning();
    if (options.installed !== false) await db.insert(toolConnectionInstalls).values({ companyId: targetCompany, connectionId: conn.id, targetType: "company", targetId: targetCompany });
    return { connection: conn, grant };
  }

  async function consent(grantId: string, authorizedByUserId = "alice", targetProjectId = projectId, targetCompanyId = companyId) {
    await db.insert(projectProviderAuthorizations).values({ companyId: targetCompanyId, projectId: targetProjectId,
      provider: "azure-devops", scopeKey: "contoso", grantId, authorizedByUserId });
  }

  const catalog = async (url: string, init: RequestInit): Promise<Response> => {
    expect(url).toBe("https://dev.azure.com/contoso/_apis/git/repositories?api-version=7.1");
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
    expect(init?.redirect).toBe("error");
    return Response.json({ value: [{ id: "12345678-1234-1234-1234-1234567890ab", name: "repo", project: { name: "Project" } }] });
  };
  const resolve = (url = repoUrl, request = catalog) => resolveAzureDevOpsProjectGitCredentials(db, { companyId, projectId, repoUrl: url }, { request });

  async function expectUnavailable(promise: Promise<unknown>) {
    let error: unknown;
    try { await promise; } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(secretValue);
  }

  it("returns Git credentials only after the recorded project consent, workspace selection, and live Azure catalog all match", async () => {
    const { grant } = await connection();
    await consent(grant.id);
    const result = await resolve();
    expect(result).toMatchObject({ repositoryAuthority: { provider: "azure-devops", url: repoUrl }, source: "managed_connection" });
    expect(result.env.PAPERCLIP_AZURE_GIT_TOKEN).toBe(secretValue);
    expect(JSON.stringify({ ...result, env: {} })).not.toContain(secretValue);
  });

  it("rejects a live catalog entry with the same repository URL but a different repository UUID", async () => {
    const { grant } = await connection();
    await consent(grant.id);
    const differentIdentity = async (url: string, init: RequestInit) => {
      await catalog(url, init);
      return Response.json({ value: [{ id: "87654321-1234-1234-1234-1234567890ab", name: "repo", project: { name: "Project" } }] });
    };

    await expectUnavailable(resolve(repoUrl, differentIdentity));
  });

  it.each(["revoked", "disabled", "uninstalled", "wrong-org", "wrong-workspace", "not-in-live-catalog"])(
    "fails closed for %s without exposing the vault value", async failure => {
      const selected = await connection({
        ...(failure === "revoked" ? { status: "revoked" as const } : {}),
        ...(failure === "disabled" ? { enabled: false } : {}),
        ...(failure === "uninstalled" ? { installed: false } : {}),
        ...(failure === "wrong-org" ? { organization: "fabrikam" } : {}),
      });
      await consent(selected.grant.id);
      if (failure === "wrong-workspace") {
        await db.update(projectWorkspaces).set({ repoUrl: "https://dev.azure.com/contoso/Project/_git/other" }).where(eq(projectWorkspaces.projectId, projectId));
      }
      const request = failure === "not-in-live-catalog"
      ? async (url: string, init: RequestInit) => { await catalog(url, init); return Response.json({ value: [] }); }
        : catalog;
      await expectUnavailable(resolve(repoUrl, request));
    },
  );

  it("does not resolve a project through another company's scope", async () => {
    const { grant } = await connection();
    await consent(grant.id);
    await expectUnavailable(resolveAzureDevOpsProjectGitCredentials(db, { companyId: otherCompanyId, projectId, repoUrl }, { request: catalog }));
  });

  it.each(["viewer-owner", "inactive-owner", "other-project-consent"])("rejects %s and does not expose the secret", async failure => {
    const { grant } = await connection();
    if (failure === "other-project-consent") {
      const [another] = await db.insert(projects).values({ companyId, name: "Another project" }).returning();
      await consent(grant.id, "alice", another.id);
    } else await consent(grant.id, failure === "viewer-owner" ? "viewer" : "inactive");
    await expectUnavailable(resolve());
  });

  it("requires the consenting owner to retain private project access", async () => {
    const { grant } = await connection();
    await db.update(projects).set({ visibility: "private", privacyOwnerUserId: "bob" }).where(eq(projects.id, projectId));
    await consent(grant.id);
    await expectUnavailable(resolve());
  });

  it("rechecks project consent and grant after the live Azure request", async () => {
    const { grant } = await connection();
    await consent(grant.id);
    const request = async (url: string, init: RequestInit) => {
      const response = await catalog(url, init);
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, grant.id));
      return response;
    };
    await expectUnavailable(resolve(repoUrl, request));
  });
});
