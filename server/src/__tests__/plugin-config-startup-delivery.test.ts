import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * LOOA-629: a plugin worker is spawned once per plugin (not per company) with
 * an empty bootstrap config, and can only read company-scoped config from
 * inside a company-scoped invocation. A proactive plugin (e.g. the chat
 * gateway) has no such invocation at setup(), so the loader must replay every
 * configured company's config to the freshly-started worker. That replay reads
 * the config rows via `registry.listConfigs(pluginId)`, which this exercises.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin config startup-delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("registry.listConfigs (startup config delivery)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(pluginKey: string, installOrder: number) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: `@paperclipai/${pluginKey}`,
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "0.0.1",
        displayName: pluginKey,
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  it("returns every company-scoped config row for a plugin", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    await registry.upsertConfig(pluginId, companyA, {
      companyId: companyA,
      configJson: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a" },
    });
    await registry.upsertConfig(pluginId, companyB, {
      companyId: companyB,
      configJson: { slackBotToken: "xoxb-b", slackAppToken: "xapp-b" },
    });

    const rows = await registry.listConfigs(pluginId);
    expect(rows).toHaveLength(2);

    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    expect(byCompany.get(companyA)?.configJson).toMatchObject({ slackBotToken: "xoxb-a" });
    expect(byCompany.get(companyB)?.configJson).toMatchObject({ slackBotToken: "xoxb-b" });
  });

  it("only returns rows for the requested plugin (no cross-plugin bleed)", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const otherPluginId = await seedPlugin("paperclip.other-test", 2);
    const companyA = await seedCompany();

    await registry.upsertConfig(pluginId, companyA, {
      companyId: companyA,
      configJson: { marker: "mine" },
    });
    await registry.upsertConfig(otherPluginId, companyA, {
      companyId: companyA,
      configJson: { marker: "theirs" },
    });

    const rows = await registry.listConfigs(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configJson).toMatchObject({ marker: "mine" });
  });

  it("returns an empty list when the plugin has no configured companies", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const rows = await registry.listConfigs(pluginId);
    expect(rows).toEqual([]);
  });
});
