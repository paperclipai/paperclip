import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin UI contribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function manifest(id: string, displayName: string): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "1.0.0",
    displayName,
    description: `${displayName} test plugin`,
    author: "Paperclip",
    categories: ["ui"],
    capabilities: ["ui.dashboardWidget.register"],
    entrypoints: {
      ui: "./dist/ui",
    },
    ui: {
      slots: [
        {
          type: "dashboardWidget",
          id: `${id}-widget`,
          displayName,
          exportName: "DashboardWidget",
        },
      ],
    },
  };
}

function createApp(db: ReturnType<typeof createDb>, actorCompanyIds: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: actorCompanyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", pluginRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("plugin UI contribution routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-ui-contributions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("filters ready dashboard widgets by explicit company disable overrides", async () => {
    const companyId = randomUUID();
    const visiblePluginId = randomUUID();
    const disabledPluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });
    await db.insert(plugins).values([
      {
        id: visiblePluginId,
        pluginKey: "test.visible-dashboard",
        packageName: "@test/visible-dashboard",
        version: "1.0.0",
        apiVersion: 1,
        categories: ["ui"],
        manifestJson: manifest("test.visible-dashboard", "Visible Dashboard"),
        status: "ready",
        installOrder: 1,
      },
      {
        id: disabledPluginId,
        pluginKey: "test.disabled-dashboard",
        packageName: "@test/disabled-dashboard",
        version: "1.0.0",
        apiVersion: 1,
        categories: ["ui"],
        manifestJson: manifest("test.disabled-dashboard", "Disabled Dashboard"),
        status: "ready",
        installOrder: 2,
      },
    ]);
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId: disabledPluginId,
      enabled: false,
      settingsJson: {},
    });

    const res = await request(createApp(db, [companyId]))
      .get("/api/plugins/ui-contributions")
      .query({ companyId });

    expect(res.status).toBe(200);
    expect(res.body.map((row: { pluginKey: string }) => row.pluginKey)).toEqual([
      "test.visible-dashboard",
    ]);
    expect(res.body[0].slots[0]).toMatchObject({
      type: "dashboardWidget",
      exportName: "DashboardWidget",
    });
  });

  it("enforces board company access for scoped contribution discovery", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme" });

    const res = await request(createApp(db, []))
      .get("/api/plugins/ui-contributions")
      .query({ companyId });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });
});
