import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, issues, type Db, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { computerRoutes } from "../routes/computers.js";
import type { computerService } from "../modules/computers/index.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const settings = vi.hoisted(() => ({ get: vi.fn(), getExperimental: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => settings }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping computer route database tests: ${support.reason}`);
describe.skipIf(!support.supported)("task computer environment selection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-computer-routes");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(() => {
    settings.get.mockResolvedValue({ defaultEnvironmentId: null });
    settings.getExperimental.mockResolvedValue({ enableBoatEnvironments: true });
  });

  async function fixture(driver = "computer") {
    const [company] = await db.insert(companies).values({ name: "Computer routes", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [oldEnvironment] = await db.insert(environments).values({ name: randomUUID(), driver: "computer", metadata: { computerCompanyId: company.id } }).returning();
    const [created] = await db.insert(environments).values({ name: randomUUID(), driver, metadata: driver === "computer" ? { computerCompanyId: company.id } : {} }).onConflictDoNothing().returning();
    const selected = created ?? (await db.select().from(environments).where(eq(environments.driver, "local")))[0]!;
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Assigned", adapterType: "process", defaultEnvironmentId: selected.id }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Moved task", assigneeAgentId: agent.id }).returning();
    const owner = { computerId: randomUUID(), ownerId: randomUUID(), generation: 1 };
    await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id, environmentId: oldEnvironment.id,
      provider: "boat", status: "released", providerLeaseId: owner.ownerId, metadata: { computerOwner: owner } });
    const computers = { connect: vi.fn(async () => ({ owner })), renewViewer: vi.fn(), disconnectViewer: vi.fn(), preview: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
    app.use("/api", computerRoutes(db, computers as unknown as ReturnType<typeof computerService>));
    app.use(errorHandler);
    return { app, company, issue, agent, oldEnvironment, selected, owner, computers, base: `/api/issues/${issue.id}/computer` };
  }

  it.each(["local", "ssh", "sandbox"])("hides the old Boat after selecting %s and refuses reconnect", async (driver) => {
    const f = await fixture(driver);
    await db.insert(environmentLeases).values({ companyId: f.company.id, issueId: f.issue.id, environmentId: f.selected.id, provider: driver, status: "released" });
    expect((await request(f.app).get(f.base)).body).toBeNull();
    expect((await request(f.app).post(`${f.base}/connect`).send({ environmentId: f.oldEnvironment.id })).status).toBe(404);
    expect(f.computers.connect).not.toHaveBeenCalled();
  });

  it("selects Boat B before its first run and cannot preview Boat A's lease", async () => {
    const f = await fixture();
    expect((await request(f.app).get(f.base)).body).toEqual({ environmentId: f.selected.id, name: f.selected.name });
    expect((await request(f.app).post(`${f.base}/connect`).send({ environmentId: f.oldEnvironment.id })).status).toBe(404);
    expect((await request(f.app).post(`${f.base}/connect`).send({ environmentId: f.selected.id })).status).toBe(200);
    expect(f.computers.connect).toHaveBeenCalledWith(expect.objectContaining({ companyId: f.company.id, environmentId: f.selected.id }));
    expect((await request(f.app).post(`${f.base}/preview`).send({ environmentId: f.selected.id, port: 5173 })).status).toBe(409);
    expect(f.computers.preview).not.toHaveBeenCalled();
  });

  it("uses the current instance default when the agent has no selection", async () => {
    const f = await fixture();
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agent.id));
    settings.get.mockResolvedValue({ defaultEnvironmentId: f.selected.id });
    expect((await request(f.app).get(f.base)).body).toEqual({ environmentId: f.selected.id, name: f.selected.name });
  });

  it("previews only the current environment's lease, even when an old computer's lease is newer", async () => {
    const f = await fixture();
    const owner = { computerId: randomUUID(), ownerId: randomUUID(), generation: 2 };
    await db.insert(environmentLeases).values({ companyId: f.company.id, issueId: f.issue.id, environmentId: f.selected.id,
      provider: "boat", providerLeaseId: owner.ownerId, metadata: { computerOwner: owner }, createdAt: new Date(0) });
    f.computers.preview.mockResolvedValue({ url: "https://example.test/preview" });
    expect((await request(f.app).post(`${f.base}/preview`).send({ environmentId: f.selected.id, port: 5173 })).status).toBe(200);
    expect(f.computers.preview).toHaveBeenCalledWith({ companyId: f.company.id, environmentId: f.selected.id, owner, port: 5173 });
  });

  it("hides historical Boat leases when both current defaults select local implicitly", async () => {
    const f = await fixture();
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agent.id));
    expect((await request(f.app).get(f.base)).body).toBeNull();
  });

  it("keeps disconnect scoped to the posted former owner after reassignment and feature disable", async () => {
    const f = await fixture("ssh");
    settings.getExperimental.mockResolvedValue({ enableBoatEnvironments: false });
    expect((await request(f.app).post(`${f.base}/disconnect`).send({ environmentId: f.oldEnvironment.id, owner: f.owner })).status).toBe(204);
    expect(f.computers.disconnectViewer).toHaveBeenCalledWith({ companyId: f.company.id, environmentId: f.oldEnvironment.id, owner: f.owner, userId: "board" });
    expect(f.computers.connect).not.toHaveBeenCalled();
  });
});
