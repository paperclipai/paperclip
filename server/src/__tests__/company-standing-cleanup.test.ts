import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyStanding,
  createDb,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { companyStandingService } from "../services/company-standing.ts";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company standing cleanup on plugin lifecycle transitions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standing-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const pluginId = randomUUID();
    for (const [companyId, name] of [
      [companyA, "Cleanup Co A"],
      [companyB, "Cleanup Co B"],
    ] as const) {
      await db.insert(companies).values({
        id: companyId,
        name,
        issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.billing",
      packageName: "@paperclipai/plugin-billing",
      version: "1.0.0",
      manifestJson: {
        id: "paperclip.billing",
        name: "Billing",
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });
    const standings = companyStandingService(db);
    await standings.setStanding(pluginId, companyA, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });
    await standings.setStanding(pluginId, companyB, {
      status: "grace",
      reason: "payment_failed",
      message: "Failed.",
    });
    return { companyA, companyB, pluginId };
  }

  it("instance-disable deletes all of the plugin's standing rows", async () => {
    const { pluginId } = await insertFixture();
    const lifecycle = pluginLifecycleManager(db);

    await lifecycle.disable(pluginId, "operator action");

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
  });

  it("uninstall (soft) deletes all of the plugin's standing rows", async () => {
    const { pluginId } = await insertFixture();
    const lifecycle = pluginLifecycleManager(db);

    await lifecycle.unload(pluginId, false);

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
  });

  it("company-disable deletes only that company's row for the plugin", async () => {
    const { companyA, companyB, pluginId } = await insertFixture();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanySettings(pluginId, companyA, {
      enabled: false,
      settingsJson: {},
    });

    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: companyB, pluginId });
  });

  it("company re-enable does not touch standing rows", async () => {
    const { companyA, pluginId } = await insertFixture();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanySettings(pluginId, companyA, {
      enabled: true,
      settingsJson: {},
    });

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(2);
  });
});
