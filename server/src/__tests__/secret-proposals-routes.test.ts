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
  companySecretProposals,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("secret proposal routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secret-proposals-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secret-proposal-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(companySecretProposals);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(issues);
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

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret proposals",
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: "SEC-1",
      status: "in_progress",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  function createAgentApp(
    fixture: Awaited<ReturnType<typeof seedRun>>,
    source: "agent_jwt" | "agent_key" = "agent_jwt",
    keyScope: { kind: "standard" } | { kind: "task_bridge"; parentIssueId: string } = { kind: "standard" },
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source,
        keyScope,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(fixture: Awaited<ReturnType<typeof seedRun>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [fixture.companyId],
        source: "local_implicit",
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("requires agent JWT and atomically cascade-approves a secret plus binding with dual audits", async () => {
    const fixture = await seedRun();
    const denied = await request(createAgentApp(fixture, "agent_key"))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/vendor/token", value: "top-secret", justification: "Needed by task" });
    expect(denied.status).toBe(403);
    const scopedDenied = await request(createAgentApp(
      fixture,
      "agent_jwt",
      { kind: "task_bridge", parentIssueId: fixture.issueId },
    )).post("/api/agents/me/secret-proposals").send({
      kind: "secret",
      name: "dev/vendor/token",
      value: "top-secret",
      justification: "Needed by task",
    });
    expect(scopedDenied.status).toBe(403);

    const secretResponse = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/vendor/token", value: "top-secret", justification: "Needed by task" });
    expect(secretResponse.status).toBe(201);
    expect(JSON.stringify(secretResponse.body)).not.toContain("top-secret");
    expect(secretResponse.body).not.toHaveProperty("valueFingerprintSha256");
    const [registeredRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.heartbeatRunId));
    expect(JSON.stringify(registeredRun.contextSnapshot)).not.toContain("top-secret");
    expect(registeredRun.contextSnapshot).toMatchObject({
      paperclipSecretRedactions: [expect.objectContaining({ fingerprintSha256: expect.any(String), material: expect.any(Object) })],
    });

    const bindingResponse = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretResponse.body.id,
        configPath: "env.VENDOR_TOKEN",
        justification: "Inject for the task",
      });
    expect(bindingResponse.status).toBe(201);

    const agentApprovalDenied = await request(createAgentApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretResponse.body.id}/approve`)
      .send({});
    expect(agentApprovalDenied.status).toBe(403);
    expect(await db.select().from(companySecrets)).toHaveLength(0);

    const prerequisite = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingResponse.body.id}/approve`)
      .send({});
    expect(prerequisite.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);

    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingResponse.body.id}/approve`)
      .send({ cascade: true });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "approved",
      appliedBindingConfigPath: "env.VENDOR_TOKEN",
      viewerCanApprove: false,
    });

    const proposalRows = await db.select().from(companySecretProposals);
    expect(proposalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secretResponse.body.id, status: "approved", valueCiphertext: null }),
      expect.objectContaining({ id: bindingResponse.body.id, status: "approved" }),
    ]));
    const [secret] = await db.select().from(companySecrets);
    expect(secret).toMatchObject({ name: "dev/vendor/token", createdByAgentId: fixture.agentId, createdByUserId: "board-user" });
    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({ secretId: secret.id, targetId: fixture.agentId, configPath: "env.VENDOR_TOKEN" }),
    ]);
    const [agent] = await db.select().from(agents);
    expect(agent.adapterConfig).toMatchObject({
      env: { VENDOR_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    const actions = (await db.select().from(activityLog)).map((row) => row.action);
    expect(actions.filter((action) => action === "secret.proposal.approved")).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(["secret.proposal.created", "secret.created", "agent.updated"]));
    expect(await db.select().from(issueComments)).toEqual([
      expect.objectContaining({ issueId: fixture.issueId, authorUserId: "board-user" }),
    ]);
  });

  it("returns 409 without mutation when the current org graph no longer permits the stored binding target", async () => {
    const fixture = await seedRun();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Report",
      role: "engineer",
      reportsTo: fixture.agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/reorg/token", value: "reorg-secret", justification: "Needed by report" });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        targetAgentId,
        configPath: "access.REORG_TOKEN",
        justification: "Give the report API access",
      });
    expect(bindingProposal.status).toBe(201);

    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, targetAgentId));
    const response = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({ cascade: true });
    expect(response.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect((await db.select().from(companySecretProposals)).every((proposal) => proposal.status === "pending")).toBe(true);
  });
});
