import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, plugins } from "@paperclipai/db";
import { buildHostServices, listPluginIssuesPage } from "../services/plugin-host-services.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describe("plugin issue page boundary", () => {
  it("returns the service page without applying offset a second time", async () => {
    const list = async (_companyId: string, params: unknown) => {
      expect(params).toMatchObject({ limit: 1, offset: 1 });
      return [{ id: "second-row" }];
    };

    await expect(
      listPluginIssuesPage(list, "company", { limit: 1, offset: 1 }),
    ).resolves.toEqual([{ id: "second-row" }]);
  });
});

describeEmbeddedPostgres("plugin issues pagination", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let pluginId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-issues-page-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plugin issue pagination",
      issuePrefix: "PIP",
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.issue-pagination-test",
      packageName: "@paperclipai/plugin-issue-pagination-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.issue-pagination-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Issue Pagination Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["issues.read"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    const service = issueService(db);
    await service.create(companyId, { title: "First", status: "backlog" });
    await service.create(companyId, { title: "Second", status: "backlog" });
    await service.create(companyId, { title: "Third", status: "backlog" });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies limit and offset exactly once", async () => {
    const host = buildHostServices(db, pluginId, "issue-pagination-test", {
      forPlugin: () => ({ emit() {}, subscribe() {}, clear() {} }),
    } as never);

    const first = await host.issues.list({ companyId, limit: 1, offset: 0 });
    const second = await host.issues.list({ companyId, limit: 1, offset: 1 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(first[0]?.id);
  });
});
