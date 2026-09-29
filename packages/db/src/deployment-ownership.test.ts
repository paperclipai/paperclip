import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { agents, companies, deploymentResources, companySecrets, companySecretVersions } from "./schema/index.js";

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
