import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers,
  toolApplications, toolConnections, toolConnectionInstalls, userSecretDefinitions, createDb,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_PAT_METHOD } from "../services/connectors/azure-devops/index.js";
import { mergeProjectRepository } from "../services/project-repositories.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const secretValues = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => secretValues.get(secretId) ?? secretId,
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: secretValues.get(input.definitionId) }),
  syncUserSecretDeclarationsForTarget: async () => undefined,
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Azure DevOps project repositories", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let caseNo = 0;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-azure-repositories-");
    db = createDb(temp.connectionString);
  }, 20_000);
  beforeEach(async () => {
    caseNo++;
    [companyId] = (await db.insert(companies).values({ name: `Azure repositories ${caseNo}`, issuePrefix: `AZ${caseNo}` }).returning()).map(row => row.id);
    [otherCompanyId] = (await db.insert(companies).values({ name: `Other Azure company ${caseNo}`, issuePrefix: `OA${caseNo}` }).returning()).map(row => row.id);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "alice", membershipRole: "admin" },
      { companyId, principalType: "user", principalId: "bob", membershipRole: "member" },
      { companyId: otherCompanyId, principalType: "user", principalId: "alice", membershipRole: "admin" },
    ]);
  });
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { secretValues.clear(); });

  it("creates an Azure DevOps REST application when applicationId is omitted", async () => {
    const [secret] = await db.insert(companySecrets).values({
      companyId, name: "Azure DevOps PAT", key: "azure-devops-pat", scope: "company",
    }).returning();
    const connection = await toolAccessService(db).createConnection(companyId, {
      name: "Azure DevOps REST",
      connectionPurpose: "tool",
      transport: "rest_api",
      authKind: "api_key",
      credentialPolicy: "shared",
      connectionKind: "managed",
      ownership: "customer",
      enabled: true,
      status: "active",
      transportConfig: {},
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "credentials.authorization", versionSelector: "latest" }],
      config: {
        sourceTemplateKey: "azure-devops",
        connectionMethodKey: AZURE_DEVOPS_PAT_METHOD,
        url: AZURE_DEVOPS_API_URL,
        methodConfig: { organization: "contoso" },
      },
    }, { actorType: "user", actorId: "alice" });

    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    expect(application.type).toBe("rest_api");
  });

  async function connection(options: {
    name: string; company?: string; organization: string; owner?: string | null;
    grantKind?: "user" | "organization"; members?: string[]; installed?: boolean;
    status?: "active" | "revoked" | "expired" | "needs_reauthorization";
    enabled?: boolean; connectionStatus?: "active" | "disabled" | "draft";
  }) {
    const targetCompanyId = options.company ?? companyId;
    const [app] = await db.insert(toolApplications).values({ companyId: targetCompanyId, name: `${options.name} app`, type: "rest_api", status: "active" }).returning();
    const definition = options.grantKind === "user"
      ? (await db.insert(userSecretDefinitions).values({ companyId: targetCompanyId, name: `${options.name} token`, key: `${options.name}-token` }).returning())[0]
      : undefined;
    const [secret] = await db.insert(companySecrets).values({ companyId: targetCompanyId, name: `${options.name} token`, key: `${options.name}-token`,
      scope: definition ? "user" : "company", ownerUserId: definition ? (options.owner ?? "alice") : null, userSecretDefinitionId: definition?.id }).returning();
    secretValues.set(secret.id, `token-${options.name}`);
    if (definition) secretValues.set(definition.id, secret.id);
    const [conn] = await db.insert(toolConnections).values({
      companyId: targetCompanyId, applicationId: app.id, name: options.name, uid: options.name,
      transport: "rest_api", authKind: "api_key", credentialPolicy: options.grantKind === "user" ? "per_user" : "shared",
      status: options.connectionStatus ?? "active", enabled: options.enabled ?? true,
      config: { sourceTemplateKey: "azure-devops", connectionMethodKey: AZURE_DEVOPS_PAT_METHOD,
        url: AZURE_DEVOPS_API_URL, methodConfig: { organization: options.organization } },
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId: targetCompanyId, connectionId: conn.id, kind: options.grantKind ?? "organization",
      subjectUserId: options.grantKind === "user" ? (options.owner ?? "alice") : null,
      status: options.status ?? "active",
      credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.authorization", versionSelector: "latest" }],
    }).returning();
    if (options.installed ?? true) await db.insert(toolConnectionInstalls).values({ companyId: targetCompanyId, connectionId: conn.id, targetType: "company", targetId: targetCompanyId });
    for (const userId of options.members ?? []) await db.insert(connectionGrantMembers).values({ companyId: targetCompanyId, grantId: grant.id, subjectType: "user", subjectId: userId });
    return conn;
  }

  it("lists Azure repos only through active installed company access and the requesting user's grant", async () => {
    await connection({ name: "org-shared", organization: "contoso", members: ["alice", "bob"] });
    await connection({ name: "alice-personal", organization: "aliceorg", grantKind: "user", owner: "alice" });
    await connection({ name: "bob-personal", organization: "boborg", grantKind: "user", owner: "bob" });
    await connection({ name: "org-restricted", organization: "restricted", members: ["bob"] });
    await connection({ name: "not-installed", organization: "uninstalled", installed: false, members: ["alice"] });
    const calls: string[] = [];
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
      const org = new URL(url).pathname.split("/")[1];
      return Response.json({ value: [{ id: "12345678-1234-1234-1234-1234567890ab", name: "repo", project: { name: "Project" }, remoteUrl: `https://dev.azure.com/${org}/Project/_git/repo` }] });
    };
    const result = await toolAccessService(db, { remoteHttpRequest: request }).listProjectRepositories(companyId, "alice");
    expect(result.repositories.map(repo => repo.provider).every(provider => provider === "azure-devops")).toBe(true);
    expect(result.repositories.map(repo => repo.fullName).sort()).toEqual(["aliceorg/Project/repo", "contoso/Project/repo"]);
    expect(result.repositories.map(repo => repo.id).sort()).toEqual([
      "azure-devops:aliceorg:12345678-1234-1234-1234-1234567890ab",
      "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab",
    ]);
    expect(calls.map(url => new URL(url).pathname.split("/")[1]).sort()).toEqual(["aliceorg", "contoso"]);
    expect(JSON.stringify(result)).not.toContain("Basic ");
  });

  it("omits disabled, revoked, and other-company connections and never leaks provider error details", async () => {
    await connection({ name: "disabled", organization: "disabled", members: ["alice"], enabled: false });
    await connection({ name: "revoked", organization: "revoked", members: ["alice"], status: "revoked" });
    await connection({ name: "foreign", company: otherCompanyId, organization: "foreign", members: ["alice"] });
    await connection({ name: "provider-error", organization: "broken", members: ["alice"] });
    const request = async (input: string | URL | Request) => {
      if (String(input).includes("/broken/")) return new Response("PRIVATE-SECRET-DETAIL", { status: 503 });
      return Response.json({ value: [] });
    };
    const result = await toolAccessService(db, { remoteHttpRequest: request }).listProjectRepositories(companyId, "alice");
    expect(result.repositories).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-SECRET-DETAIL");
    expect(await toolAccessService(db, { remoteHttpRequest: request }).listProjectRepositories(otherCompanyId, "alice")).toMatchObject({ repositories: [] });
  });

  it("rechecks grant access after an in-flight Azure provider request", async () => {
    const conn = await connection({ name: "revoked-in-flight", organization: "contoso", members: ["alice"] });
    const request = async () => {
      await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.connectionId, conn.id));
      return Response.json({ value: [{ id: "12345678-1234-1234-1234-1234567890ab", name: "repo", project: { name: "Project" } }] });
    };
    const result = await toolAccessService(db, { remoteHttpRequest: request }).listProjectRepositories(companyId, "alice");
    expect(result.repositories).toEqual([]);
  });

  it("keeps successful Azure catalogs when one connection fails and starts requests concurrently", async () => {
    await connection({ name: "azure-good", organization: "contoso", members: ["alice"] });
    await connection({ name: "azure-failing", organization: "broken", members: ["alice"] });
    let started = 0;
    let timedOut = false;
    let releaseBarrier!: () => void;
    const bothStarted = new Promise<void>(resolve => { releaseBarrier = resolve; });
    const request = async (input: string | URL | Request) => {
      const url = String(input);
      started++;
      if (started >= 2) releaseBarrier();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([bothStarted, new Promise<void>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, 5_000); })]); }
      finally { if (timer) clearTimeout(timer); }
      if (url.includes("/broken/")) return new Response("PRIVATE-SECRET-DETAIL", { status: 503 });
      return Response.json({ value: [{ id: "12345678-1234-1234-1234-1234567890ab", name: "repo", project: { name: "Project" } }] });
    };
    const result = await toolAccessService(db, { remoteHttpRequest: request }).listProjectRepositories(companyId, "alice");
    expect(started).toBe(2);
    expect(timedOut).toBe(false);
    expect(result.repositories.map(repo => repo.fullName)).toEqual(["contoso/Project/repo"]);
    expect(result.failedConnectionCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-SECRET-DETAIL");
  }, 15_000);

  it("keeps Azure and GitHub identifiers distinct when their provider IDs collide", async () => {
    await connection({ name: "azure-collision", organization: "contoso", members: ["alice"] });
    const repositories = new Map();
    mergeProjectRepository(repositories, { id: "42", provider: "github", fullName: "org/shared", url: "https://github.com/org/shared" }, "GitHub");
    mergeProjectRepository(repositories, { id: "contoso:12345678-1234-1234-1234-1234567890ab", provider: "azure-devops", fullName: "contoso/Project/shared", url: "https://dev.azure.com/contoso/Project/_git/shared" }, "Azure Contoso");
    mergeProjectRepository(repositories, { id: "fabrikam:12345678-1234-1234-1234-1234567890ab", provider: "azure-devops", fullName: "fabrikam/Project/shared", url: "https://dev.azure.com/fabrikam/Project/_git/shared" }, "Azure Fabrikam");
    expect([...repositories.keys()].sort()).toEqual([
      "42",
      "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab",
      "azure-devops:fabrikam:12345678-1234-1234-1234-1234567890ab",
    ]);
  });
});
