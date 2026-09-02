import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  issueThreadInteractions,
  issues,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { agentService } from "../services/agents.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { secretService } from "../services/secrets.js";
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
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(companySecretProposals);
    await db.delete(issueThreadInteractions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
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
      responsibleUserId: "user-1",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: "SEC-1",
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  async function holdIssueRowLock(issueId: string) {
    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const transaction = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      signalLocked();
      await release;
    });
    await locked;
    return async () => {
      releaseLock();
      await transaction;
    };
  }

  async function waitForBlockedForUpdate(tableName: string) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${tableName}%`}
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  async function lockProposalNowait(proposalId: string) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM company_secret_proposals
        WHERE id = ${proposalId}
        FOR UPDATE NOWAIT
      `);
    });
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

  function createBoardApp(
    fixture: Awaited<ReturnType<typeof seedRun>>,
    options?: {
      admin?: boolean;
      heartbeat?: IssueAssignmentWakeupDeps;
      issues?: Pick<ReturnType<typeof issueService>, "getById" | "addComment">;
    },
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [fixture.companyId],
        source: options?.admin === false ? "session" : "local_implicit",
        memberships: options?.admin === false
          ? [{ companyId: fixture.companyId, status: "active", membershipRole: "member" }]
          : undefined,
      };
      next();
    });
    app.use("/api", secretRoutes(db, { heartbeat: options?.heartbeat, issues: options?.issues }));
    app.use(errorHandler);
    return app;
  }

  it("requires company admin access to reject secret proposals", async () => {
    const fixture = await seedRun();
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/reject/token", value: "reject-secret", justification: "Needed" });

    const rejected = await request(createBoardApp(fixture, { admin: false }))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposed.body.id}/reject`)
      .send({ reason: "Not approved" });

    expect(rejected.status).toBe(403);
    expect(await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, proposed.body.id)))
      .toEqual([expect.objectContaining({ status: "pending", valueCiphertext: expect.any(Object) })]);
  });

  it("keeps committed approve and reject responses successful when resolution notifications fail", async () => {
    const fixture = await seedRun();
    await db.update(issues)
      .set({ assigneeAgentId: fixture.agentId })
      .where(eq(issues.id, fixture.issueId));
    const wakeup = vi.fn().mockRejectedValue(new Error("wakeup queue unavailable"));
    const persistedIssues = issueService(db);
    const addComment = vi.fn().mockRejectedValue(new Error("comment store unavailable"));
    const boardApp = createBoardApp(fixture, {
      heartbeat: { wakeup },
      issues: { getById: persistedIssues.getById, addComment },
    });

    const approvedProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/notification/approve",
        value: "approval-value",
        justification: "Needed by task",
      });
    const approved = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${approvedProposal.body.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");

    const rejectedProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/notification/reject",
        value: "rejection-value",
        justification: "Needed by task",
      });
    const rejected = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${rejectedProposal.body.id}/reject`)
      .send({ reason: "No longer needed" });

    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(await db.select().from(companySecretProposals)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: approvedProposal.body.id, status: "approved", valueCiphertext: null }),
      expect.objectContaining({ id: rejectedProposal.body.id, status: "rejected", valueCiphertext: null }),
    ]));
    expect(await db.select().from(issueComments)).toHaveLength(0);
  });

  it("uses the selected provider vault when approving a secret proposal", async () => {
    const fixture = await seedRun();
    const vault = await secretService(db).createProviderConfig(fixture.companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/proposed-token";
    const createSecret = vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef,
      providerVersionRef: "aws-version-1",
    });

    const proposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/provider/token",
        value: "provider-secret",
        justification: "Store this credential in the company vault",
      });
    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposal.body.id}/approve`)
      .send({ overrides: { providerConfigId: vault.id } });

    expect(approved.status).toBe(200);
    expect(createSecret).toHaveBeenCalledWith(expect.objectContaining({
      value: "provider-secret",
      providerConfig: expect.objectContaining({ id: vault.id, provider: "aws_secrets_manager" }),
    }));
    expect(await db.select().from(companySecrets)).toEqual([
      expect.objectContaining({
        provider: "aws_secrets_manager",
        providerConfigId: vault.id,
        status: "active",
      }),
    ]);
  });

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
      .send({
        kind: "secret",
        name: "dev/vendor/token",
        key: "VENDOR_TOKEN",
        value: "top-secret",
        justification: "Needed by task",
      });
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
    const [confirmation] = await db.select().from(issueThreadInteractions);
    expect(confirmation).toMatchObject({
      issueId: fixture.issueId,
      kind: "request_confirmation",
      status: "pending",
      sourceRunId: fixture.heartbeatRunId,
      createdByAgentId: fixture.agentId,
      addresseeAgentId: null,
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "governed_action",
      payload: expect.objectContaining({
        secretProposal: expect.objectContaining({
          proposalId: bindingResponse.body.id,
          sourceSecretLabel: "dev/vendor/token",
          configPath: "env.VENDOR_TOKEN",
          targetAgentId: fixture.agentId,
          targetAgentName: "Proposer",
          justification: "Inject for the task",
        }),
      }),
    });
    expect(JSON.stringify(confirmation.payload)).not.toContain("top-secret");
    expect(JSON.stringify(confirmation.payload)).not.toContain("fingerprint");
    expect(confirmation.payload).not.toHaveProperty("secretId");

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
    expect(secret).toMatchObject({
      name: "dev/vendor/token",
      key: "vendor_token",
      createdByAgentId: fixture.agentId,
      createdByUserId: "board-user",
    });
    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({ secretId: secret.id, targetId: fixture.agentId, configPath: "env.VENDOR_TOKEN" }),
    ]);
    const [agent] = await db.select().from(agents);
    expect(agent.adapterConfig).toMatchObject({
      env: { VENDOR_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    const actions = (await db.select().from(activityLog)).map((row) => row.action);
    expect(actions.filter((action) => action === "secret.proposal.approved")).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining([
      "secret.proposal.created",
      "secret.created",
      "agent.updated",
      "secret.binding.created",
    ]));
    expect(await db.select().from(issueThreadInteractions)).toEqual([
      expect.objectContaining({
        id: confirmation.id,
        status: "accepted",
        result: expect.objectContaining({
          outcome: "accepted",
          secretProposal: expect.objectContaining({ status: "executed" }),
        }),
      }),
    ]);
    expect(await db.select().from(issueComments)).toEqual([
      expect.objectContaining({
        issueId: fixture.issueId,
        authorUserId: "board-user",
        body: expect.stringContaining("GET /api/agents/me/secrets"),
      }),
    ]);
  });

  it("approves a binding without cascade after its secret proposal was approved separately", async () => {
    const fixture = await seedRun();
    const agentApp = createAgentApp(fixture);
    const boardApp = createBoardApp(fixture);
    const secretProposal = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/sequential/token",
        value: "sequential-secret",
        justification: "Approve this first",
      });
    expect(secretProposal.status).toBe(201);

    const bindingProposal = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.SEQUENTIAL_TOKEN",
        justification: "Bind after separate approval",
      });
    expect(bindingProposal.status).toBe(201);

    const approvedSecret = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretProposal.body.id}/approve`)
      .send({});
    expect(approvedSecret.status).toBe(200);
    expect(approvedSecret.body).toMatchObject({ status: "approved", createdSecretId: expect.any(String) });

    const approvedBinding = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({});
    expect(approvedBinding.status).toBe(200);
    expect(approvedBinding.body).toMatchObject({
      status: "approved",
      appliedBindingConfigPath: "env.SEQUENTIAL_TOKEN",
    });
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({
        secretId: approvedSecret.body.createdSecretId,
        targetId: fixture.agentId,
        configPath: "env.SEQUENTIAL_TOKEN",
      }),
    ]);
  });

  it("proposes and approves a binding by resolving the proposer's own sourceConfigPath", async () => {
    const fixture = await seedRun();
    const sourceSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/source-path/token",
      key: "SOURCE_PATH_TOKEN",
      provider: "local_encrypted",
      value: "source-path-secret",
    });
    await secretService(db).createBinding({
      companyId: fixture.companyId,
      secretId: sourceSecret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: "access.existing_source",
    });

    const proposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        sourceConfigPath: "access.existing_source",
        configPath: "access.new_alias",
        justification: "Reuse the credential under the task-specific alias",
      });

    expect(proposal.status).toBe(201);
    expect(proposal.body).toMatchObject({
      kind: "binding",
      secretId: sourceSecret.id,
      configPath: "access.new_alias",
      target: { id: fixture.agentId },
    });
    expect(await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, proposal.body.id)))
      .toEqual([expect.objectContaining({ secretId: sourceSecret.id, targetId: fixture.agentId })]);

    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposal.body.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(await db.select().from(companySecretBindings)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        secretId: sourceSecret.id,
        targetId: fixture.agentId,
        configPath: "access.new_alias",
      }),
    ]));
  });

  it("rejects binding proposals that provide both secretId and sourceConfigPath", async () => {
    const fixture = await seedRun();
    const sourceSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/mutual-exclusion/token",
      key: "MUTUAL_EXCLUSION_TOKEN",
      provider: "local_encrypted",
      value: "mutual-exclusion-secret",
    });
    await secretService(db).createBinding({
      companyId: fixture.companyId,
      secretId: sourceSecret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: "access.mutual_exclusion_source",
    });

    const response = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: sourceSecret.id,
        sourceConfigPath: "access.mutual_exclusion_source",
        configPath: "access.new_alias",
        justification: "This request is intentionally ambiguous",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/exactly one of secretId, sourceConfigPath, or secretProposalId/);
    expect(await db.select().from(companySecretProposals)).toHaveLength(0);
  });

  it("accepts a user-scoped source secret only through the proposer's existing binding", async () => {
    const fixture = await seedRun();
    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(fixture.companyId, {
      key: "personal_source_token",
      name: "Personal source token",
      provider: "local_encrypted",
    });
    const userSecret = await secrets.createCurrentUserSecretValue(fixture.companyId, "user-1", {
      definitionId: definition.id,
      value: "personal-source-secret",
    });
    await agentService(db).update(fixture.agentId, {
      adapterConfig: {
        "access.personal_source": {
          type: "user_secret_ref",
          key: definition.key,
          version: "latest",
          required: true,
          allowMissingOverride: false,
        },
      },
    });

    const proposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        sourceConfigPath: "access.personal_source",
        configPath: "access.personal_alias",
        justification: "Reuse the already-bound user credential",
      });

    expect(proposal.status).toBe(201);
    expect(proposal.body).toMatchObject({ secretId: userSecret.id, target: { id: fixture.agentId } });

    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposal.body.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    const updatedAgent = await agentService(db).getById(fixture.agentId);
    expect(updatedAgent?.adapterConfig).toMatchObject({
      "access.personal_alias": {
        type: "user_secret_ref",
        key: definition.key,
        version: "latest",
        required: true,
        allowMissingOverride: false,
      },
    });
    expect(await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.targetId, fixture.agentId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          userSecretDefinitionId: definition.id,
          configPath: "access.personal_source",
        }),
        expect.objectContaining({
          userSecretDefinitionId: definition.id,
          configPath: "access.personal_alias",
        }),
      ]));
  });

  it("preserves user-secret declaration semantics when rebinding a source secret to a report", async () => {
    const fixture = await seedRun();
    const reportAgentId = randomUUID();
    await db.insert(agents).values({
      id: reportAgentId,
      companyId: fixture.companyId,
      name: "Report",
      role: "engineer",
      reportsTo: fixture.agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(fixture.companyId, {
      key: "personal_report_source_token",
      name: "Personal report source token",
      provider: "local_encrypted",
    });
    const userSecret = await secrets.createCurrentUserSecretValue(fixture.companyId, "user-1", {
      definitionId: definition.id,
      value: "personal-report-source-secret",
    });
    await secrets.createCurrentUserSecretValue(fixture.companyId, "user-2", {
      definitionId: definition.id,
      value: "second-user-report-secret",
    });
    await agentService(db).update(fixture.agentId, {
      adapterConfig: {
        "access.personal_report_source": {
          type: "user_secret_ref",
          key: definition.key,
          version: "latest",
          required: true,
          allowMissingOverride: false,
        },
      },
    });

    const proposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        sourceConfigPath: "access.personal_report_source",
        targetAgentId: reportAgentId,
        configPath: "access.personal_alias",
        justification: "Attempt to pass a personal credential to a report",
      });

    expect(proposal.status).toBe(201);
    expect(proposal.body).toMatchObject({ secretId: userSecret.id, target: { id: reportAgentId } });

    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposal.body.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    const report = await agentService(db).getById(reportAgentId);
    expect(report?.adapterConfig).toMatchObject({
      "access.personal_alias": {
        type: "user_secret_ref",
        key: definition.key,
        version: "latest",
        required: true,
        allowMissingOverride: false,
      },
    });
    expect(await db.select().from(userSecretDeclarations).where(and(
      eq(userSecretDeclarations.targetId, reportAgentId),
      eq(userSecretDeclarations.configPath, "access.personal_alias"),
    ))).toEqual([expect.objectContaining({ userSecretDefinitionId: definition.id })]);
    await expect(secrets.resolveUserSecretValue(
      fixture.companyId,
      {
        definitionKey: definition.key,
        responsibleUserId: "user-1",
      },
      {
        consumerType: "agent",
        consumerId: reportAgentId,
        configPath: "access.personal_alias",
      },
    )).resolves.toMatchObject({ value: "personal-report-source-secret" });
    await expect(secrets.resolveUserSecretValue(
      fixture.companyId,
      {
        definitionKey: definition.key,
        responsibleUserId: "user-2",
      },
      {
        consumerType: "agent",
        consumerId: reportAgentId,
        configPath: "access.personal_alias",
      },
    )).resolves.toMatchObject({ value: "second-user-report-secret" });
  });

  it("returns 404 when sourceConfigPath is missing or belongs to another agent", async () => {
    const fixture = await seedRun();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: fixture.companyId,
      name: "Other agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    const otherSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/other-agent/token",
      key: "OTHER_AGENT_TOKEN",
      provider: "local_encrypted",
      value: "other-agent-secret",
    });
    await secretService(db).createBinding({
      companyId: fixture.companyId,
      secretId: otherSecret.id,
      targetType: "agent",
      targetId: otherAgentId,
      configPath: "access.other_agent_only",
    });
    const agentApp = createAgentApp(fixture);

    const missing = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        sourceConfigPath: "access.does_not_exist",
        configPath: "access.new_alias",
        justification: "Try an unresolved source",
      });
    const crossAgent = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        sourceConfigPath: "access.other_agent_only",
        configPath: "access.new_alias",
        justification: "Try another agent's source",
      });

    expect(missing.status).toBe(404);
    expect(crossAgent.status).toBe(404);
    expect(missing.body.error).toBe("Source secret binding not found");
    expect(crossAgent.body.error).toBe("Source secret binding not found");
    expect(await db.select().from(companySecretProposals)).toHaveLength(0);
  });

  it("serializes proposal quotas and exposes bounded list pagination", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/quota/source",
      key: "QUOTA_SOURCE",
      provider: "local_encrypted",
      value: "quota-source-secret",
    });
    await secretService(db).createBinding({
      companyId: fixture.companyId,
      secretId: liveSecret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: "access.quota_source",
    });
    const agentApp = createAgentApp(fixture);

    const responses = await Promise.all(Array.from({ length: 21 }, (_, index) =>
      request(agentApp)
        .post("/api/agents/me/secret-proposals")
        .send({
          kind: "binding",
          sourceConfigPath: "access.quota_source",
          configPath: `env.QUOTA_${index}`,
          justification: "Exercise the concurrent proposal cap",
        })));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(20);
    expect(responses.filter((response) => response.status === 422)).toHaveLength(1);
    expect(await db.select().from(companySecretProposals)).toHaveLength(20);
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "secret.proposal.denied" }),
    ]));

    const firstPage = await request(agentApp).get("/api/agents/me/secret-proposals?limit=7&offset=0");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.proposals).toHaveLength(7);
    expect(firstPage.body.nextOffset).toBe(7);
    expect(firstPage.headers["x-next-offset"]).toBe("7");

    const lastBoardPage = await request(createBoardApp(fixture))
      .get(`/api/companies/${fixture.companyId}/secret-proposals?status=pending&limit=7&offset=14`);
    expect(lastBoardPage.status).toBe(200);
    expect(lastBoardPage.body).toHaveLength(6);
    expect(lastBoardPage.headers["x-next-offset"]).toBeUndefined();
  });

  it("bounds each expiry sweep batch", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/sweep/source",
      key: "SWEEP_SOURCE",
      provider: "local_encrypted",
      value: "sweep-source-secret",
    });
    const agentApp = createAgentApp(fixture);
    for (let index = 0; index < 3; index += 1) {
      const response = await request(agentApp)
        .post("/api/agents/me/secret-proposals")
        .send({
          kind: "binding",
          secretId: liveSecret.id,
          configPath: `env.SWEEP_${index}`,
          justification: "Exercise bounded expiry cleanup",
        });
      expect(response.status).toBe(201);
    }
    await db.update(companySecretProposals).set({ expiresAt: new Date(Date.now() - 1_000) });

    const proposals = createSecretProposalsService(db);
    let injectedCollision = false;
    await expect(proposals.sweepExpired(new Date(), 2, async (companyId, proposalId) => {
      if (!injectedCollision) {
        injectedCollision = true;
        throw conflict("Proposal is no longer pending");
      }
      return proposals.transition(companyId, proposalId, "expired", { reason: "Pending proposal expired" });
    })).resolves.toBe(1);
    expect((await db.select().from(companySecretProposals)).filter((proposal) => proposal.status === "pending"))
      .toHaveLength(2);
    await expect(proposals.sweepExpired(new Date(), 2)).resolves.toBe(2);
  });

  it("mirrors binding proposal rejection, withdrawal, and expiry onto linked cards", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/lifecycle/source",
      key: "LIFECYCLE_SOURCE",
      provider: "local_encrypted",
      value: "lifecycle-secret",
    });
    const agentApp = createAgentApp(fixture);
    const boardApp = createBoardApp(fixture);
    const createBinding = async (configPath: string) => request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: liveSecret.id,
        configPath,
        justification: "Exercise mirrored lifecycle",
      });

    const rejected = await createBinding("access.REJECTED_ALIAS");
    expect(rejected.status).toBe(201);
    expect((await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${rejected.body.id}/reject`)
      .send({ reason: "Use a narrower alias" })).status).toBe(200);

    const withdrawn = await createBinding("access.WITHDRAWN_ALIAS");
    expect(withdrawn.status).toBe(201);
    expect((await request(agentApp)
      .delete(`/api/agents/me/secret-proposals/${withdrawn.body.id}`)).status).toBe(200);

    const expired = await createBinding("access.EXPIRED_ALIAS");
    expect(expired.status).toBe(201);
    await db.update(companySecretProposals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(companySecretProposals.id, expired.body.id));
    await expect(createSecretProposalsService(db).sweepExpired()).resolves.toBe(1);

    const proposalRows = await db.select().from(companySecretProposals);
    const cards = await db.select().from(issueThreadInteractions);
    const cardByProposalId = new Map(cards.map((card) => {
      const payload = card.payload as { secretProposal?: { proposalId?: string } };
      return [payload.secretProposal?.proposalId, card];
    }));
    expect(proposalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rejected.body.id, status: "rejected" }),
      expect.objectContaining({ id: withdrawn.body.id, status: "withdrawn" }),
      expect.objectContaining({ id: expired.body.id, status: "expired" }),
    ]));
    expect(cardByProposalId.get(rejected.body.id)).toMatchObject({ status: "rejected" });
    expect(cardByProposalId.get(withdrawn.body.id)).toMatchObject({ status: "cancelled" });
    expect(cardByProposalId.get(expired.body.id)).toMatchObject({ status: "expired" });
  });

  it("mirrors card rejection onto the linked binding proposal", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/card-lifecycle/source",
      key: "CARD_LIFECYCLE_SOURCE",
      provider: "local_encrypted",
      value: "card-lifecycle-secret",
    });
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: liveSecret.id,
        configPath: "access.CARD_REJECTED_ALIAS",
        justification: "Exercise reverse lifecycle mirroring",
      });
    expect(proposed.status).toBe(201);

    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, proposed.body.interactionId));
    expect(card).toMatchObject({ status: "pending" });
    await issueThreadInteractionService(db).rejectInteraction(
      { id: fixture.issueId, companyId: fixture.companyId, status: "in_progress" },
      card!.id,
      { reason: "Use the canonical binding name" },
      { userId: "board-user" },
    );

    expect(await db.select().from(companySecretProposals)
      .where(eq(companySecretProposals.id, proposed.body.id)))
      .toEqual([expect.objectContaining({
        status: "rejected",
        resolutionReason: "Use the canonical binding name",
      })]);
  });

  it("settles an accepted card execution failure on both the card and proposal", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/card-failure/source",
      key: "CARD_FAILURE_SOURCE",
      provider: "local_encrypted",
      value: "card-failure-secret",
    });
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: liveSecret.id,
        configPath: "access.CARD_FAILED_ALIAS",
        justification: "Exercise atomic execution failure settlement",
      });
    expect(proposed.status).toBe(201);
    await db.update(issueThreadInteractions)
      .set({
        status: "accepted",
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
      })
      .where(eq(issueThreadInteractions.id, proposed.body.interactionId));

    const card = await issueThreadInteractionService(db).recordSecretProposalExecutionResult(
      { id: fixture.issueId, companyId: fixture.companyId },
      proposed.body.interactionId,
      proposed.body.id,
      { status: "failed", errorCode: "permission_denied" },
    );

    expect(card).toMatchObject({
      status: "accepted",
      result: {
        outcome: "accepted",
        secretProposal: { status: "failed", errorCode: "permission_denied" },
      },
    });
    expect(await db.select().from(companySecretProposals)
      .where(eq(companySecretProposals.id, proposed.body.id)))
      .toEqual([expect.objectContaining({
        status: "rejected",
        resolvedByUserId: "board-user",
        resolutionReason: "Interaction acceptance failed: permission_denied",
      })]);
  });

  it("waits on the issue before locking a linked proposal during card rejection", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/card-lock-order/source",
      key: "CARD_LOCK_ORDER_SOURCE",
      provider: "local_encrypted",
      value: "card-lock-order-secret",
    });
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: liveSecret.id,
        configPath: "access.CARD_LOCK_ORDER_ALIAS",
        justification: "Verify the proposal-to-issue lock order",
      });
    expect(proposed.status).toBe(201);

    const releaseIssueLock = await holdIssueRowLock(fixture.issueId);

    const rejection = issueThreadInteractionService(db).rejectInteraction(
      { id: fixture.issueId, companyId: fixture.companyId, status: "in_progress" },
      proposed.body.interactionId,
      { reason: "Reject after the lock-order check" },
      { userId: "board-user" },
    );

    try {
      expect(await waitForBlockedForUpdate("issues")).toBe(true);

      // Terminal issue transitions already hold the issue before expiring a
      // proposal. Rejection must wait there without taking the proposal first.
      await expect(lockProposalNowait(proposed.body.id)).resolves.toBeUndefined();
    } finally {
      await releaseIssueLock();
    }

    await expect(rejection).resolves.toMatchObject({ status: "rejected" });
  });

  it("waits on the issue before locking a proposal execution result", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/execution-lock-order/source",
      key: "EXECUTION_LOCK_ORDER_SOURCE",
      provider: "local_encrypted",
      value: "execution-lock-order-secret",
    });
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: liveSecret.id,
        configPath: "access.EXECUTION_LOCK_ORDER_ALIAS",
        justification: "Verify execution result lock ordering",
      });
    expect(proposed.status).toBe(201);
    await db.update(issueThreadInteractions)
      .set({
        status: "accepted",
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
      })
      .where(eq(issueThreadInteractions.id, proposed.body.interactionId));

    const releaseIssueLock = await holdIssueRowLock(fixture.issueId);

    const recording = issueThreadInteractionService(db).recordSecretProposalExecutionResult(
      { id: fixture.issueId, companyId: fixture.companyId },
      proposed.body.interactionId,
      proposed.body.id,
      { status: "failed", errorCode: "permission_denied" },
    );

    try {
      expect(await waitForBlockedForUpdate("issues")).toBe(true);
      await expect(lockProposalNowait(proposed.body.id)).resolves.toBeUndefined();
    } finally {
      await releaseIssueLock();
    }

    await expect(recording).resolves.toMatchObject({
      status: "accepted",
      result: { secretProposal: { status: "failed", errorCode: "permission_denied" } },
    });
  });

  it("keeps proposal and card consistent when approval races card rejection", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/card-race/source",
      key: "CARD_RACE_SOURCE",
      provider: "local_encrypted",
      value: "card-race-secret",
    });
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretId: liveSecret.id,
        configPath: "access.CARD_RACE_ALIAS",
        justification: "Exercise proposal and card lock ordering",
      });
    expect(proposed.status).toBe(201);

    const [approval, rejection] = await Promise.allSettled([
      request(createBoardApp(fixture))
        .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposed.body.id}/approve`)
        .send({}),
      issueThreadInteractionService(db).rejectInteraction(
        { id: fixture.issueId, companyId: fixture.companyId, status: "in_progress" },
        proposed.body.interactionId,
        { reason: "Reject the racing request" },
        { userId: "board-user" },
      ),
    ]);
    expect(approval.status).toBe("fulfilled");
    if (approval.status !== "fulfilled") throw approval.reason;
    expect([200, 409]).toContain(approval.value.status);
    expect(rejection.status).toBe(approval.value.status === 200 ? "rejected" : "fulfilled");

    const [proposal] = await db.select().from(companySecretProposals)
      .where(eq(companySecretProposals.id, proposed.body.id));
    const [card] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, proposed.body.interactionId));
    if (proposal!.status === "approved") {
      expect(card).toMatchObject({
        status: "accepted",
        result: { secretProposal: { status: "executed" } },
      });
    } else {
      expect(proposal).toMatchObject({ status: "rejected" });
      expect(card).toMatchObject({
        status: "rejected",
        result: { secretProposal: { status: "rejected" } },
      });
    }
  });

  it("denies direct and cascade approval after a proposal expires", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/expired/token",
        value: "expired-secret",
        justification: "Needed before the retention window elapsed",
      });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.EXPIRED_TOKEN",
        justification: "Inject the proposed secret",
      });
    await db.update(companySecretProposals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(companySecretProposals.id, secretProposal.body.id));

    const directApproval = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretProposal.body.id}/approve`)
      .send({});
    expect(directApproval.status).toBe(409);

    const cascadeApproval = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({ cascade: true });
    expect(cascadeApproval.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("rechecks expiry after acquiring the proposal approval lock", async () => {
    const fixture = await seedRun();
    const proposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/expiry-race/token",
        value: "expiry-race-secret",
        justification: "Exercise the approval boundary",
      });
    let approvalPromise: Promise<{ status: number; body: Record<string, unknown> }> | null = null;

    await db.transaction(async (tx) => {
      await tx.select().from(companySecretProposals)
        .where(eq(companySecretProposals.id, proposal.body.id))
        .for("update");
      approvalPromise = request(createBoardApp(fixture))
        .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposal.body.id}/approve`)
        .send({})
        .then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx.update(companySecretProposals)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(companySecretProposals.id, proposal.body.id));
    });

    const approval = await approvalPromise;
    expect(approval?.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect(await db.select().from(companySecretProposals)).toEqual([
      expect.objectContaining({ id: proposal.body.id, status: "pending" }),
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


  it("rejects bindings that reference terminal secret proposals", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/withdrawn/token",
        value: "withdrawn-secret",
        justification: "No longer needed",
      });
    expect(secretProposal.status).toBe(201);

    const withdrawn = await request(createAgentApp(fixture))
      .delete(`/api/agents/me/secret-proposals/${secretProposal.body.id}`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");

    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.WITHDRAWN_TOKEN",
        justification: "Reference a terminal dependency",
      });
    expect(bindingProposal.status).toBe(422);
    expect(bindingProposal.body.error).toContain("no longer pending");
    expect(await db.select().from(companySecretProposals)).toEqual([
      expect.objectContaining({ id: secretProposal.body.id, status: "withdrawn" }),
    ]);
  });

  it("serializes binding creation with concurrent dependency rejection", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/concurrent-reject/token",
        value: "concurrent-reject-secret",
        justification: "Create a binding while review is pending",
      });
    expect(secretProposal.status).toBe(201);

    const advisoryLockKey = 147460186;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_binding_proposal()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.kind = 'binding' THEN
          PERFORM pg_advisory_xact_lock(${advisoryLockKey});
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_binding_proposal
      BEFORE INSERT ON company_secret_proposals
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_binding_proposal();
    `));

    try {
      const bindingPromise = request(createAgentApp(fixture))
        .post("/api/agents/me/secret-proposals")
        .send({
          kind: "binding",
          secretProposalId: secretProposal.body.id,
          configPath: "env.CONCURRENT_REJECT_TOKEN",
          justification: "Exercise dependency serialization",
        })
        .then((response) => response);

      let bindingPaused = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const lockAvailable = await db.transaction(async (tx) => {
          const [result] = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_lock(${advisoryLockKey}) AS acquired`,
          );
          if (result?.acquired) {
            await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryLockKey})`);
          }
          return result?.acquired ?? false;
        });
        if (!lockAvailable) {
          bindingPaused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(bindingPaused).toBe(true);

      let rejectionFinished = false;
      const rejectionPromise = request(createBoardApp(fixture))
        .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretProposal.body.id}/reject`)
        .send({ reason: "Reject during binding creation" })
        .then((response) => {
          rejectionFinished = true;
          return response;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(rejectionFinished).toBe(false);

      const binding = await bindingPromise;
      const rejection = await rejectionPromise;
      expect(binding.status).toBe(201);
      expect(rejection.status).toBe(200);
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_binding_proposal ON company_secret_proposals;
        DROP FUNCTION IF EXISTS paperclip_test_pause_binding_proposal();
      `));
    }

    expect(await db.select().from(companySecretProposals)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secretProposal.body.id, status: "rejected" }),
      expect.objectContaining({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        status: "rejected",
        resolutionReason: `Dependent secret proposal ${secretProposal.body.id} was rejected`,
      }),
    ]));
    expect(await db.select().from(issueThreadInteractions)).toEqual([
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  it("cascade-rejects pending binding proposals when their secret proposal is withdrawn", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/cascade/token",
        value: "cascade-secret",
        justification: "Temporary access",
      });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.CASCADE_TOKEN",
        justification: "Use the temporary secret",
      });
    expect(bindingProposal.status).toBe(201);

    const withdrawn = await request(createAgentApp(fixture))
      .delete(`/api/agents/me/secret-proposals/${secretProposal.body.id}`);
    expect(withdrawn.status).toBe(200);

    expect(await db.select().from(companySecretProposals)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secretProposal.body.id, status: "withdrawn" }),
      expect.objectContaining({
        id: bindingProposal.body.id,
        status: "rejected",
        resolutionReason: `Dependent secret proposal ${secretProposal.body.id} was withdrawn`,
      }),
    ]));
  });

  it("holds the org graph stable until binding approval commits", async () => {
    const fixture = await seedRun();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Concurrent report",
      role: "engineer",
      reportsTo: fixture.agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/concurrent-reorg/token",
        value: "concurrent-reorg-secret",
        justification: "Needed by report",
      });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        targetAgentId,
        configPath: "access.CONCURRENT_REORG_TOKEN",
        justification: "Give the report API access",
      });
    expect(bindingProposal.status).toBe(201);

    const advisoryLockKey = 147460185;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_secret_approval()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryLockKey});
        PERFORM pg_sleep(1);
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_secret_approval
      BEFORE INSERT ON company_secrets
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_secret_approval();
    `));

    try {
      const approvalPromise = request(createBoardApp(fixture))
        .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
        .send({ cascade: true })
        .then((response) => response);

      let approvalPaused = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const lockAvailable = await db.transaction(async (tx) => {
          const [result] = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_lock(${advisoryLockKey}) AS acquired`,
          );
          if (result?.acquired) {
            await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryLockKey})`);
          }
          return result?.acquired ?? false;
        });
        if (!lockAvailable) {
          approvalPaused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(approvalPaused).toBe(true);

      let reorgFinished = false;
      const reorgPromise = db.update(agents)
        .set({ reportsTo: null })
        .where(eq(agents.id, targetAgentId))
        .then(() => {
          reorgFinished = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(reorgFinished).toBe(false);

      const approval = await approvalPromise;
      expect(approval.status).toBe(200);
      await reorgPromise;
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_secret_approval ON company_secrets;
        DROP FUNCTION IF EXISTS paperclip_test_pause_secret_approval();
      `));
    }

    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({ targetId: targetAgentId, configPath: "access.CONCURRENT_REORG_TOKEN" }),
    ]);
    expect(await db.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, targetAgentId)))
      .toEqual([{ reportsTo: null }]);
  });
});
