import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { typesafeRoutes } from "../routes/typesafe.js";
import { toolAccessService } from "../services/tool-access.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const KEY = "ts-route-test-key";
const ANSWER = {
  model: "jev-1.13.0",
  answers: { urgent: { type: "noul", noul: 0.91 } },
  usage: { input_tokens: 40, output_tokens: 3 },
};
const BODY = {
  state: "private-route-state",
  questions: { urgent: { type: "noul", instructions: "Urgent?" } },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describeEmbeddedPostgres("TypeSafe routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-typesafe-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const provider = () =>
    vi.fn(async (url: unknown, _init?: RequestInit) =>
      String(url).endsWith("/models") ? json({ models: [{ name: "jev-latest" }] }) : json(ANSWER),
    );

  async function fixture(install: boolean) {
    const [company] = await db
      .insert(companies)
      .values({
        name: `TypeSafe ${randomUUID()}`,
        issuePrefix: `TR${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    if (install) {
      const service = toolAccessService(db, { typesafeFetch: provider() as unknown as typeof fetch });
      const { connectionId } = await service.connectGalleryApp(
        company!.id,
        {
          galleryKey: "typesafe",
          connectionMethodKey: "api-key",
          credentialValues: { "credentials.apiKey": KEY },
        },
        { actorType: "user", actorId: "board" },
      );
      await service.finishGalleryAppConnection(
        company!.id,
        connectionId,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" },
        { actorType: "user", actorId: "board" },
      );
    }
    return { companyId: company!.id, agentId: agent!.id };
  }

  function appFor(actor: Record<string, unknown>, fetcher = provider()) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", typesafeRoutes(db, fetcher as unknown as typeof fetch));
    app.use(errorHandler);
    return { app, fetcher };
  }
  const agentActor = (companyId: string, agentId: string, runId?: string) => ({
    type: "agent",
    companyId,
    agentId,
    ...(runId ? { runId } : {}),
  });

  it("answers an agent that has the connection", async () => {
    const { companyId, agentId } = await fixture(true);
    const { app } = appFor(agentActor(companyId, agentId));
    const res = await request(app).post(`/api/companies/${companyId}/typesafe/ask`).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ANSWER);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it("records the run on the activity row", async () => {
    const { companyId, agentId } = await fixture(true);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, invocationSource: "assignment", status: "running", contextSnapshot: {} })
      .returning();
    const { app } = appFor(agentActor(companyId, agentId, run!.id));
    await request(app).post(`/api/companies/${companyId}/typesafe/ask`).send(BODY).expect(200);
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "typesafe.ask")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: run!.id, agentId });
    expect(JSON.stringify(rows[0])).not.toContain("private-route-state");
  });

  it("refuses an agent without the connection", async () => {
    const { companyId, agentId } = await fixture(false);
    const { app, fetcher } = appFor(agentActor(companyId, agentId));
    const res = await request(app).post(`/api/companies/${companyId}/typesafe/ask`).send(BODY);
    expect(res.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses an agent key from another company", async () => {
    const owner = await fixture(true);
    const other = await fixture(false);
    const { app, fetcher } = appFor(agentActor(other.companyId, other.agentId));
    const res = await request(app).post(`/api/companies/${owner.companyId}/typesafe/ask`).send(BODY);
    expect(res.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a board user", async () => {
    const { companyId } = await fixture(true);
    const { app, fetcher } = appFor({ type: "board", source: "local_implicit", userId: "board" });
    const res = await request(app).post(`/api/companies/${companyId}/typesafe/ask`).send(BODY);
    expect(res.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const { companyId, agentId } = await fixture(true);
    const { app, fetcher } = appFor(agentActor(companyId, agentId));
    const res = await request(app)
      .post(`/api/companies/${companyId}/typesafe/ask`)
      .send({ state: "s", questions: { q: { type: "score", instructions: "?", criteria: ["only"] } } });
    expect(res.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
