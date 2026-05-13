import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginEntities,
  pluginJobs,
  pluginJobRuns,
  pluginLogs,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin tenant-isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin tenant isolation (company_id FK)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-tenant-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginLogs);
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.tenant-isolation-test",
      packageName: "@paperclipai/plugin-tenant-isolation-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.tenant-isolation-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Tenant Isolation Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Tenant ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  it("allows NULL company_id on plugin_logs (instance-scope rows behave as before)", async () => {
    const pluginId = await seedPlugin();
    await db.insert(pluginLogs).values({
      pluginId,
      // companyId intentionally omitted — NULL means instance-scope.
      level: "info",
      message: "instance-scope log",
    });
    const rows = await db.select().from(pluginLogs).where(eq(pluginLogs.pluginId, pluginId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBeNull();
  });

  it("cascades plugin_logs / plugin_entities / plugin_job_runs / plugin_webhook_deliveries when the owning company is deleted", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    // Seed a job + run so we can verify plugin_job_runs cascades too.
    const jobAId = randomUUID();
    const jobBId = randomUUID();
    await db.insert(pluginJobs).values([
      { id: jobAId, pluginId, jobKey: "cron-a", schedule: "* * * * *" },
      { id: jobBId, pluginId, jobKey: "cron-b", schedule: "* * * * *" },
    ]);

    await db.insert(pluginLogs).values([
      { pluginId, companyId: companyA, level: "info", message: "A log" },
      { pluginId, companyId: companyB, level: "info", message: "B log" },
      { pluginId, level: "info", message: "instance log" },
    ]);

    await db.insert(pluginEntities).values([
      {
        pluginId,
        companyId: companyA,
        entityType: "issue",
        scopeKind: "company",
        scopeId: companyA,
        externalId: "ext-a",
      },
      {
        pluginId,
        companyId: companyB,
        entityType: "issue",
        scopeKind: "company",
        scopeId: companyB,
        externalId: "ext-b",
      },
    ]);

    await db.insert(pluginJobRuns).values([
      { jobId: jobAId, pluginId, companyId: companyA, trigger: "manual" },
      { jobId: jobBId, pluginId, companyId: companyB, trigger: "manual" },
      { jobId: jobAId, pluginId, trigger: "scheduled" },
    ]);

    await db.insert(pluginWebhookDeliveries).values([
      { pluginId, companyId: companyA, webhookKey: "wh", payload: { who: "A" } },
      { pluginId, companyId: companyB, webhookKey: "wh", payload: { who: "B" } },
      { pluginId, webhookKey: "wh", payload: { who: "instance" } },
    ]);

    // Delete company A — only A's rows should be reaped. B's and NULL-scope rows stay.
    await db.delete(companies).where(eq(companies.id, companyA));

    const logs = await db.select().from(pluginLogs);
    expect(logs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const entities = await db.select().from(pluginEntities);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.companyId).toBe(companyB);

    const runs = await db.select().from(pluginJobRuns);
    expect(runs.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );

    const deliveries = await db.select().from(pluginWebhookDeliveries);
    expect(deliveries.map((r) => r.companyId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [companyB, null].sort((a, b) => String(a).localeCompare(String(b))),
    );
  });
});
