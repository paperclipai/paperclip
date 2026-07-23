import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyStanding, createDb, plugins } from "@paperclipai/db";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { companyStandingService } from "../services/company-standing.ts";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Mirrors the stub in plugin-orchestration-apis.test.ts:31-40, plus `clear`
// (required by `services.dispose()`, which this suite exercises unlike that
// file — see the working stub in plugin-access-authorization-host-services.test.ts:22-30).
function createEventBusStub(): PluginEventBus {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as unknown as PluginEventBus;
}

describeEmbeddedPostgres("host services company standing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-standing-host-services-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Host Services Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
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
    return { companyId, pluginId };
  }

  it("writes standing rows scoped to the host-injected pluginId", async () => {
    const { companyId, pluginId } = await insertFixture();
    const services = buildHostServices(db, pluginId, "paperclip.billing", createEventBusStub());

    await services.companies.setStanding({
      companyId,
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
      actionUrl: "/billing",
    });

    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      pluginId,
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Subscription lapsed.",
      actionUrl: "/billing",
    });

    const standings = companyStandingService(db);
    await expect(standings.getEffectiveStanding(companyId)).resolves.toMatchObject({
      status: "blocked",
      actionUrl: "/billing",
    });

    services.dispose();
  });

  it("clearStanding removes the plugin's row", async () => {
    const { companyId, pluginId } = await insertFixture();
    const services = buildHostServices(db, pluginId, "paperclip.billing", createEventBusStub());

    await services.companies.setStanding({
      companyId,
      status: "grace",
      reason: "payment_failed",
      message: "Payment failed.",
    });
    await services.companies.clearStanding({ companyId });

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
    services.dispose();
  });
});
