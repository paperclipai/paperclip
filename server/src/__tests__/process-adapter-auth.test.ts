import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { processAdapter } from "../adapters/process/index.js";
import { createLocalAgentJwt, ensureLocalTrustedAgentJwtSecret } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres process adapter auth route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("process adapter Paperclip auth env", () => {
  it("opts into local agent JWT support and injects run-scoped auth env", async () => {
    const metaEvents: Array<Record<string, unknown>> = [];

    const result = await processAdapter.execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Fixture Process Agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {},
      config: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({apiKey: process.env.PAPERCLIP_API_KEY, runId: process.env.PAPERCLIP_RUN_ID}))",
        ],
      },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => { metaEvents.push(meta as unknown as Record<string, unknown>); },
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.resultJson?.stdout).trim())).toEqual({
      apiKey: "agent-run-jwt",
      runId: "run-123",
    });
    expect(metaEvents[0]?.env).toMatchObject({
      PAPERCLIP_API_KEY: "***REDACTED***",
      PAPERCLIP_RUN_ID: "run-123",
    });
  });

  it("preserves an explicit process PAPERCLIP_API_KEY but refreshes PAPERCLIP_RUN_ID", async () => {
    const result = await processAdapter.execute({
      runId: "run-fresh",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Fixture Process Agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {},
      config: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({apiKey: process.env.PAPERCLIP_API_KEY, runId: process.env.PAPERCLIP_RUN_ID}))",
        ],
        env: { PAPERCLIP_API_KEY: "explicit-key", PAPERCLIP_RUN_ID: "stale-run" },
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "agent-run-jwt",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.resultJson?.stdout).trim())).toEqual({
      apiKey: "explicit-key",
      runId: "run-fresh",
    });
  });
});

describeEmbeddedPostgres("process adapter local JWT route acceptance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldAgentJwtSecret: string | undefined;
  let oldBetterAuthSecret: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-process-adapter-auth-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    oldAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    oldBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
  });

  afterEach(async () => {
    if (oldAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldAgentJwtSecret;
    if (oldBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = oldBetterAuthSecret;
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("mints startup local auth and lets a process child self-read /api/agents/me", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Auth Fixture Co",
      issuePrefix: `AF${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fixture Process Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    });

    ensureLocalTrustedAgentJwtSecret();
    const authToken = createLocalAgentJwt(agentId, companyId, "process", runId);
    expect(authToken).toEqual(expect.any(String));

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const server = await listen(app);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind to a local TCP port");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const result = await processAdapter.execute({
        runId,
        agent: {
          id: agentId,
          companyId,
          name: "Fixture Process Agent",
          role: "engineer",
          adapterType: "process",
          adapterConfig: {},
        },
        runtime: {},
        config: {
          command: process.execPath,
          args: [
            "-e",
            `
              const res = await fetch(process.env.PAPERCLIP_API_URL + "/api/agents/me", {
                headers: {
                  Authorization: "Bearer " + process.env.PAPERCLIP_API_KEY,
                  "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID,
                },
              });
              const body = await res.json().catch(() => ({}));
              console.log(JSON.stringify({ status: res.status, id: body.id, adapterType: body.adapterType }));
              if (res.status !== 200) process.exit(1);
            `,
          ],
          env: { PAPERCLIP_API_URL: apiUrl },
        },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
        onSpawn: async () => {},
        authToken: authToken ?? undefined,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(String(result.resultJson?.stdout).trim())).toEqual({
        status: 200,
        id: agentId,
        adapterType: "process",
      });
    } finally {
      await close(server);
    }
  });
});

function listen(app: express.Express): Promise<Server> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
