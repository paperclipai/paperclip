import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent env redaction route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent env redaction routes", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-env-redaction-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("redacts adapterConfig.env values from GET /api/agents/me", async () => {
    const [company] = await db.insert(companies).values({
      name: "Redact Co",
      issuePrefix: "RED",
    }).returning();

    const secretValue = "sk-live-secret-value";
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Redacted",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {
        command: "pnpm agent:run",
        token: "also-secret",
        env: {
          OPENAI_API_KEY: secretValue,
          ANTHROPIC_API_KEY: { type: "plain", value: secretValue },
          SECRET_REF: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    }).returning();

    const actor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company!.id,
      runId: null,
      source: "agent_key",
    };

    const res = await request(createApp(actor)).get("/api/agents/me");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig.env).toEqual({
      OPENAI_API_KEY: { type: "plain", configured: true },
      ANTHROPIC_API_KEY: { type: "plain", configured: true },
      SECRET_REF: { type: "secret_ref", configured: true },
    });
    expect(res.body.adapterConfig.token).toBe("also-secret");
    expect(JSON.stringify(res.body)).not.toContain(secretValue);
    expect(JSON.stringify(res.body)).not.toContain("11111111-1111-1111-1111-111111111111");
  });
});
