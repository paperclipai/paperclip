import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent secret binding route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent update secret_ref env bindings", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-update-secret-routes-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-update-secret-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  function createApp(actor: Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function localBoardActor(companyId: string): Request["actor"] {
    return {
      type: "board",
      userId: "board-user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    };
  }

  it("accepts the UI update payload, syncs the binding, and exposes value-free usage metadata", async () => {
    const companyId = await seedCompany();
    const secret = await secretService(db).create(companyId, {
      name: `openai-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-live-agent-secret",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        model: "gpt-5.4-mini",
        promptTemplate: "Work the issue.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const app = createApp(localBoardActor(companyId));
    const updateRes = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          model: "gpt-5.4-mini",
          promptTemplate: "Work the issue.",
          env: {
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
            },
          },
        },
        replaceAdapterConfig: true,
      });

    expect(updateRes.status, JSON.stringify(updateRes.body)).toBe(200);

    const updated = await agentService(db).getById(agentId);
    expect(updated?.adapterConfig).toMatchObject({
      model: "gpt-5.4-mini",
      promptTemplate: "Work the issue.",
      env: {
        OPENAI_API_KEY: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      },
    });

    const usageRes = await request(app).get(`/api/secrets/${secret.id}/usage`);
    expect(usageRes.status, JSON.stringify(usageRes.body)).toBe(200);
    expect(usageRes.body).toMatchObject({
      secretId: secret.id,
      bindings: [
        {
          secretId: secret.id,
          targetType: "agent",
          targetId: agentId,
          configPath: "env.OPENAI_API_KEY",
          versionSelector: "latest",
          required: true,
          target: {
            type: "agent",
            id: agentId,
            label: "Builder",
            href: "/agents/builder",
            status: "idle",
          },
        },
      ],
    });
    expect(JSON.stringify(usageRes.body)).not.toContain("sk-live-agent-secret");
  });

  it("rejects malformed secret_ref env payloads before persistence", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Validator",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = createApp(localBoardActor(companyId));
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: "not-a-uuid",
              version: "latest",
            },
          },
        },
        replaceAdapterConfig: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe("Validation error");

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(bindings).toHaveLength(0);
  });

  it("rejects cross-company secret refs during update normalization", async () => {
    const companyId = await seedCompany("Paperclip");
    const foreignCompanyId = await seedCompany("Other Co");
    const foreignSecret = await secretService(db).create(foreignCompanyId, {
      name: `foreign-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-foreign-secret",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Boundary",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = createApp(localBoardActor(companyId));
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          env: {
            OPENAI_API_KEY: {
              type: "secret_ref",
              secretId: foreignSecret.id,
              version: "latest",
            },
          },
        },
        replaceAdapterConfig: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain("Secret must belong to same company");

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(bindings).toHaveLength(0);
  });
});
