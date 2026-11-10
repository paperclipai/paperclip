import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  companySecrets,
  connectionGrantMembers,
  connectionGrants,
  createDb,
  projects,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { projectProviderAuthorizationService } from "../services/project-provider-authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("project provider authorizations", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-project-provider-auth-");
    db = createDb(temp.connectionString);
    [companyId] = (await db.insert(companies).values({ name: "Provider auth", issuePrefix: "PPA" }).returning()).map(x => x.id);
    [otherCompanyId] = (await db.insert(companies).values({ name: "Other provider auth", issuePrefix: "OPPA" }).returning()).map(x => x.id);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture() {
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    const [project] = await db.insert(projects).values({ companyId, name: `Project ${crypto.randomUUID()}` }).returning();
    for (const [principalId, membershipRole] of [["alice", "admin"], ["bob", "operator"], ["viewer", "viewer"]]) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, membershipRole });
    }
    async function connection(org: string, options: { provider?: string; company?: string; installed?: boolean } = {}) {
      const targetCompany = options.company ?? companyId;
      const [app] = await db.insert(toolApplications).values({
        companyId: targetCompany, name: `Azure DevOps ${org} ${crypto.randomUUID()}`, type: "rest_api",
        applicationKey: `${options.provider === "wrong" ? "github" : "azure-devops"}-${crypto.randomUUID()}`,
      }).returning();
      const [conn] = await db.insert(toolConnections).values({
        companyId: targetCompany, applicationId: app.id, name: org, uid: `${org}-${crypto.randomUUID()}`,
        status: "active", enabled: true, transport: "rest_api", authKind: "api_key", credentialPolicy: "shared",
        config: {
          sourceTemplateKey: options.provider === "wrong" ? "github" : "azure-devops",
          connectionMethodKey: "pat",
          url: "https://dev.azure.com",
          methodConfig: { organization: org },
        },
      }).returning();
      if (options.installed !== false) {
        await db.insert(toolConnectionInstalls).values({ companyId: targetCompany, connectionId: conn.id, targetType: "company", targetId: targetCompany });
      }
      return conn;
    }
    async function grant(conn: typeof toolConnections.$inferSelect, kind: "user" | "organization", subjectUserId: string | null, members: string[] = [], status: "active" | "revoked" = "active") {
      const marker = crypto.randomUUID();
      const definition = kind === "user" ? (await db.insert(userSecretDefinitions).values({ companyId: conn.companyId, name: `Azure token ${marker}`, key: `azure-token-${marker}` }).returning())[0] : undefined;
      const [secret] = await db.insert(companySecrets).values({
        companyId: conn.companyId, name: `Azure token ${marker}`, key: `azure-token-${marker}`,
        scope: definition ? "user" : "company", ownerUserId: definition ? subjectUserId : null,
        userSecretDefinitionId: definition?.id,
      }).returning();
      const [row] = await db.insert(connectionGrants).values({
        companyId: conn.companyId, connectionId: conn.id, kind, subjectUserId, status,
        providerTenant: { name: (conn.config.methodConfig as { organization: string }).organization },
        credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.authorization", versionSelector: "latest" }],
      }).returning();
      for (const subjectId of members) await db.insert(connectionGrantMembers).values({ companyId: conn.companyId, grantId: row.id, subjectType: "user", subjectId });
      return row;
    }
    return { project: project!, connection, grant };
  }

  it("stores independent choices per Azure organization and removes only the requested scope", async () => {
    const f = await fixture();
    const orgA = await f.connection("contoso");
    const orgB = await f.connection("fabrikam");
    const ownA = await f.grant(orgA, "user", "alice");
    const ownB = await f.grant(orgB, "user", "alice");
    const svc = projectProviderAuthorizationService(db);

    await svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", ownA.id);
    await svc.set(companyId, f.project.id, "alice", "azure-devops", "fabrikam", ownB.id);
    expect(await svc.read(companyId, f.project.id, "alice", "azure-devops", "contoso")).toMatchObject({ grantId: ownA.id });
    expect(await svc.read(companyId, f.project.id, "alice", "azure-devops", "fabrikam")).toMatchObject({ grantId: ownB.id });

    await svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", null);
    expect(await svc.read(companyId, f.project.id, "alice", "azure-devops", "contoso")).toMatchObject({
      provider: "azure-devops", scopeKey: "contoso", grantId: null,
    });
    expect(await svc.read(companyId, f.project.id, "alice", "azure-devops", "fabrikam")).toMatchObject({ grantId: ownB.id });
  });

  it("allows only an active member to select their own personal grant or an organization grant that includes them", async () => {
    const f = await fixture();
    const conn = await f.connection("contoso");
    const own = await f.grant(conn, "user", "alice");
    const bob = await f.grant(conn, "user", "bob");
    const sharedForAlice = await f.grant(conn, "organization", null, ["alice"]);
    const sharedForBob = await f.grant(conn, "organization", null, ["bob"]);
    const svc = projectProviderAuthorizationService(db);
    await svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", own.id);
    await svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", sharedForAlice.id);
    await expect(svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", bob.id)).rejects.toThrow();
    await expect(svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", sharedForBob.id)).rejects.toThrow();
    await expect(svc.set(companyId, f.project.id, "viewer", "azure-devops", "contoso", own.id)).rejects.toThrow();
    await expect(svc.set(companyId, f.project.id, "outsider", "azure-devops", "contoso", own.id)).rejects.toThrow();
  });

  it("rejects revoked, disabled, uninstalled, cross-company, wrong-provider and cross-scope grants", async () => {
    const f = await fixture();
    const healthy = await f.connection("contoso");
    const revokedConnection = await f.connection("revoked");
    const disabledConnection = await f.connection("disabled");
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, disabledConnection.id));
    const detachedConnection = await f.connection("detached", { installed: false });
    const wrongProviderConnection = await f.connection("wrong-provider", { provider: "wrong" });
    const otherCompanyConnection = await f.connection("other-company", { company: otherCompanyId });
    const revoked = await f.grant(revokedConnection, "user", "alice", [], "revoked");
    const disabled = await f.grant(disabledConnection, "user", "alice");
    const detached = await f.grant(detachedConnection, "user", "alice");
    const wrongProvider = await f.grant(wrongProviderConnection, "user", "alice");
    const crossCompany = await f.grant(otherCompanyConnection, "user", "alice");
    const healthyGrant = await f.grant(healthy, "user", "alice");
    const svc = projectProviderAuthorizationService(db);
    for (const id of [revoked.id, disabled.id, detached.id, wrongProvider.id, crossCompany.id]) {
      await expect(svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", id)).rejects.toThrow();
    }
    await expect(svc.set(companyId, f.project.id, "alice", "azure-devops", "fabrikam", healthyGrant.id)).rejects.toThrow();
    await expect(svc.set(companyId, f.project.id, "alice", "github", "contoso", healthyGrant.id)).rejects.toThrow();
    await expect(svc.set(otherCompanyId, f.project.id, "alice", "azure-devops", "contoso", healthyGrant.id)).rejects.toThrow();
  });

  it("does not expose credentials in the read result", async () => {
    const f = await fixture();
    const conn = await f.connection("contoso");
    const own = await f.grant(conn, "user", "alice");
    const svc = projectProviderAuthorizationService(db);
    await svc.set(companyId, f.project.id, "alice", "azure-devops", "contoso", own.id);
    const read = await svc.read(companyId, f.project.id, "alice", "azure-devops", "contoso");
    expect(read).toMatchObject({
      provider: "azure-devops", scopeKey: "contoso", grantId: own.id, authorizedByUserId: "alice",
    });
    expect(read.options).toContainEqual({ grantId: own.id, connectionName: "contoso", organization: "contoso" });
    expect(JSON.stringify(read)).not.toContain("Azure token");
  });
});
