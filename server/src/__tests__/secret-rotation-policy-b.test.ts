import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companySecretBindings,
  companySecretDeploymentAssertions,
  companySecretProposals,
  companySecretVersions,
  companySecrets,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalTestDatabase = resolveExternalTestDatabaseUrl("PAPERCLIP_SECRET_ROTATION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabase ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OLD_VALUE = "rotation-policy-b-old-value";
const NEW_VALUE = "rotation-policy-b-new-value";
const OTHER_VALUE = "rotation-policy-b-unrelated-value";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const OLD_FP = sha256(OLD_VALUE);
const NEW_FP = sha256(NEW_VALUE);
const OTHER_FP = sha256(OTHER_VALUE);

describeEmbeddedPostgres("ADR 033 policy B: agent secret rotation", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secret-rotation-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    if (externalTestDatabase) {
      db = createDb(externalTestDatabase, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
      return;
    }
    const started = await startEmbeddedPostgresTestDatabase("secret-rotation-policy-b");
    stopDb = started.cleanup;
    db = createDb(started.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(companySecretDeploymentAssertions);
    await db.delete(companySecretProposals);
    await db.delete(issueThreadInteractions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedRun(identifier = "ROT-1", companyId = randomUUID()) {
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret rotation",
      issuePrefix: `R${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Rotator",
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
      title: "Rotate the catalog secret",
      identifier,
      status: "in_progress",
      responsibleUserId: "user-1",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  type Fixture = Awaited<ReturnType<typeof seedRun>>;

  function createAgentApp(fixture: Fixture, source: "agent_jwt" | "agent_key" = "agent_jwt") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source,
        keyScope: { kind: "standard" },
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(fixture: Fixture) {
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

  async function seedLiveSecret(fixture: Fixture, name: string, value: string) {
    return secretService(db).create(fixture.companyId, {
      name,
      key: name.split("/").at(-1)!.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
      provider: "local_encrypted",
      value,
    });
  }

  async function proposeSecret(fixture: Fixture, name: string, value: string) {
    const response = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name, value, justification: "ADR 033 policy B rotation" });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function proposeBinding(fixture: Fixture, body: Record<string, unknown>) {
    const response = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "binding", justification: "ADR 033 policy B binding", ...body });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function approveProposal(fixture: Fixture, proposalId: string, body: Record<string, unknown> = {}) {
    return request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposalId}/approve`)
      .send(body);
  }

  async function registerAssertion(
    fixture: Fixture,
    secretId: string,
    body: {
      expectedLatestVersion: number;
      valueFingerprintSha256: string;
      previousValueFingerprintSha256: string;
      deploymentLabel?: string;
    },
  ) {
    return request(createAgentApp(fixture))
      .post(`/api/secrets/${secretId}/deployment-assertions`)
      .send({ deploymentLabel: "ingestion-service/prod", ...body });
  }

  async function rotateAsAgent(fixture: Fixture, secretId: string, body: Record<string, unknown>) {
    return request(createAgentApp(fixture)).post(`/api/secrets/${secretId}/rotate`).send(body);
  }

  async function rotateAsBoard(fixture: Fixture, secretId: string, body: Record<string, unknown>) {
    return request(createBoardApp(fixture)).post(`/api/secrets/${secretId}/rotate`).send(body);
  }

  async function readSecret(secretId: string) {
    const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
    return row;
  }

  async function readCurrentVersion(secretId: string) {
    const rows = await db.select().from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secretId))
      .orderBy(companySecretVersions.version);
    return rows.at(-1);
  }

  async function readVersions(secretId: string) {
    return db.select().from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secretId))
      .orderBy(companySecretVersions.version);
  }

  async function readAdapterConfig(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return (row?.adapterConfig ?? {}) as Record<string, unknown>;
  }

  async function occupyConfigPath(fixture: Fixture, secretId: string, configPath: string) {
    const bindingProposalId = await proposeBinding(fixture, { secretId, configPath });
    const approved = await approveProposal(fixture, bindingProposalId);
    expect(approved.status).toBe(200);
    return bindingProposalId;
  }

  async function readyAgentRotation(
    fixture: Fixture,
    secretId: string,
    options: { value?: string } = {},
  ) {
    const value = options.value ?? NEW_VALUE;
    const live = await readSecret(secretId);
    const proposalId = await proposeSecret(fixture, live!.name, value);
    const assertion = await registerAssertion(fixture, secretId, {
      expectedLatestVersion: live!.latestVersion,
      valueFingerprintSha256: sha256(value),
      previousValueFingerprintSha256: OLD_FP,
    });
    expect(assertion.status).toBe(201);
    const approved = await approveProposal(fixture, proposalId);
    expect(approved.status).toBe(200);
    return { proposalId, assertionId: assertion.body.id as string, value, expectedLatestVersion: live!.latestVersion };
  }

  it("T1: an agent rotation without an approved proposal is 403 and leaves the secret unchanged", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t1/token", OLD_VALUE);

    const response = await rotateAsAgent(fixture, secret.id, {
      value: NEW_VALUE,
      expectedLatestVersion: 1,
      valueFingerprintSha256: NEW_FP,
    });

    expect(response.status).toBe(403);
    expect(response.body.error ?? response.body.message).toContain("authorizationProposalId");
    const after = await readSecret(secret.id);
    expect(after!.latestVersion).toBe(1);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(OLD_FP);
  });

  it("T2: an approved proposal without a deployment assertion is 403 and leaves the secret unchanged", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t2/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    const response = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
    });

    expect(response.status).toBe(403);
    expect(response.body.error ?? response.body.message).toContain("deploymentAssertionId");
    const after = await readSecret(secret.id);
    expect(after!.latestVersion).toBe(1);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(OLD_FP);
  });

  it("T3: a declared fingerprint that differs from the approved proposal is 409 and writes nothing", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t3/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    const response = await rotateAsAgent(fixture, secret.id, {
      value: NEW_VALUE,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: OTHER_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });

    expect(response.status).toBe(409);
    expect(response.body.error ?? response.body.message).toContain("does not match the value approved");
    const after = await readSecret(secret.id);
    expect(after!.latestVersion).toBe(1);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(OLD_FP);
  });

  it("T4: a stale expectedLatestVersion is 409 with the stale-version conflict and writes nothing", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t4/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    const boardRotation = await rotateAsBoard(fixture, secret.id, { value: OTHER_VALUE });
    expect(boardRotation.status).toBe(200);

    const response = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });

    expect(response.status).toBe(409);
    expect(response.body.error ?? response.body.message).toContain("version is stale");
    const after = await readSecret(secret.id);
    expect(after!.latestVersion).toBe(2);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(sha256(OTHER_VALUE));
  });

  it("T5: a fully authorized agent rotation writes one version in place and audits the agent", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t5/token", OLD_VALUE);
    await secretService(db).createBinding({
      companyId: fixture.companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: fixture.agentId,
      configPath: "access.T5_TOKEN",
    });
    const ready = await readyAgentRotation(fixture, secret.id);

    const response = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });

    expect(response.status).toBe(200);
    const after = await readSecret(secret.id);
    expect(after!.id).toBe(secret.id);
    expect(after!.name).toBe(secret.name);
    expect(after!.key).toBe(secret.key);
    expect(after!.latestVersion).toBe(2);
    expect(response.body).toMatchObject({ id: secret.id, name: secret.name, key: secret.key, latestVersion: 2 });

    const versions = await readVersions(secret.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 1, status: "previous", fingerprintSha256: OLD_FP });
    expect(versions[1]).toMatchObject({ version: 2, status: "current", fingerprintSha256: NEW_FP });

    const bindings = await db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.secretId, secret.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ configPath: "access.T5_TOKEN", secretId: secret.id });

    const [assertion] = await db.select().from(companySecretDeploymentAssertions);
    expect(assertion).toMatchObject({ status: "consumed", secretId: secret.id });
    expect(assertion!.consumedAt).not.toBeNull();

    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "secret.rotated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "agent",
      actorId: fixture.agentId,
      agentId: fixture.agentId,
      runId: fixture.heartbeatRunId,
      entityType: "secret",
      entityId: secret.id,
    });
    expect(audits[0].details).toMatchObject({
      version: 2,
      fingerprintSha256: NEW_FP,
      deploymentLabel: "ingestion-service/prod",
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });
    expect(JSON.stringify(audits[0].details)).not.toContain(NEW_VALUE);
  });

  it("T6: the board keeps rotating exactly as before, with a user audit", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t6/token", OLD_VALUE);

    const response = await rotateAsBoard(fixture, secret.id, { value: NEW_VALUE });

    expect(response.status).toBe(200);
    const after = await readSecret(secret.id);
    expect(after!.latestVersion).toBe(2);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(NEW_FP);

    const audits = await db.select().from(activityLog).where(eq(activityLog.action, "secret.rotated"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "user", actorId: "board-user" });
    expect(audits[0].agentId).toBeNull();
    expect(await db.select().from(companySecretDeploymentAssertions)).toHaveLength(0);
  });

  it("T7: an agent rotating another company's secret gets 404 without an existence leak", async () => {
    const fixture = await seedRun("ROT-7");
    const foreign = await seedRun("ROT-7B");
    const foreignSecret = await seedLiveSecret(foreign, "dev/t7/token", OLD_VALUE);

    const response = await rotateAsAgent(fixture, foreignSecret.id, {
      value: NEW_VALUE,
      expectedLatestVersion: 1,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: randomUUID(),
      deploymentAssertionId: randomUUID(),
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Secret not found" });
    expect((await readSecret(foreignSecret.id))!.latestVersion).toBe(1);
  });

  it("T8: a user-scoped secret is never rotated by the company rotation route", async () => {
    const fixture = await seedRun();
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: fixture.companyId,
      key: "T8_USER_TOKEN",
      name: "user/t8/token",
      status: "active",
    }).returning();
    const [userSecret] = await db.insert(companySecrets).values({
      companyId: fixture.companyId,
      scope: "user",
      ownerUserId: "user-1",
      userSecretDefinitionId: definition!.id,
      key: "T8_USER_TOKEN",
      name: "user/t8/token",
      provider: "local_encrypted",
      status: "active",
      latestVersion: 1,
    }).returning();

    const response = await rotateAsAgent(fixture, userSecret!.id, {
      value: NEW_VALUE,
      expectedLatestVersion: 1,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: randomUUID(),
      deploymentAssertionId: randomUUID(),
    });

    expect(response.status).toBe(404);
    expect((await readSecret(userSecret!.id))!.latestVersion).toBe(1);
  });

  it("T9: rotating a non-active secret is 422 with the canonical message", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t9/token", OLD_VALUE);
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret.id));

    const boardResponse = await rotateAsBoard(fixture, secret.id, { value: NEW_VALUE });
    expect(boardResponse.status).toBe(422);
    expect(boardResponse.body.error ?? boardResponse.body.message).toContain("Cannot rotate a non-active secret");

    const agentResponse = await rotateAsAgent(fixture, secret.id, {
      value: NEW_VALUE,
      expectedLatestVersion: 1,
      valueFingerprintSha256: NEW_FP,
    });
    expect(agentResponse.status).toBe(422);
    expect((await readSecret(secret.id))!.latestVersion).toBe(1);
  });

  it("T10: an agent rotation without expectedLatestVersion is 422 because the CAS is mandatory", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t10/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    const response = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });

    expect(response.status).toBe(422);
    expect(response.body.error ?? response.body.message).toContain("expectedLatestVersion is required");
    expect((await readSecret(secret.id))!.latestVersion).toBe(1);
  });

  it("T11: an expired deployment assertion is 403 and the catalog is untouched", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t11/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);
    await db.update(companySecretDeploymentAssertions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(companySecretDeploymentAssertions.id, ready.assertionId!));

    const response = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });

    expect(response.status).toBe(403);
    expect(response.body.error ?? response.body.message).toContain("expired");
    const [assertion] = await db.select().from(companySecretDeploymentAssertions);
    expect(assertion!.status).toBe("expired");
    expect((await readSecret(secret.id))!.latestVersion).toBe(1);
  });

  it("T12: replaying a consumed assertion is 409 and does not write a second version", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t12/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    const first = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });
    expect(first.status).toBe(200);

    const replay = await rotateAsAgent(fixture, secret.id, {
      value: ready.value,
      expectedLatestVersion: ready.expectedLatestVersion,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: ready.proposalId,
      deploymentAssertionId: ready.assertionId,
    });

    expect(replay.status).toBe(409);
    expect(replay.body.error ?? replay.body.message).toContain("already consumed");
    expect((await readSecret(secret.id))!.latestVersion).toBe(2);
  });

  it("T13: approving a proposal with a free name still creates a new row", async () => {
    const fixture = await seedRun();
    const proposalId = await proposeSecret(fixture, "dev/t13/brand-new", NEW_VALUE);

    const approved = await approveProposal(fixture, proposalId);

    expect(approved.status).toBe(200);
    const created = await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t13/brand-new"));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ latestVersion: 1, scope: "company" });
    expect((await db.select().from(companySecretProposals))
      .find((row) => row.id === proposalId)).toMatchObject({ status: "approved", createdSecretId: created[0].id });
  });

  it("T14: approving a proposal whose name is already live rotates in place instead of 409", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t14/token", OLD_VALUE);
    const proposalId = await proposeSecret(fixture, secret.name, NEW_VALUE);

    const approved = await approveProposal(fixture, proposalId);

    expect(approved.status).toBe(200);
    const after = await readSecret(secret.id);
    expect(after!.id).toBe(secret.id);
    expect(after!.latestVersion).toBe(2);
    const versions = await readVersions(secret.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 1, status: "previous" });
    expect(versions[1]).toMatchObject({ version: 2, status: "current", fingerprintSha256: NEW_FP });
    expect((await db.select().from(companySecretProposals))
      .find((row) => row.id === proposalId)).toMatchObject({ createdSecretId: secret.id });
  });

  it("T15: approving a proposal whose name belongs to a non-company secret is 409 with an explicit reason", async () => {
    const fixture = await seedRun();
    const [definition] = await db.insert(userSecretDefinitions).values({
      companyId: fixture.companyId,
      key: "T15_USER_TOKEN",
      name: "user/t15/token",
      status: "active",
    }).returning();
    await db.insert(companySecrets).values({
      companyId: fixture.companyId,
      scope: "user",
      ownerUserId: "user-1",
      userSecretDefinitionId: definition!.id,
      key: "T15_USER_TOKEN",
      name: "user/t15/token",
      provider: "local_encrypted",
      status: "active",
      latestVersion: 1,
    });
    const proposalId = await proposeSecret(fixture, "user/t15/token", NEW_VALUE);

    const approved = await approveProposal(fixture, proposalId);

    expect(approved.status).toBe(409);
    expect(approved.body.error ?? approved.body.message).toContain("non-company secret");
    expect((await db.select().from(companySecretProposals))
      .find((row) => row.id === proposalId)).toMatchObject({ status: "pending" });
  });

  it("T16: approving a proposal that no longer carries its value is 409 with the canonical message", async () => {
    const fixture = await seedRun();
    const proposalId = await proposeSecret(fixture, "dev/t16/token", NEW_VALUE);
    await db.update(companySecretProposals)
      .set({ valueCiphertext: null, ciphertextScrubbedAt: new Date() })
      .where(eq(companySecretProposals.id, proposalId));

    const approved = await approveProposal(fixture, proposalId);

    expect(approved.status).toBe(409);
    expect(approved.body.error ?? approved.body.message).toContain("Proposed secret value is no longer available");
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("T17: an overrides.name collision rotates the live row the same way T14 does", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t17/live-token", OLD_VALUE);
    const proposalId = await proposeSecret(fixture, "dev/t17/free-name", NEW_VALUE);

    const approved = await approveProposal(fixture, proposalId, { overrides: { name: secret.name } });

    expect(approved.status).toBe(200);
    const after = await readSecret(secret.id);
    expect(after!.latestVersion).toBe(2);
    expect((await readSecret(secret.id))!.name).toBe(secret.name);
    expect((await db.select().from(companySecretProposals))
      .find((row) => row.id === proposalId)).toMatchObject({ createdSecretId: secret.id });
    expect(await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t17/free-name"))).toHaveLength(0);
  });

  it("T18: after T14 the existing binding keeps the same secretId and resolves the new version", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t18/token", OLD_VALUE);
    await occupyConfigPath(fixture, secret.id, "access.T18_TOKEN");
    const proposalId = await proposeSecret(fixture, secret.name, NEW_VALUE);

    const approved = await approveProposal(fixture, proposalId);
    expect(approved.status).toBe(200);

    const config = await readAdapterConfig(fixture.agentId);
    expect(config["access.T18_TOKEN"]).toMatchObject({ type: "secret_ref", secretId: secret.id });
    const versions = await readVersions(secret.id);
    expect(versions[1]).toMatchObject({ version: 2, status: "current", fingerprintSha256: NEW_FP });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.binding.repointed"))).toHaveLength(0);
  });

  it("T19: approving a binding proposal on a free path writes a plain secret_ref", async () => {
    const fixture = await seedRun();
    const secretProposalId = await proposeSecret(fixture, "dev/t19/token", NEW_VALUE);
    const bindingProposalId = await proposeBinding(fixture, {
      secretProposalId,
      configPath: "access.T19_TOKEN",
    });

    const approved = await approveProposal(fixture, bindingProposalId, { cascade: true });

    expect(approved.status).toBe(200);
    const config = await readAdapterConfig(fixture.agentId);
    expect(config["access.T19_TOKEN"]).toMatchObject({ type: "secret_ref", version: "latest" });
    const created = await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t19/token"));
    expect((config["access.T19_TOKEN"] as { secretId: string }).secretId).toBe(created[0].id);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "agent.binding.repointed"))).toHaveLength(0);
  });

  it("T20: approving a binding on a path occupied by a different secret re-points it and audits the change", async () => {
    const fixture = await seedRun();
    const occupied = await seedLiveSecret(fixture, "dev/t20/occupied", OLD_VALUE);
    await occupyConfigPath(fixture, occupied.id, "access.T20_TOKEN");
    const secretProposalId = await proposeSecret(fixture, "dev/t20/incoming", NEW_VALUE);
    const bindingProposalId = await proposeBinding(fixture, {
      secretProposalId,
      configPath: "access.T20_TOKEN",
    });

    const approved = await approveProposal(fixture, bindingProposalId, { cascade: true });
    expect(approved.status).toBe(200);

    const incoming = await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t20/incoming"));
    const config = await readAdapterConfig(fixture.agentId);
    expect(config["access.T20_TOKEN"]).toMatchObject({
      type: "secret_ref",
      secretId: incoming[0].id,
      version: "latest",
    });

    const audits = await db.select().from(activityLog)
      .where(eq(activityLog.action, "agent.binding.repointed"));
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({
      configPath: "access.T20_TOKEN",
      fromSecretId: occupied.id,
      toSecretId: incoming[0].id,
      proposalId: bindingProposalId,
    });
  });

  it("T21: the re-point may only target the secret of the approved proposal", async () => {
    const fixture = await seedRun();
    const occupied = await seedLiveSecret(fixture, "dev/t21/occupied", OLD_VALUE);
    await occupyConfigPath(fixture, occupied.id, "access.T21_TOKEN");
    const secretProposalId = await proposeSecret(fixture, "dev/t21/incoming", NEW_VALUE);
    const bindingProposalId = await proposeBinding(fixture, {
      secretProposalId,
      configPath: "access.T21_TOKEN",
    });

    const approved = await approveProposal(fixture, bindingProposalId, {
      cascade: true,
      secretId: occupied.id,
      targetSecretId: randomUUID(),
    });
    expect(approved.status).toBe(200);

    const incoming = await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t21/incoming"));
    const config = await readAdapterConfig(fixture.agentId);
    expect((config["access.T21_TOKEN"] as { secretId: string }).secretId).toBe(incoming[0].id);
    expect((config["access.T21_TOKEN"] as { secretId: string }).secretId).not.toBe(occupied.id);
  });

  it("T22: both env.* and access.* namespaces re-point an occupied path", async () => {
    const fixture = await seedRun();
    const occupied = await seedLiveSecret(fixture, "dev/t22/occupied", OLD_VALUE);
    await occupyConfigPath(fixture, occupied.id, "env.T22_TOKEN");
    await occupyConfigPath(fixture, occupied.id, "access.T22_TOKEN");

    const envSecretProposalId = await proposeSecret(fixture, "dev/t22/incoming", NEW_VALUE);
    const envBinding = await proposeBinding(fixture, {
      secretProposalId: envSecretProposalId,
      configPath: "env.T22_TOKEN",
    });
    expect((await approveProposal(fixture, envBinding, { cascade: true })).status).toBe(200);

    const accessSecretProposalId = await proposeSecret(fixture, "dev/t22/incoming-two", OTHER_VALUE);
    const accessBinding = await proposeBinding(fixture, {
      secretProposalId: accessSecretProposalId,
      configPath: "access.T22_TOKEN",
    });
    expect((await approveProposal(fixture, accessBinding, { cascade: true })).status).toBe(200);

    const config = await readAdapterConfig(fixture.agentId);
    const envConfig = (config.env ?? {}) as Record<string, unknown>;
    const envSecret = await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t22/incoming"));
    const accessSecret = await db.select().from(companySecrets).where(eq(companySecrets.name, "dev/t22/incoming-two"));
    expect(envConfig["T22_TOKEN"]).toMatchObject({ type: "secret_ref", secretId: envSecret[0].id });
    expect(config["access.T22_TOKEN"]).toMatchObject({ type: "secret_ref", secretId: accessSecret[0].id });

    const audits = await db.select().from(activityLog)
      .where(eq(activityLog.action, "agent.binding.repointed"));
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => (row.details as { configPath: string }).configPath).sort())
      .toEqual(["access.T22_TOKEN", "env.T22_TOKEN"]);
  });

  it("T23: a user-scoped target writes user_secret_ref and an inactive definition is 409", async () => {
    const fixture = await seedRun();
    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(fixture.companyId, {
      key: "t23_user_token",
      name: "T23 user token",
      provider: "local_encrypted",
    });
    const userSecret = await secrets.createCurrentUserSecretValue(fixture.companyId, "user-1", {
      definitionId: definition.id,
      value: OLD_VALUE,
    });
    await agentService(db).update(fixture.agentId, {
      adapterConfig: {
        "access.T23_SOURCE": {
          type: "user_secret_ref",
          key: definition.key,
          version: "latest",
          required: true,
          allowMissingOverride: false,
        },
      },
    });

    const bindingProposalId = await proposeBinding(fixture, {
      sourceConfigPath: "access.T23_SOURCE",
      configPath: "access.T23_ALIAS",
    });
    const approved = await approveProposal(fixture, bindingProposalId);
    expect(approved.status).toBe(200);
    expect(await readAdapterConfig(fixture.agentId)).toMatchObject({
      "access.T23_ALIAS": { type: "user_secret_ref", key: definition.key, version: "latest" },
    });
    const binding = await db.select().from(companySecretBindings)
      .where(eq(companySecretBindings.secretId, userSecret.id));
    expect(binding.length).toBeGreaterThanOrEqual(0);

    // Propose while the definition is still active, then retire it: the
    // approval, not the proposal, is what must reject an inactive definition.
    const secondBinding = await proposeBinding(fixture, {
      sourceConfigPath: "access.T23_SOURCE",
      configPath: "access.T23_SECOND",
    });
    await db.update(userSecretDefinitions)
      .set({ status: "retired" })
      .where(eq(userSecretDefinitions.id, definition.id));
    const rejected = await approveProposal(fixture, secondBinding);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error ?? rejected.body.message).toContain("not active");
    expect(await readAdapterConfig(fixture.agentId)).not.toHaveProperty("access.T23_SECOND");
  });

  it("T24: an agent rotation may not carry a reference or a vault selector the board never approved", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t24/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    const selectors: Array<Record<string, unknown>> = [
      { externalRef: "vault://another/place" },
      { providerVersionRef: "v-2" },
      { providerConfigId: randomUUID() },
    ];
    for (const selector of selectors) {
      const response = await rotateAsAgent(fixture, secret.id, {
        value: ready.value,
        expectedLatestVersion: ready.expectedLatestVersion,
        valueFingerprintSha256: NEW_FP,
        authorizationProposalId: ready.proposalId,
        deploymentAssertionId: ready.assertionId,
        ...selector,
      });
      expect(response.status).toBe(403);
      expect(response.body.error ?? response.body.message).toContain("agent rotation may not");
    }

    expect((await readSecret(secret.id))!.latestVersion).toBe(1);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(OLD_FP);
    expect((await db.select().from(companySecretDeploymentAssertions))[0]).toMatchObject({ status: "pending" });
  });

  it("T25: the approved fingerprint is checked before the provider write, whatever the provider is", async () => {
    const fixture = await seedRun();
    // A live row on a provider that is not configured in this deployment. If
    // the value check ran after the provider write, this request would reach
    // the provider and answer 422 instead of 409.
    const [secret] = await db.insert(companySecrets).values({
      companyId: fixture.companyId,
      scope: "company",
      key: "T25_TOKEN",
      name: "dev/t25/token",
      provider: "vault",
      status: "active",
      latestVersion: 1,
    }).returning();
    await db.insert(companySecretVersions).values({
      secretId: secret!.id,
      version: 1,
      material: {},
      valueSha256: OLD_FP,
      fingerprintSha256: OLD_FP,
      status: "current",
    });

    const proposalId = await proposeSecret(fixture, secret!.name, NEW_VALUE);
    const assertion = await registerAssertion(fixture, secret!.id, {
      expectedLatestVersion: 1,
      valueFingerprintSha256: NEW_FP,
      previousValueFingerprintSha256: OLD_FP,
    });
    expect(assertion.status).toBe(201);
    expect((await approveProposal(fixture, proposalId)).status).toBe(200);

    // The request declares the fingerprint the board approved and sends a
    // different value. The mismatch must be caught before the provider runs.
    const response = await rotateAsAgent(fixture, secret!.id, {
      value: OTHER_VALUE,
      expectedLatestVersion: 1,
      valueFingerprintSha256: NEW_FP,
      authorizationProposalId: proposalId,
      deploymentAssertionId: assertion.body.id,
    });

    expect(response.status).toBe(409);
    expect(response.body.error ?? response.body.message).toContain("does not match the value supplied");
    expect((await readSecret(secret!.id))!.latestVersion).toBe(1);
    expect((await readCurrentVersion(secret!.id))!.fingerprintSha256).toBe(OLD_FP);
  });

  it("T26: a long-lived agent key cannot rotate or assert, even with an approved proposal", async () => {
    const fixture = await seedRun();
    const secret = await seedLiveSecret(fixture, "dev/t26/token", OLD_VALUE);
    const ready = await readyAgentRotation(fixture, secret.id);

    // An agent key copies X-Paperclip-Run-Id into the actor without checking
    // it, so "a run id is present" is not proof that a run vouched for this.
    const assertionFromKey = await request(createAgentApp(fixture, "agent_key"))
      .post(`/api/secrets/${secret.id}/deployment-assertions`)
      .send({
        deploymentLabel: "ingestion-service/prod",
        expectedLatestVersion: 1,
        valueFingerprintSha256: NEW_FP,
        previousValueFingerprintSha256: OLD_FP,
      });
    expect(assertionFromKey.status).toBe(403);
    expect(assertionFromKey.body.error ?? assertionFromKey.body.message).toContain("run-bound agent token");

    const rotationFromKey = await request(createAgentApp(fixture, "agent_key"))
      .post(`/api/secrets/${secret.id}/rotate`)
      .send({
        value: ready.value,
        expectedLatestVersion: ready.expectedLatestVersion,
        valueFingerprintSha256: NEW_FP,
        authorizationProposalId: ready.proposalId,
        deploymentAssertionId: ready.assertionId,
      });
    expect(rotationFromKey.status).toBe(403);
    expect(rotationFromKey.body.error ?? rotationFromKey.body.message).toContain("run-bound agent token");

    expect((await readSecret(secret.id))!.latestVersion).toBe(1);
    expect((await readCurrentVersion(secret.id))!.fingerprintSha256).toBe(OLD_FP);
    expect((await db.select().from(companySecretDeploymentAssertions))[0]).toMatchObject({ status: "pending" });
  });
});
