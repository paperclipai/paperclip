import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, companies, companySecrets, companySecretVersions, companySecretBindings, connectionGrants,
  createDb, toolApplications, toolConnections, userSecretDefinitions, userSecretDeclarations, toolAccessAuditEvents,
  managedAgentProfiles, routines, routineTriggers,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { backfillPersonalConnectionCredentials } from "../services/connection-credential-backfill.js";
import { resolveConnectionGrantSecret } from "../services/connection-credentials.js";
import { secretService } from "../services/secrets.js";
import * as bindings from "../services/connection-credential-bindings.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("personal connection credential repair", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-personal-credential-repair-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => { vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(managedAgentProfiles);
    await db.delete(routines);
    await db.delete(companySecrets);
    await db.delete(companies); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(path = "remote.url") {
    const [company] = await db.insert(companies).values({ name: "Repair fixture", issuePrefix: randomUUID().slice(0, 6) }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId: company!.id, applicationKey: "app-gallery:zapier:test", name: "Zapier", type: "mcp_http" }).returning();
    const secret = await secretService(db).create(company!.id, { name: "Zapier URL", key: `tool_app.${randomUUID()}.remote_url`, value: "fixture-canary", provider: "local_encrypted" }, { userId: "alice" });
    const ref = { secretId: secret.id, configPath: path, versionSelector: "latest" as const, required: true };
    const [connection] = await db.insert(toolConnections).values({ companyId: company!.id, applicationId: app!.id,
      name: "Zapier", uid: `test/${randomUUID()}`, transport: "mcp_remote", status: "active", credentialPolicy: "per_user", createdByUserId: "alice",
      config: { sourceTemplateKey: "zapier" }, credentialSecretRefs: [],
      credentialRefs: [{ name: path, secretId: secret.id, version: "latest", placement: path === "remote.url" ? "url" : "header", key: path === "remote.url" ? "url" : "Authorization" }],
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: company!.id, connectionId: connection!.id, kind: "user", subjectUserId: "alice", createdByUserId: "alice", status: "active", credentialSecretRefs: [ref] }).returning();
    await db.insert(companySecretBindings).values({ companyId: company!.id, secretId: secret.id, targetType: "tool_connection", targetId: connection!.id, configPath: path });
    return { company: company!, connection: connection!, grant: grant!, secret, ref };
  }

  it.each(["remote.url", "credentials.authorization", "headers.X-Api-Key"])("repairs %s without changing ciphertext, identity or history, idempotently", async (path) => {
    const f = await fixture(path);
    const before = await db.select().from(companySecretVersions);
    await expect(resolveConnectionGrantSecret(db, f.connection, f.grant, f.ref, {})).rejects.toMatchObject({ details: { code: "grant_credential_invalid" } });
    expect(await backfillPersonalConnectionCredentials(db)).toEqual({ repairedConnections: 1, repairedSecrets: 1, reconnectRequired: 0 });
    const [secret] = await db.select().from(companySecrets);
    expect(secret).toMatchObject({ id: f.secret.id, scope: "user", ownerUserId: "alice", latestVersion: 1 });
    expect(secret!.userSecretDefinitionId).toBeTruthy();
    expect(await db.select().from(companySecretVersions)).toEqual(before);
    expect(await db.select().from(companySecretBindings)).toEqual([]);
    expect(await db.select().from(userSecretDeclarations)).toEqual([expect.objectContaining({ configPath: path, userSecretDefinitionId: secret!.userSecretDefinitionId })]);
    await expect(resolveConnectionGrantSecret(db, f.connection, f.grant, f.ref, {})).resolves.toMatchObject({ value: "fixture-canary" });
    expect(await backfillPersonalConnectionCredentials(db)).toEqual({ repairedConnections: 0, repairedSecrets: 0, reconnectRequired: 0 });
    expect(await db.select().from(userSecretDefinitions)).toHaveLength(1);
    expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(1);
  });

  it.each(["other-grant", "same-connection-grant", "revoked-grant", "cross-company-reference", "other-target", "managed-profile", "routine-trigger", "conflicting-owner", "conflicting-grant-creator", "mismatched-shape", "deleted", "unmanaged", "shared-slot"])("leaves %s untouched and requests reconnect", async (reason) => {
    const f = await fixture();
    if (reason === "other-grant" || reason === "same-connection-grant" || reason === "revoked-grant") {
      let connectionId = f.connection.id;
      if (reason === "other-grant") {
        const [other] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: f.connection.applicationId, name: "Other", uid: randomUUID(), transport: "mcp_remote" }).returning();
        connectionId = other!.id;
      }
      await db.insert(connectionGrants).values({ companyId: f.company.id, connectionId, kind: "user", subjectUserId: "bob", status: reason === "revoked-grant" ? "revoked" : "active", credentialSecretRefs: [f.ref] });
    }
    if (reason === "cross-company-reference") {
      const [otherCompany] = await db.insert(companies).values({ name: "Other company", issuePrefix: randomUUID().slice(0, 6) }).returning();
      const [otherApp] = await db.insert(toolApplications).values({ companyId: otherCompany!.id, applicationKey: "other", name: "Other", type: "mcp_http" }).returning();
      await db.insert(toolConnections).values({ companyId: otherCompany!.id, applicationId: otherApp!.id,
        name: "Other", uid: randomUUID(), transport: "mcp_remote", credentialSecretRefs: [f.ref] });
    }
    if (reason === "other-target") await db.insert(companySecretBindings).values({ companyId: f.company.id, secretId: f.secret.id, targetType: "agent", targetId: randomUUID(), configPath: "env.KEY" });
    if (reason === "managed-profile") await db.insert(managedAgentProfiles).values({ companyId: f.company.id,
      profileKey: "shared", displayName: "Shared", anthropicAgentId: "fixture", agentVersion: "1", environmentId: "fixture", apiKeySecretId: f.secret.id });
    if (reason === "routine-trigger") {
      const [routine] = await db.insert(routines).values({ companyId: f.company.id, title: "Shared" }).returning();
      await db.insert(routineTriggers).values({ companyId: f.company.id, routineId: routine!.id, kind: "webhook", secretId: f.secret.id });
    }
    if (reason === "conflicting-owner") await db.update(companySecrets).set({ createdByUserId: "bob" }).where(eq(companySecrets.id, f.secret.id));
    if (reason === "conflicting-grant-creator") await db.update(connectionGrants).set({ createdByUserId: "bob" }).where(eq(connectionGrants.id, f.grant.id));
    if (reason === "mismatched-shape") await db.update(toolConnections).set({ credentialRefs: [] }).where(eq(toolConnections.id, f.connection.id));
    if (reason === "deleted") await db.update(companySecrets).set({ status: "deleted", deletedAt: new Date() }).where(eq(companySecrets.id, f.secret.id));
    if (reason === "unmanaged") await db.update(companySecrets).set({ key: "manually-managed" }).where(eq(companySecrets.id, f.secret.id));
    if (reason === "shared-slot") await db.update(toolConnections).set({ credentialSecretRefs: [f.ref] }).where(eq(toolConnections.id, f.connection.id));
    expect(await backfillPersonalConnectionCredentials(db)).toEqual({ repairedConnections: 0, repairedSecrets: 0, reconnectRequired: 1 });
    expect((await db.select().from(companySecrets))[0]!.scope).toBe("company");
    expect(await db.select().from(userSecretDefinitions)).toEqual([]);
    await backfillPersonalConnectionCredentials(db);
    expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(1);
    expect(JSON.stringify(await db.select().from(toolAccessAuditEvents))).not.toContain("fixture-canary");
  });

  it("rolls back metadata, definitions, declarations and audit if binding replacement fails", async () => {
    await fixture();
    vi.spyOn(bindings, "syncConnectionCredentialBindings").mockRejectedValueOnce(new Error("fixture rollback"));
    await expect(backfillPersonalConnectionCredentials(db)).rejects.toThrow("fixture rollback");
    expect((await db.select().from(companySecrets))[0]!.scope).toBe("company");
    expect(await db.select().from(userSecretDefinitions)).toEqual([]);
    expect(await db.select().from(companySecretBindings)).toHaveLength(1);
    expect(await db.select().from(toolAccessAuditEvents)).toEqual([]);
  });

  it.each(["missing", "wrong-owner", "inactive-definition", "deleted-definition"])("does not partially repair a grant with a %s credential", async (reason) => {
    const f = await fixture();
    let additionalSecretId = randomUUID();
    if (reason !== "missing") {
      const vault = secretService(db);
      const definition = await vault.createUserSecretDefinition(f.company.id, { key: "additional", name: "Additional", provider: "local_encrypted" });
      const value = await vault.createCurrentUserSecretValue(f.company.id, reason === "wrong-owner" ? "bob" : "alice",
        { definitionId: definition.id, value: "additional-fixture" });
      additionalSecretId = value.id;
      if (reason === "inactive-definition") await db.update(userSecretDefinitions).set({ status: "disabled" }).where(eq(userSecretDefinitions.id, definition.id));
      if (reason === "deleted-definition") await db.update(userSecretDefinitions).set({ deletedAt: new Date() }).where(eq(userSecretDefinitions.id, definition.id));
    }
    await db.update(connectionGrants).set({ credentialSecretRefs: [f.ref,
      { secretId: additionalSecretId, configPath: "headers.X-Extra", versionSelector: "latest", required: true },
    ] }).where(eq(connectionGrants.id, f.grant.id));
    const secretsBefore = await db.select().from(companySecrets);
    const definitionsBefore = await db.select().from(userSecretDefinitions);
    expect(await backfillPersonalConnectionCredentials(db)).toEqual({ repairedConnections: 0, repairedSecrets: 0, reconnectRequired: 1 });
    expect(await db.select().from(companySecrets)).toEqual(secretsBefore);
    expect(await db.select().from(userSecretDefinitions)).toEqual(definitionsBefore);
    expect((await db.select().from(toolConnections))[0]!.healthStatus).toBe("missing_secret");
    expect(await db.select().from(toolAccessAuditEvents)).toEqual([expect.objectContaining({ outcome: "failure" })]);
  });

  it("repairs a complete mixed grant and skips its transaction on the next startup", async () => {
    const f = await fixture();
    const vault = secretService(db);
    const definition = await vault.createUserSecretDefinition(f.company.id, { key: "existing", name: "Existing", provider: "local_encrypted" });
    const value = await vault.createCurrentUserSecretValue(f.company.id, "alice", { definitionId: definition.id, value: "existing-fixture" });
    await db.update(connectionGrants).set({ credentialSecretRefs: [f.ref,
      { secretId: value.id, configPath: "headers.X-Extra", versionSelector: "latest", required: true },
    ] }).where(eq(connectionGrants.id, f.grant.id));
    const versionsBefore = await db.select().from(companySecretVersions);
    expect(await backfillPersonalConnectionCredentials(db)).toEqual({ repairedConnections: 1, repairedSecrets: 1, reconnectRequired: 0 });
    expect(await db.select().from(companySecretVersions)).toEqual(versionsBefore);
    expect(await db.select().from(userSecretDeclarations)).toHaveLength(2);
    const transaction = vi.spyOn(db, "transaction");
    expect(await backfillPersonalConnectionCredentials(db)).toEqual({ repairedConnections: 0, repairedSecrets: 0, reconnectRequired: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("serializes concurrent startup repairs", async () => {
    await fixture();
    const results = await Promise.all([backfillPersonalConnectionCredentials(db), backfillPersonalConnectionCredentials(db)]);
    expect(results.reduce((sum, row) => sum + row.repairedSecrets, 0)).toBe(1);
    expect(await db.select().from(userSecretDefinitions)).toHaveLength(1);
    expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(1);
  });
});
