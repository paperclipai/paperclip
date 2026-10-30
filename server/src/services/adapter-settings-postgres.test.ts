import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, applyPendingMigrations, companies, createDb, instanceSettings, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";

const legacy = vi.hoisted(() => ({ get: vi.fn(() => [] as string[]), set: vi.fn() }));
vi.mock("./adapter-plugin-store.js", () => ({
  getDisabledAdapterTypes: legacy.get,
  setAdapterDisabled: legacy.set,
  listAdapterPlugins: () => [],
  getAdapterPluginByType: () => undefined,
}));
vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: () => [{ type: "codex_local" }, { type: "claude_local" }, { type: "paperclip_runner" }],
  findServerAdapter: (type: string) => ({ type }),
  findActiveServerAdapter: (type: string) => ({ type }),
  isOverridePaused: () => false,
  hasActiveAdapterOverride: () => false,
  waitForExternalAdapters: async () => {},
}));
vi.mock("../adapters/plugin-loader.js", () => ({}));
import { adapterSettingsService, initializeAdapterSettings } from "./adapter-settings.js";
import { adapterRoutes } from "../routes/adapters.js";
import { errorHandler } from "../middleware/error-handler.js";
import { resolveNewAgentRunnerForCompany } from "./agent-runner-selection.js";
import * as activities from "./activity-log.js";

const externalDatabaseUrl = process.env.PAPERCLIP_ADAPTER_SETTINGS_TEST_DATABASE_URL;
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable managed adapter settings", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let peer: Db;
  let directory: string;
  const managed = { runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "synthetic-test-token" } };
  const service = () => adapterSettingsService(db, managed);

  beforeAll(async () => {
    database = externalDatabaseUrl
      ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("adapter-settings-");
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    db = createDb(database.connectionString);
    peer = createDb(database.connectionString);
    await db.insert(companies).values({ name: "Adapter settings test", issuePrefix: "AST" });
  }, 90_000);
  afterAll(async () => {
    await Promise.all([db?.$client.end({ timeout: 0 }), peer?.$client.end({ timeout: 0 })]);
    await database?.cleanup();
  }, 60_000);
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "adapter-settings-import-"));
    await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "adapter-settings:v1"));
    legacy.get.mockClear();
    legacy.set.mockClear();
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "synthetic-test-token");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function app() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
      next();
    });
    app.use(adapterRoutes({ db }));
    app.use(errorHandler);
    return app;
  }

  it("persists across independent connections and reconstructed stores without file reads", async () => {
    await expect(service().getDisabledTypes()).rejects.toThrow("not been initialized");
    await service().seedIfAbsent({ disabledTypes: [] });
    expect(await service().setDisabled("codex_local", true)).toBe(true);
    expect(await adapterSettingsService(peer, managed).getDisabledTypes()).toEqual(["codex_local"]);
    await db.$client.end({ timeout: 0 });
    db = createDb(database.connectionString);
    expect(await service().inspectStored()).toEqual({ version: 1, revision: 1, disabledTypes: ["codex_local"] });
    expect(legacy.get).not.toHaveBeenCalled();
    expect(legacy.set).not.toHaveBeenCalled();
  });

  it("acknowledges the committed save when its live activity event fails", async () => {
    await service().seedIfAbsent({ disabledTypes: [] });
    const publication = vi.spyOn(activities, "publishActivity").mockImplementation(() => { throw new Error("event unavailable"); });
    const response = await request(app()).patch("/adapters/codex_local").send({ disabled: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(publication).toHaveBeenCalled();
    expect(await adapterSettingsService(peer, managed).getDisabledTypes()).toEqual(["codex_local"]);
    const events = await peer.select().from(activityLog).where(eq(activityLog.action, "instance.adapter.updated"));
    expect(events.some((event) => event.details?.adapterType === "codex_local")).toBe(true);
  });

  it("preserves simultaneous first writes and concurrent removals from other connections", async () => {
    const writers = [service(), adapterSettingsService(peer, managed)];
    await Promise.all(Array.from({ length: 12 }, (_, index) => writers[index % 2].setDisabled(`adapter_${index}`, true)));
    expect((await service().inspectStored())?.disabledTypes).toHaveLength(12);
    await Promise.all([
      writers[0].setDisabled("adapter_0", false),
      writers[1].setDisabled("adapter_1", false),
      writers[0].setDisabled("extra", true),
    ]);
    const stored = await service().inspectStored();
    expect(stored?.revision).toBe(15);
    expect(stored?.disabledTypes).not.toContain("adapter_0");
    expect(stored?.disabledTypes).not.toContain("adapter_1");
    expect(stored?.disabledTypes).toContain("extra");
    expect(await writers[1].setDisabled("extra", true)).toBe(false);
    expect((await service().inspectStored())?.revision).toBe(15);
  });

  it("imports legacy choices once before admission and ignores stale files after the DB record exists", async () => {
    const runtimeEnv = { ...managed.runtimeEnv, PAPERCLIP_HOME: directory };
    const file = path.join(directory, "adapter-settings.json");
    await fs.writeFile(file, JSON.stringify({ disabledTypes: ["codex_local", "future_adapter"] }));
    const results = await Promise.all([
      initializeAdapterSettings(db, { runtimeEnv }),
      initializeAdapterSettings(peer, { runtimeEnv }),
    ]);
    expect(results.filter((result) => result?.seeded)).toHaveLength(1);
    expect(await service().getDisabledTypes()).toEqual(["codex_local", "future_adapter"]);
    await service().setDisabled("codex_local", false);
    await fs.writeFile(file, "invalid stale JSON");
    expect((await initializeAdapterSettings(peer, { runtimeEnv }))?.seeded).toBe(false);
    expect(await service().getDisabledTypes()).toEqual(["future_adapter"]);
  });

  it("uses defaults only for an absent legacy file and rejects malformed or oversized input", async () => {
    const runtimeEnv = { ...managed.runtimeEnv, PAPERCLIP_HOME: directory };
    const file = path.join(directory, "adapter-settings.json");
    await fs.writeFile(file, JSON.stringify({ disabledTypes: [42] }));
    await expect(initializeAdapterSettings(db, { runtimeEnv })).rejects.toThrow("Persisted adapter settings are invalid");
    expect(await service().inspectStored()).toBeNull();
    await fs.writeFile(file, Buffer.alloc(65_537));
    await expect(initializeAdapterSettings(db, { runtimeEnv })).rejects.toThrow("size limit");
    expect(await service().inspectStored()).toBeNull();
    await fs.unlink(file);
    expect((await initializeAdapterSettings(db, { runtimeEnv }))?.current.disabledTypes).toEqual([]);
    expect(await service().getDisabledTypes()).toEqual([]);
  });

  it("composes atomic import and receipts with the caller transaction", async () => {
    await expect(db.transaction(async (tx) => {
      expect(await service().seedIfAbsent({ disabledTypes: ["codex_local"] }, tx)).toEqual({
        seeded: true, current: { version: 1, revision: 0, disabledTypes: ["codex_local"] },
      });
      throw new Error("receipt failed");
    })).rejects.toThrow("receipt failed");
    expect(await service().inspectStored()).toBeNull();
    await Promise.all([
      service().seedIfAbsent({ disabledTypes: ["codex_local"] }),
      adapterSettingsService(peer, managed).seedIfAbsent({ disabledTypes: ["claude_local"] }),
    ]).then((results) => {
      expect(results.filter((result) => result.seeded)).toHaveLength(1);
      expect(results[0].current).toEqual(results[1].current);
    });
  });

  it("applies operator restrictions without rewriting saved choices", async () => {
    await service().setDisabled("codex_local", true);
    const env = { ...managed.runtimeEnv, PAPERCLIP_ADAPTERS: JSON.stringify([{ adapterType: "codex_local", enabled: true }]) };
    const overlay = adapterSettingsService(peer, { runtimeEnv: env });
    expect(await overlay.getDisabledTypes()).toEqual(["claude_local", "paperclip_runner"]);
    expect(await overlay.inspectStored()).toEqual(await service().inspectStored());
    await expect(overlay.setDisabled("claude_local", false)).rejects.toThrow("hosting operator");
    await expect(overlay.setDisabled("codex_local", true)).rejects.toThrow("hosting operator");
    expect(await overlay.getDisabledTypes()).toEqual(["claude_local", "paperclip_runner"]);
    expect(await service().getDisabledTypes()).toEqual(["codex_local"]);
  });

  it("refreshes the disabled harness at each new-agent admission", async () => {
    await service().seedIfAbsent({ disabledTypes: [] });
    const input = { adapterType: "codex_local", runner: "legacy" as const };
    expect((await resolveNewAgentRunnerForCompany(db, "company", input)).adapterType).toBe("codex_local");
    await adapterSettingsService(peer, managed).setDisabled("codex_local", true);
    await expect(resolveNewAgentRunnerForCompany(db, "company", input)).rejects.toMatchObject({ status: 422, details: { code: "agent_runner_unavailable" } });
    await adapterSettingsService(peer, managed).setDisabled("codex_local", false);
    expect((await resolveNewAgentRunnerForCompany(db, "company", input)).adapterType).toBe("codex_local");
  });

  it("rolls back the setting when its audit write fails", async () => {
    await expect(service().setDisabled("codex_local", true, async () => { throw new Error("audit failed"); })).rejects.toThrow("audit failed");
    expect(await service().inspectStored()).toBeNull();
    await expect(adapterSettingsService(peer, managed).getDisabledTypes()).rejects.toThrow("not been initialized");
  });

  it("publishes catalog changes across stores and records the instance mutation", async () => {
    const res = await request(app()).patch("/adapters/codex_local").send({ disabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "codex_local", disabled: true, changed: true });
    const catalog = await request(app()).get("/adapters");
    expect(catalog.status).toBe(200);
    expect(catalog.body.find((entry: { type: string }) => entry.type === "codex_local").disabled).toBe(true);
    const [audit] = await peer.select().from(activityLog).where(eq(activityLog.action, "instance.adapter.updated"));
    expect(audit.details).toMatchObject({ adapterType: "codex_local", disabled: true, revision: 1 });
  });

  it("returns failure when PostgreSQL rejects the update and keeps the durable choice", async () => {
    await service().seedIfAbsent({ disabledTypes: [] });
    await db.execute(sql`CREATE FUNCTION reject_adapter_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test adapter settings failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_adapter_settings BEFORE UPDATE ON instance_settings FOR EACH ROW EXECUTE FUNCTION reject_adapter_settings()`);
    try {
      const res = await request(app()).patch("/adapters/codex_local").send({ disabled: true });
      expect(res.status).toBe(500);
      expect(await adapterSettingsService(peer, managed).getDisabledTypes()).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER reject_adapter_settings ON instance_settings`);
      await db.execute(sql`DROP FUNCTION reject_adapter_settings()`);
    }
  });

  it("fails closed on malformed stored settings and unavailable database", async () => {
    await db.insert(instanceSettings).values({ singletonKey: "adapter-settings:v1", general: { version: 2, disabledTypes: [] } });
    await expect(service().getDisabledTypes()).rejects.toThrow("Persisted adapter settings are invalid");
    await expect(adapterSettingsService(undefined, managed).getDisabledTypes()).rejects.toThrow("database is required");
    expect(legacy.get).not.toHaveBeenCalled();
  });
});
