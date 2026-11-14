import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("runtime connection tools token lifetime", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const { seed } = githubCredentialsFixture(() => db);

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-runtime-connection-tools-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-connection-tools-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  function app() {
    const server = express();
    server.use(express.json());
    server.use(runtimeConnectionIntentRoutes(db));
    server.use(errorHandler);
    return server;
  }

  function expiredConnectionToken(input: { agentId: string; companyId: string; runId: string }) {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000);
      return createRuntimeToolsToken({ ...input, responsibleUserId: "A" })!;
    } finally {
      vi.useRealTimers();
    }
  }

  it("keeps a connection tools token usable after its exp while the bound run is running", async () => {
    const input = await seed();
    await db.update(issues).set({ assigneeAgentId: input.agentId, status: "in_progress" })
      .where(eq(issues.id, input.issueId));
    const minted = expiredConnectionToken(input);
    expect(new Date(minted.expiresAt).getTime()).toBeLessThan(Date.now());

    const res = await request(app())
      .post("/runtime-tools/connections/search")
      .set("Authorization", `Bearer ${minted.token}`)
      .send({ query: "github" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ version: 1, query: "github", results: expect.any(Array) });
  });

  it("refuses the same token as soon as the bound run is no longer running", async () => {
    const input = await seed();
    await db.update(issues).set({ assigneeAgentId: input.agentId, status: "in_progress" })
      .where(eq(issues.id, input.issueId));
    const minted = expiredConnectionToken(input);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.runId));

    const res = await request(app())
      .post("/runtime-tools/connections/search")
      .set("Authorization", `Bearer ${minted.token}`)
      .send({ query: "github" });

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("Runtime tool token is no longer active");
  });
});
