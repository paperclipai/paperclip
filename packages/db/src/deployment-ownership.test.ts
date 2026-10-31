import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { assertSameDeploymentDatabase, createDb } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { agents, budgetPolicies, companies, deploymentResources, companySecrets, companySecretVersions } from "./schema/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("paperclip-deployment-ownership-");
  db = createDb(database.connectionString);
}, 90_000);
afterAll(async () => { await database?.cleanup(); });

it("protects declared fields and deletion while preserving operational pauses and spending", async () => {
  const [company] = await db.insert(companies).values({ name: "Managed", issuePrefix: "MAN" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "idle", adapterType: "process" }).returning();
  await db.insert(deploymentResources).values({ owner: "test", kind: "agent", key: "worker", resourceId: agent.id,
    companyId: company.id, fields: { name: "Worker" } });
  await expect(db.update(agents).set({ name: "Changed" }).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned field cannot be changed" } });
  await expect(db.delete(agents).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned resources cannot be deleted" } });
  await db.update(agents).set({ status: "paused", spentMonthlyCents: 123 }).where(eq(agents.id, agent.id));
  expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]).toMatchObject({ name: "Worker", status: "paused", spentMonthlyCents: 123 });
  await db.transaction(async tx => {
    await tx.execute(sql`select set_config('paperclip.deployment_apply', 'on', true)`);
    await tx.update(agents).set({ name: "Declared rename" }).where(eq(agents.id, agent.id));
  });
  await expect(db.update(agents).set({ name: "Outside transaction" }).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned field cannot be changed" } });
  await db.update(deploymentResources).set({ enabled: false }).where(eq(deploymentResources.resourceId, agent.id));
  await expect(db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively disabled resource cannot be resumed" } });
});

it("rejects ordinary secret-version changes for declared credentials", async () => {
  const [company] = await db.insert(companies).values({ name: "Secrets", issuePrefix: "SEC" }).returning();
  const [secret] = await db.insert(companySecrets).values({ companyId: company.id, key: "worker_token", name: "Worker token", provider: "local_encrypted" }).returning();
  await db.insert(deploymentResources).values({ owner: "test", kind: "secret", key: "token", resourceId: secret.id,
    companyId: company.id, fields: {} });
  await expect(db.insert(companySecretVersions).values({ secretId: secret.id, version: 1,
    material: { fixture: "ciphertext" }, valueSha256: "fixture-hash", fingerprintSha256: "fixture-fingerprint" }))
    .rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned secret versions cannot be changed" } });
  expect(await db.select().from(companySecretVersions)).toHaveLength(0);
});

it("keeps a declared budget limit enforced", async () => {
  const [company] = await db.insert(companies).values({ name: "Budgeted", issuePrefix: "BUD" }).returning();
  await db.insert(deploymentResources).values({ owner: "test", kind: "company", key: "budgeted", resourceId: company.id,
    companyId: company.id, fields: { budgetMonthlyCents: 500 } });
  const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "company", scopeId: company.id,
    windowKind: "calendar_month_utc", amount: 500 }).returning();
  for (const change of [{ isActive: false }, { hardStopEnabled: false }, { amount: 900 }]) {
    await expect(db.update(budgetPolicies).set(change).where(eq(budgetPolicies.id, policy.id)))
      .rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned budget policy cannot be changed" } });
  }
  await expect(db.delete(budgetPolicies).where(eq(budgetPolicies.id, policy.id)))
    .rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned budget policy cannot be deleted" } });
  const [lifetime] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "company", scopeId: company.id,
    windowKind: "lifetime", amount: 700 }).returning();
  await db.update(budgetPolicies).set({ amount: 800, isActive: false }).where(eq(budgetPolicies.id, lifetime.id));
  await db.update(budgetPolicies).set({ enforcementDeliveredVersion: 1 }).where(eq(budgetPolicies.id, policy.id));
});

it("refuses a migration connection that reaches another database", async () => {
  const url = database.connectionString;
  await assertSameDeploymentDatabase(url, url);
  await assertSameDeploymentDatabase(url, `${url}?application_name=migration`);
  const tokyo = new URL(url);
  tokyo.searchParams.set("options", "-c TimeZone=Asia/Tokyo -c DateStyle=SQL,DMY");
  await assertSameDeploymentDatabase(url, tokyo.toString());
  const other = new URL(url);
  other.pathname = "/postgres";
  await expect(assertSameDeploymentDatabase(url, other.toString())).rejects.toThrow("leased database");
});
