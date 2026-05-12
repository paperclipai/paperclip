import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { issueRoutes } from "./issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CEO chat endpoint tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /companies/:companyId/ceo-chat", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ceo-chat-routes-");
    db = createDb(tempDb.connectionString);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "board",
        source: "local_implicit",
        userId: "test-user",
        companyIds: [],
        isInstanceAdmin: true,
        memberships: [],
      };
      next();
    });
    app.use("/api", issueRoutes(db, null as never));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = (err as { status?: number }).status ?? 500;
      const message = (err as { message?: string }).message ?? "error";
      res.status(status).json({ error: message });
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndCeo() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Test Company ${companyId}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const ceoId = randomUUID();
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO Agent",
      role: "ceo",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, ceoId };
  }

  it("returns the CEO chat issue when the company has a CEO", async () => {
    const { companyId, ceoId } = await seedCompanyAndCeo();

    const res = await request(app).get(`/api/companies/${companyId}/ceo-chat`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId,
      assigneeAgentId: ceoId,
      isCeoChat: true,
      status: "in_progress",
      title: "CEO Chat",
    });
    expect(res.body.issueId).toBeTruthy();
  });

  it("returns 404 when the company has no CEO", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Test Company ${companyId}`,
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const res = await request(app).get(`/api/companies/${companyId}/ceo-chat`);

    expect(res.status).toBe(404);
  });

  it("re-seeds the chat issue if a CEO exists but the row was deleted", async () => {
    const { companyId, ceoId } = await seedCompanyAndCeo();

    const first = await request(app).get(`/api/companies/${companyId}/ceo-chat`);
    expect(first.status).toBe(200);

    await db
      .delete(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.isCeoChat, true)));

    const second = await request(app).get(`/api/companies/${companyId}/ceo-chat`);
    expect(second.status).toBe(200);
    expect(second.body.assigneeAgentId).toBe(ceoId);
    expect(second.body.issueId).not.toBe(first.body.issueId);
  });
});
