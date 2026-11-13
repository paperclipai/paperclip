import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const adapters = [
  { name: "codex", adapterConfig: { provider: "codex", model: "gpt-5.6-sol" } },
  { name: "claude", adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5" } },
] as const;

describePostgres("volume-free agent configuration patch", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let fixtureNumber = 0;
  const userId = randomUUID();

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-volume-free-patch-")));
    database = await startEmbeddedPostgresTestDatabase("paperclip-volume-free-patch-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await database?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function serveAs(companyId: string) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    return app;
  }

  function useServerHome(generation: string) {
    vi.stubEnv("PAPERCLIP_HOME", path.join(home, generation));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
  }

  async function managedAgent(adapterConfig: Record<string, unknown>, generation: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Volume-free patch", issuePrefix: `VF${++fixtureNumber}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const root = path.join(home, generation, "instances", "default", "companies", companyId, "agents", agentId, "instructions");
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Volume-free agent", adapterType: "paperclip_runner",
      adapterConfig: { ...adapterConfig, instructionsBundleMode: "managed", instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md", instructionsFilePath: path.join(root, "AGENTS.md") } }).returning();
    return agent;
  }

  const readConfig = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0].adapterConfig;

  it.each(adapters)("changes one $name setting after a fresh-home restart and keeps managed instructions", async ({ adapterConfig }) => {
    const agent = await managedAgent(adapterConfig, "gen-1");
    useServerHome("gen-2");
    const response = await request(serveAs(agent.companyId)).patch(`/api/agents/${agent.id}`).send({ adapterConfig: { idleTimeoutMs: 301_001 } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await readConfig(agent.id);
    const currentRoot = path.join(home, "gen-2", "instances", "default", "companies", agent.companyId, "agents", agent.id, "instructions");
    expect(saved).toMatchObject({ ...adapterConfig, idleTimeoutMs: 301_001, instructionsBundleMode: "managed",
      instructionsRootPath: currentRoot, instructionsFilePath: path.join(currentRoot, "AGENTS.md") });
  });

  it.each(adapters)("changes one $name setting on the server that wrote the bundle", async ({ adapterConfig }) => {
    const agent = await managedAgent(adapterConfig, "gen-1");
    useServerHome("gen-1");
    const response = await request(serveAs(agent.companyId)).patch(`/api/agents/${agent.id}`).send({ adapterConfig: { idleTimeoutMs: 301_002 } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await readConfig(agent.id)).toMatchObject({ idleTimeoutMs: 301_002, instructionsBundleMode: "managed" });
  });

  it.each(adapters)("still refuses a real switch of a $name agent to external instructions", async ({ adapterConfig }) => {
    const agent = await managedAgent(adapterConfig, "gen-1");
    useServerHome("gen-2");
    const response = await request(serveAs(agent.companyId)).patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { instructionsFilePath: path.join(home, "outside", "AGENTS.md") } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toBe("Volume-free servers require managed agent instructions");
    expect((await readConfig(agent.id)).instructionsBundleMode).toBe("managed");
  });
});
