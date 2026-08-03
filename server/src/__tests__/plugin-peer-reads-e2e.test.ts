import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginEntities,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping WF-3 E2E tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function makeManifest(
  pluginKey: string,
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: pluginKey,
    description: "Test",
    author: "Test",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

describeEmbeddedPostgres("WF-3 E2E — full RPC round-trip via buildHostServices", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-peer-reads-e2e-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function installPlugin(manifest: PaperclipPluginManifestV1): Promise<string> {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    return id;
  }

  async function enablePluginForCompany(pluginId: string, companyId: string): Promise<void> {
    await db.insert(pluginCompanySettings).values({
      id: randomUUID(),
      pluginId,
      companyId,
      enabled: true,
      settingsJson: {},
    });
  }

  it("consumer HostServices.peerEntities.list returns provider rows through full service stack", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });

    const providerManifest = makeManifest("e2e.provider", {
      peerReads: { allow: [{ entityType: "gitea-pr", consumers: ["e2e.consumer"] }] },
    });
    const consumerManifest = makeManifest("e2e.consumer", {
      capabilities: ["plugins.peer-reads.read"],
    });

    const providerId = await installPlugin(providerManifest);
    const consumerId = await installPlugin(consumerManifest);
    await enablePluginForCompany(providerId, companyId);
    await enablePluginForCompany(consumerId, companyId);

    // Seed a provider entity
    const issueId = randomUUID();
    const externalId = `PR-${randomUUID().slice(0, 8)}`;
    await db.insert(pluginEntities).values({
      id: randomUUID(),
      pluginId: providerId,
      entityType: "gitea-pr",
      scopeKind: "issue",
      scopeId: issueId,
      externalId,
      title: "Test PR",
      status: "open",
      data: { url: "https://git.example.com/pr/1" },
    });

    // Build host services as the consumer plugin
    const eventBus = createPluginEventBus();
    const services = buildHostServices(db, consumerId, "e2e.consumer", eventBus);

    try {
      const rows = await services.peerEntities.list({
        companyId,
        providerPluginKey: "e2e.provider",
        entityType: "gitea-pr",
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].externalId).toBe(externalId);
      expect(rows[0].entityType).toBe("gitea-pr");
      expect(rows[0].data).toMatchObject({ url: "https://git.example.com/pr/1" });
    } finally {
      services.dispose();
    }
  });

  it("consumer HostServices.peerEntities.get returns single entity by externalId", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });

    const providerManifest = makeManifest("e2e.provider2", {
      peerReads: { allow: [{ entityType: "gitea-pr", consumers: ["e2e.consumer2"] }] },
    });
    const consumerManifest = makeManifest("e2e.consumer2", {
      capabilities: ["plugins.peer-reads.read"],
    });

    const providerId = await installPlugin(providerManifest);
    const consumerId = await installPlugin(consumerManifest);
    await enablePluginForCompany(providerId, companyId);
    await enablePluginForCompany(consumerId, companyId);

    const issueId = randomUUID();
    const externalId = `PR-${randomUUID().slice(0, 8)}`;
    await db.insert(pluginEntities).values({
      id: randomUUID(),
      pluginId: providerId,
      entityType: "gitea-pr",
      scopeKind: "issue",
      scopeId: issueId,
      externalId,
      title: "My PR",
      status: "merged",
      data: {},
    });

    const eventBus = createPluginEventBus();
    const services = buildHostServices(db, consumerId, "e2e.consumer2", eventBus);

    try {
      const row = await services.peerEntities.get({
        companyId,
        providerPluginKey: "e2e.provider2",
        entityType: "gitea-pr",
        externalId,
        scopeKind: "issue",
        scopeId: issueId,
      });

      expect(row).not.toBeNull();
      expect(row?.externalId).toBe(externalId);
      expect(row?.status).toBe("merged");
    } finally {
      services.dispose();
    }
  });
});
