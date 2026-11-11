import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyUserUiLayouts, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { uiLayoutService } from "../services/ui-layouts.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("ui layout service", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyA: string;
  let companyB: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("ui-layouts-service-");
    db = createDb(database.connectionString);
    const rows = await db
      .insert(companies)
      .values([
        { name: "Layout Co A", issuePrefix: "LCA" },
        { name: "Layout Co B", issuePrefix: "LCB" },
      ])
      .returning();
    companyA = rows[0]!.id;
    companyB = rows[1]!.id;
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("returns an empty preference before anything is saved", async () => {
    const svc = uiLayoutService(db);
    expect(await svc.get(companyA, "user-1", "dashboard")).toEqual({
      surface: "dashboard",
      schemaVersion: null,
      layout: null,
      updatedAt: null,
    });
  });

  it("upserts one row per company, user and surface", async () => {
    const svc = uiLayoutService(db);
    const first = await svc.upsert(companyA, "user-1", "dashboard", { layout: { schemaVersion: 1, widgets: [] }, schemaVersion: 1 });
    const { preference: second, created: secondCreated } = await svc.upsert(companyA, "user-1", "dashboard", {
      layout: { schemaVersion: 1, widgets: [{ instanceId: "a" }] },
      schemaVersion: 1,
    });
    await svc.upsert(companyA, "user-1", "agent_graph", { layout: { schemaVersion: 1, direction: "LR" }, schemaVersion: 1 });

    expect(first.created).toBe(true);
    expect(secondCreated).toBe(false);
    expect(second.layout).toEqual({ schemaVersion: 1, widgets: [{ instanceId: "a" }] });
    expect(second.updatedAt).toBeInstanceOf(Date);
    const rows = await db.select().from(companyUserUiLayouts).where(eq(companyUserUiLayouts.companyId, companyA));
    expect(rows.map((row) => row.surface).sort()).toEqual(["agent_graph", "dashboard"]);
  });

  it("keeps layouts isolated between users and companies", async () => {
    const svc = uiLayoutService(db);
    await svc.upsert(companyA, "user-2", "dashboard", { layout: { schemaVersion: 1, widgets: [], owner: "user-2" }, schemaVersion: 1 });
    await svc.upsert(companyB, "user-1", "dashboard", { layout: { schemaVersion: 1, widgets: [], owner: "company-b" }, schemaVersion: 1 });

    expect((await svc.get(companyA, "user-1", "dashboard")).layout).toEqual({ schemaVersion: 1, widgets: [{ instanceId: "a" }] });
    expect((await svc.get(companyA, "user-2", "dashboard")).layout).toMatchObject({ owner: "user-2" });
    expect((await svc.get(companyB, "user-1", "dashboard")).layout).toMatchObject({ owner: "company-b" });
  });

  it("removes only the caller's surface and cascades with the company", async () => {
    const svc = uiLayoutService(db);
    expect((await svc.remove(companyA, "user-1", "dashboard")).removed).toBe(true);
    expect((await svc.remove(companyA, "user-1", "dashboard")).removed).toBe(false);
    expect((await svc.get(companyA, "user-1", "dashboard")).layout).toBeNull();
    const again = await svc.upsert(companyA, "user-1", "dashboard", { layout: { schemaVersion: 1, widgets: [] }, schemaVersion: 1 });
    expect(again.created).toBe(true);
    expect((await svc.remove(companyA, "user-1", "dashboard")).removed).toBe(true);
    expect((await svc.get(companyA, "user-1", "agent_graph")).layout).not.toBeNull();
    expect((await svc.get(companyA, "user-2", "dashboard")).layout).not.toBeNull();

    await db.delete(companies).where(eq(companies.id, companyB));
    expect(await db.select().from(companyUserUiLayouts).where(eq(companyUserUiLayouts.companyId, companyB))).toEqual([]);
  });
});
