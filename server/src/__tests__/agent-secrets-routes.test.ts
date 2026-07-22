import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  secretAccessEvents,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, type AgentApiKeyScope } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent secret routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-secret-routes-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedAgentRun(permissions: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent secret routes",
      issuePrefix: `S${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Secret reader",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions,
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
    return { companyId, agentId, heartbeatRunId };
  }

  function createApp(
    fixture: Awaited<ReturnType<typeof seedAgentRun>>,
    keyScope: AgentApiKeyScope = { kind: "standard" },
    source: "agent_jwt" | "agent_key" = "agent_jwt",
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        keyScope,
        keyId: source === "agent_key" ? randomUUID() : undefined,
        source,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("lists metadata only, reads env and access grants, and audits success and failure", async () => {
    const fixture = await seedAgentRun();
    const svc = secretService(db);
    const envSecret = await svc.create(fixture.companyId, {
      key: "ENV_ONLY_KEY",
      name: "Env only",
      description: "Injected and API-readable",
      provider: "local_encrypted",
      value: "env-secret-value",
    });
    const apiSecret = await svc.create(fixture.companyId, {
      key: "API_ONLY_KEY",
      name: "API only",
      provider: "local_encrypted",
      value: "api-secret-value",
    });
    const unboundSecret = await svc.create(fixture.companyId, {
      key: "UNBOUND_KEY",
      name: "Unbound",
      provider: "local_encrypted",
      value: "unbound-secret-value",
    });
    const projectSecret = await svc.create(fixture.companyId, {
      key: "PROJECT_KEY",
      name: "Project layer",
      provider: "local_encrypted",
      value: "project-secret-value",
    });
    await svc.createBinding({
      companyId: fixture.companyId,
      secretId: envSecret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: "env.ENV_ONLY_KEY",
    });
    await svc.createBinding({
      companyId: fixture.companyId,
      secretId: apiSecret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: "access.API_ONLY_KEY",
      projectionClass: "class_2_runtime_only",
    });
    const projectBinding = await svc.createBinding({
      companyId: fixture.companyId,
      secretId: projectSecret.id,
      targetType: "project",
      targetId: randomUUID(),
      configPath: "env.PROJECT_KEY",
    });
    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        paperclipSecrets: {
          manifest: [{
            bindingId: projectBinding.id,
            secretId: projectSecret.id,
            configPath: projectBinding.configPath,
          }],
        },
      },
    }).where(eq(heartbeatRuns.id, fixture.heartbeatRunId));

    const list = await request(createApp(fixture)).get("/api/agents/me/secrets");
    expect(list.status).toBe(200);
    expect(list.body.secrets).toEqual([
      expect.objectContaining({ key: "api_only_key", delivery: "api", projectionClass: "class_2_runtime_only" }),
      expect.objectContaining({ key: "env_only_key", delivery: "env" }),
      expect.objectContaining({ key: "project_key", delivery: "env" }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain("secret-value");
    expect(await db.select().from(secretAccessEvents)).toEqual([]);
    expect(await db.select().from(activityLog)).toEqual([
      expect.objectContaining({ action: "secret.access.listed", runId: fixture.heartbeatRunId }),
    ]);

    const fetched = await request(createApp(fixture)).post("/api/agents/me/secrets/env_only_key/value");
    expect(fetched.status).toBe(200);
    expect(fetched.headers["cache-control"]).toBe("no-store");
    expect(fetched.body).toEqual({ key: "env_only_key", value: "env-secret-value", version: 1 });
    expect(await db.select().from(secretAccessEvents)).toEqual([
      expect.objectContaining({ secretId: envSecret.id, outcome: "success", consumerType: "agent_api" }),
    ]);
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "secret.value.read", entityId: envSecret.id }),
    ]));

    const projectFetched = await request(createApp(fixture)).post("/api/agents/me/secrets/project_key/value");
    expect(projectFetched.status).toBe(200);
    expect(projectFetched.body).toEqual({ key: "project_key", value: "project-secret-value", version: 1 });
    expect(await db.select().from(secretAccessEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ secretId: projectSecret.id, outcome: "success", consumerType: "agent_api" }),
    ]));

    const denied = await request(createApp(fixture)).post("/api/agents/me/secrets/unbound_key/value");
    expect(denied.status).toBe(403);
    expect(await db.select().from(secretAccessEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ secretId: unboundSecret.id, outcome: "failure", errorCode: "binding_missing" }),
    ]));
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "secret.value.read", entityId: unboundSecret.id }),
    ]));
  });

  it("denies low-trust, task-bridge, and skill-test callers on both routes", async () => {
    const lowTrust = await seedAgentRun({
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, projectIds: [randomUUID()] } },
    });
    const standard = await seedAgentRun();
    const cases = [
      { name: "low trust", fixture: lowTrust, scope: { kind: "standard" } as const, source: "agent_jwt" as const },
      { name: "task bridge", fixture: standard, scope: { kind: "task_bridge", parentIssueId: randomUUID() } as const, source: "agent_key" as const },
      { name: "skill test", fixture: standard, scope: { kind: "skill_test", issueId: randomUUID() } as const, source: "agent_jwt" as const },
    ];
    for (const testCase of cases) {
      expect(
        (await request(createApp(testCase.fixture, testCase.scope, testCase.source)).get("/api/agents/me/secrets")).status,
        `${testCase.name} list`,
      ).toBe(403);
      expect(
        (await request(createApp(testCase.fixture, testCase.scope, testCase.source)).post("/api/agents/me/secrets/ANY/value")).status,
        `${testCase.name} fetch`,
      ).toBe(403);
    }
  });
});
