import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  assets,
  builtInManagedResources,
  companies,
  companyOnboardingSeeds,
  createDb,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueDocuments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  routineRuns,
  routines,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cloudControlMiddleware } from "../middleware/cloud-control.js";
import { BUILT_IN_AGENT_METADATA_KEY } from "../lib/built-in-agent-metadata.js";
import { cloudProductSummaryRoutes } from "../routes/cloud-product-summary.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";
import {
  CLOUD_PRODUCT_CAPABILITIES,
  CLOUD_RUN_FAILURE_CLASSES,
  buildCloudProductSummary,
  cloudProductSummaryQuerySchema,
  CLOUD_PRODUCT_SUMMARY_COUNT_CAP,
  CLOUD_PRODUCT_SUMMARY_TASK_WINDOW,
  cloudRunFailureClass,
  sharedCloudProductSummary,
} from "../services/cloud-product-summary.js";
import { PERSON_OWNED_FAILURE_CODES, RESTART_CLASS_FAILURE_CODES } from "../services/continuation-cause.js";
import {
  CLOUD_CONTROL_AUDIENCE,
  CLOUD_CONTROL_HEADER,
  CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  resetCloudControlReplayFenceForTests,
  type CloudControlAction,
} from "../services/cloud-runtime-identity.js";

const STACK_ID = "stack-product-summary-test";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ago(ms: number) {
  return new Date(NOW.getTime() - ms);
}

const support = await getEmbeddedPostgresTestSupport();

describe("cloudRunFailureClass", () => {
  it.each([
    ["operator_cancelled", "stopped"],
    ["issue_paused", "stopped"],
    ["github_auth_required", "missing_access"],
    ["user_secret_missing", "missing_access"],
    ["provider_quota", "provider_limit"],
    ["native_provider_usage_limit", "provider_limit"],
    ["budget_hard_stop", "waiting_on_person"],
    ["approval_required", "waiting_on_person"],
    ["adapter_failed", "execution_failure"],
    ["process_lost", "execution_failure"],
    ["a_code_added_later", "other"],
    ["", "other"],
    [null, "other"],
    [undefined, "other"],
  ])("maps %s to %s", (errorCode, failureClass) => {
    expect(cloudRunFailureClass(errorCode)).toBe(failureClass);
  });

  it("gives each person-owned code a customer-side class", () => {
    const customerSide = ["stopped", "missing_access", "provider_limit", "waiting_on_person"];
    for (const code of PERSON_OWNED_FAILURE_CODES) expect([code, customerSide.includes(cloudRunFailureClass(code))]).toEqual([code, true]);
  });

  it("gives each restart code the execution failure class", () => {
    for (const code of RESTART_CLASS_FAILURE_CODES) expect([code, cloudRunFailureClass(code)]).toEqual([code, "execution_failure"]);
  });

  it("returns only listed classes", () => {
    const classes: readonly string[] = CLOUD_RUN_FAILURE_CLASSES;
    for (const code of [...PERSON_OWNED_FAILURE_CODES, ...RESTART_CLASS_FAILURE_CODES, "timeout", "unknown"]) {
      expect(classes).toContain(cloudRunFailureClass(code));
    }
  });
});

describe("cloudProductSummaryQuerySchema", () => {
  it.each(["2026-11-20T17:00:00Z", "2026-11-20T17:00Z", "2026-11-20T18:00:00+01:00", "2026-11-20T17:00:00.250Z"])(
    "accepts the time %s",
    (since) => {
      expect(cloudProductSummaryQuerySchema.safeParse({ since }).success).toBe(true);
    },
  );

  it.each(["2026-11-20", "2026-11-20T17:00:00", "2026-13-45T17:00:00Z", "yesterday", "1768478400", ""])(
    "refuses the value %s",
    (since) => {
      expect(cloudProductSummaryQuerySchema.safeParse({ since }).success).toBe(false);
    },
  );

  it("accepts a request with no time", () => {
    expect(cloudProductSummaryQuerySchema.safeParse({}).success).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("cloud product summary", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_CLOUD_STACK_ID", "PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", "PAPERCLIP_MANAGED_CONFIG"];

  const pair = generateKeyPairSync("ed25519");
  const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "product-summary-test-key", use: "sig", alg: "EdDSA" };
  let requestCounter = 0;

  function encodeJson(value: Record<string, unknown>) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }

  function assertion(action: CloudControlAction) {
    const iat = Math.floor(Date.now() / 1000);
    const header = encodeJson({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid: publicJwk.kid });
    const payload = encodeJson({
      v: 1,
      iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
      aud: CLOUD_CONTROL_AUDIENCE,
      sub: STACK_ID,
      action,
      requestId: `product-summary-req-${(requestCounter += 1)}`,
      iat,
      exp: iat + 60,
    });
    const signature = sign(null, Buffer.from(`${header}.${payload}`, "ascii"), pair.privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  function createApp() {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.use(cloudControlMiddleware());
    app.use(cloudProductSummaryRoutes(db));
    return app;
  }

  async function createCompany(id: string = randomUUID()) {
    await db.insert(companies).values({ id, name: "Private company name", issuePrefix: `S${id.slice(0, 6)}` });
    return id;
  }

  async function createAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "Private agent name", role: "engineer", adapterType: "claude_local", ...overrides });
    return id;
  }

  async function createIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Private task title", ...overrides });
    return id;
  }

  async function createRun(companyId: string, agentId: string, endedAt: Date, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      createdAt: new Date(endedAt.getTime() - 90_000),
      startedAt: new Date(endedAt.getTime() - 90_000),
      finishedAt: endedAt,
      ...overrides,
    });
  }

  async function createConnection(companyId: string, applicationId: string, overrides: Partial<typeof toolConnections.$inferInsert>) {
    await db.insert(toolConnections).values({
      companyId,
      applicationId,
      name: "Private connection name",
      uid: randomUUID(),
      transport: overrides.connectionPurpose === "ai" ? "runtime_auth" : "mcp_remote",
      status: "active",
      enabled: true,
      ...overrides,
    });
  }

  async function createDocument(companyId: string, issueId: string, key: string, createdAt: Date) {
    const documentId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Private document body" });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key, createdAt });
  }

  async function seedOrganization(companyId: string) {
    const builtInAgentId = await createAgent(companyId, {
      metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "assistant", featureKeys: ["assistant"] } },
      createdAt: ago(40 * DAY),
    });
    const seedAgentId = await createAgent(companyId, { createdAt: ago(39 * DAY) });
    await createAgent(companyId, { status: "pending_approval", createdAt: ago(38 * DAY) });
    const firstAgentId = await createAgent(companyId, { createdAt: ago(20 * DAY) });
    await createAgent(companyId, { createdAt: ago(6 * DAY) });

    const [application] = await db
      .insert(toolApplications)
      .values({ companyId, name: "Private application name", type: "mcp_http" })
      .returning({ id: toolApplications.id });
    const applicationId = application!.id;
    await createConnection(companyId, applicationId, { connectionPurpose: "ai", config: { ai: { provider: "anthropic" } }, createdAt: ago(30 * DAY) });
    await createConnection(companyId, applicationId, { connectionPurpose: "ai", config: { ai: { provider: "Private provider" } }, createdAt: ago(29 * DAY) });
    await createConnection(companyId, applicationId, { connectionPurpose: "ai", status: "draft", config: { ai: { provider: "openai" } }, createdAt: ago(35 * DAY) });
    await createConnection(companyId, applicationId, { connectionPurpose: "tool", config: { sourceTemplateKey: "slack" }, createdAt: ago(5 * DAY) });
    await createConnection(companyId, applicationId, { connectionPurpose: "tool", config: { sourceTemplateKey: "Private customer server" }, createdAt: ago(4 * DAY) });
    await createConnection(companyId, applicationId, { connectionPurpose: "tool", status: "draft", config: { sourceTemplateKey: "notion" }, createdAt: ago(36 * DAY) });

    const routineId = randomUUID();
    const builtInRoutineId = randomUUID();
    await db.insert(routines).values([
      { id: routineId, companyId, title: "Private routine title", createdAt: ago(8 * DAY) },
      { id: builtInRoutineId, companyId, title: "Built-in routine", originKind: "built_in_agent_bundle", createdAt: ago(40 * DAY) },
    ]);
    const managedRoutineId = randomUUID();
    await db.insert(routines).values({ id: managedRoutineId, companyId, title: "Managed routine", createdAt: ago(40 * DAY) });
    await db.insert(builtInManagedResources).values({
      companyId,
      bundleKey: "assistant",
      resourceKind: "routine",
      resourceKey: "daily",
      resourceId: managedRoutineId,
      stockVersion: "1",
      stockHash: "hash",
    });
    await db.insert(routineRuns).values([
      { companyId, routineId, source: "schedule", status: "completed", triggeredAt: ago(3 * DAY) },
      { companyId, routineId, source: "schedule", status: "issue_created", triggeredAt: ago(10 * DAY) },
      { companyId, routineId, source: "schedule", status: "received", triggeredAt: ago(12 * DAY) },
      { companyId, routineId: builtInRoutineId, source: "schedule", status: "completed", triggeredAt: ago(30 * DAY) },
      { companyId, routineId: managedRoutineId, source: "schedule", status: "completed", triggeredAt: ago(30 * DAY) },
    ]);

    const onboardingIssueId = await createIssue(companyId, { originKind: "onboarding_first_task", status: "done", completedAt: ago(19 * DAY) });
    const seededIssueId = await createIssue(companyId, { originKind: "manual", status: "done", completedAt: ago(21 * DAY) });
    await db.insert(companyOnboardingSeeds).values({ companyId, revision: "1", agentId: seedAgentId, issueId: seededIssueId });
    const ownIssueId = await createIssue(companyId, { originKind: "manual", status: "done", completedAt: ago(2 * DAY) });
    await createIssue(companyId, { originKind: "manual", status: "done", completedAt: ago(15 * DAY) });
    await createIssue(companyId, { originKind: "manual", parentId: ownIssueId, status: "done", completedAt: ago(25 * DAY) });
    await createIssue(companyId, { originKind: "routine_execution", originId: routineId, status: "done", completedAt: ago(3 * DAY) });
    await createIssue(companyId, { originKind: "routine_execution", originId: builtInRoutineId, status: "done", completedAt: ago(30 * DAY) });
    await createIssue(companyId, { originKind: "manual", status: "in_progress" });
    await createIssue(companyId, { originKind: "manual", status: "blocked", blockedTransitionAt: ago(30 * HOUR) });
    await createIssue(companyId, { originKind: "manual", status: "blocked", blockedTransitionAt: ago(2 * HOUR) });

    await createDocument(companyId, ownIssueId, "plan", ago(7 * DAY));
    await createDocument(companyId, ownIssueId, "notes", ago(9 * DAY));
    await createDocument(companyId, onboardingIssueId, "continuation-summary", ago(18 * DAY));
    await db.insert(issueThreadInteractions).values([
      {
        companyId,
        issueId: ownIssueId,
        kind: "request_confirmation",
        status: "accepted",
        resolvedAt: ago(6 * DAY),
        resolvedByUserId: "user-owner",
        title: "Private confirmation title",
        payload: { target: { type: "issue_document", key: "plan", revisionId: "rev-1" } } as never,
        result: { outcome: "accepted" } as never,
      },
      {
        companyId,
        issueId: ownIssueId,
        kind: "request_confirmation",
        status: "accepted",
        resolvedAt: ago(16 * DAY),
        payload: { target: { type: "issue_document", key: "notes", revisionId: "rev-1" } } as never,
        result: { outcome: "accepted" } as never,
      },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: ownIssueId,
      type: "pull_request",
      provider: "github",
      title: "Private work product title",
      status: "active",
      createdAt: ago(1 * DAY),
    });
    const [asset] = await db
      .insert(assets)
      .values({ companyId, provider: "local_disk", objectKey: "private/object/key", contentType: "application/pdf", byteSize: 10, sha256: "0".repeat(64) })
      .returning({ id: assets.id });
    await db.insert(issueAttachments).values({ companyId, issueId: ownIssueId, assetId: asset!.id, createdAt: ago(11 * DAY) });

    await createRun(companyId, firstAgentId, ago(2 * HOUR));
    await createRun(companyId, firstAgentId, ago(1 * HOUR), { status: "failed", errorCode: "provider_quota", error: "Private error text" });
    await createRun(companyId, firstAgentId, ago(3 * HOUR), { status: "timed_out", errorCode: "timeout" });
    await createRun(companyId, firstAgentId, ago(3 * DAY), { status: "failed", errorCode: "Private failure sentence" });
    await createRun(companyId, firstAgentId, ago(4 * DAY), { status: "interrupted", errorCode: "operator_interrupted" });
    await createRun(companyId, firstAgentId, ago(5 * DAY));
    await createRun(companyId, firstAgentId, ago(10 * DAY), { status: "failed", errorCode: "adapter_failed" });
    await createRun(companyId, builtInAgentId, ago(30 * 60 * 1000), { status: "failed", errorCode: "adapter_failed" });
    await createRun(companyId, firstAgentId, ago(10 * 60 * 1000), { status: "running", finishedAt: null });

    await db.insert(activityLog).values([
      { companyId, actorType: "user", actorId: "user-owner", action: "issue.created", entityType: "issue", entityId: ownIssueId, createdAt: ago(30 * 60 * 1000) },
      { companyId, actorType: "agent", actorId: firstAgentId, action: "issue.updated", entityType: "issue", entityId: ownIssueId, createdAt: ago(5 * 60 * 1000) },
    ]);
  }

  function iso(ms: number) {
    return ago(ms).toISOString();
  }

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-cloud-product-summary-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key];
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    process.env.PAPERCLIP_CLOUD_STACK_ID = STACK_ID;
    process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = JSON.stringify({ keys: [publicJwk] });
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    resetCloudControlReplayFenceForTests();
  });

  afterEach(async () => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE companies CASCADE`);
    });
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  it("reports no and zero for an organization that has done nothing, when another organization has done each thing", async () => {
    const companyId = await createCompany();
    await seedOrganization(await createCompany());

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.version).toBe(1);
    expect(summary.generatedAt).toBe(NOW.toISOString());
    expect(summary.since).toBeNull();
    expect(Object.keys(summary.capabilities).sort()).toEqual([...CLOUD_PRODUCT_CAPABILITIES].sort());
    for (const key of CLOUD_PRODUCT_CAPABILITIES) {
      expect([key, summary.capabilities[key]]).toEqual([key, { state: "no", firstAt: null, beforeSince: false }]);
    }
    const emptyWindow = { succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, failuresByClass: {} };
    expect(summary.runs).toEqual({ state: "ok", day: emptyWindow, week: emptyWindow, recent: [] });
    expect(summary.waiting).toEqual({ state: "ok", blockedTasks: 0, oldestBlockedAt: null });
    expect(summary.activity).toEqual({
      state: "ok",
      lastPersonActivityAt: null,
      tasksCompletedWeek: 0,
      tasksCompletedMonth: 0,
      routineRunsWeek: 0,
      routineRunsMonth: 0,
    });
    expect(summary.setup).toEqual({ state: "ok", modelProviders: [], connectors: [] });
  });

  it("reports each capability with the date it first happened, and leaves built-in and seeded work out", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    const otherCompanyId = await createCompany();
    await seedOrganization(otherCompanyId);

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    const yes = (ms: number) => ({ state: "yes", firstAt: iso(ms), beforeSince: false });
    expect(summary.capabilities).toEqual({
      modelConnected: yes(30 * DAY),
      connectorSetUp: yes(5 * DAY),
      agentCreated: yes(20 * DAY),
      secondAgentCreated: yes(6 * DAY),
      planCreated: yes(7 * DAY),
      planApproved: yes(6 * DAY),
      onboardingTaskCompleted: yes(21 * DAY),
      ownTaskCompleted: yes(15 * DAY),
      routineTaskCompleted: yes(3 * DAY),
      artifactCreated: yes(11 * DAY),
      routineCreated: yes(8 * DAY),
      routineRun: yes(10 * DAY),
    });
  });

  it("counts recent runs by result and cause, and never returns an error code or message", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.runs.state).toBe("ok");
    expect(summary.runs.day).toEqual({
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      timedOut: 1,
      failuresByClass: { provider_limit: 1, execution_failure: 1 },
    });
    expect(summary.runs.week).toEqual({
      succeeded: 2,
      failed: 2,
      cancelled: 1,
      timedOut: 1,
      failuresByClass: { provider_limit: 1, execution_failure: 1, other: 1, stopped: 1 },
    });
    expect(summary.runs.recent).toEqual([
      { outcome: "failed", failureClass: "provider_limit", endedAt: iso(1 * HOUR) },
      { outcome: "succeeded", failureClass: null, endedAt: iso(2 * HOUR) },
      { outcome: "timed_out", failureClass: "execution_failure", endedAt: iso(3 * HOUR) },
      { outcome: "failed", failureClass: "other", endedAt: iso(3 * DAY) },
      { outcome: "cancelled", failureClass: "stopped", endedAt: iso(4 * DAY) },
      { outcome: "succeeded", failureClass: null, endedAt: iso(5 * DAY) },
    ]);
  });

  it("reports waiting tasks, recent activity, and setup from closed lists", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.waiting).toEqual({ state: "ok", blockedTasks: 2, oldestBlockedAt: iso(30 * HOUR) });
    expect(summary.activity).toEqual({
      state: "ok",
      lastPersonActivityAt: iso(30 * 60 * 1000),
      tasksCompletedWeek: 2,
      tasksCompletedMonth: 6,
      routineRunsWeek: 1,
      routineRunsMonth: 2,
    });
    expect(summary.setup).toEqual({ state: "ok", modelProviders: ["anthropic"], connectors: ["custom", "slack"] });
  });

  it("leaves a connection that is not active out of the setup lists", async () => {
    const companyId = await createCompany();
    const [application] = await db
      .insert(toolApplications)
      .values({ companyId, name: "Private application name", type: "mcp_http" })
      .returning({ id: toolApplications.id });
    await createConnection(companyId, application!.id, { connectionPurpose: "tool", status: "disabled", config: { sourceTemplateKey: "slack" } });
    await createConnection(companyId, application!.id, { connectionPurpose: "tool", status: "archived", config: { sourceTemplateKey: "github" } });

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.capabilities.connectorSetUp.state).toBe("yes");
    expect(summary.setup).toEqual({ state: "ok", modelProviders: [], connectors: [] });
  });

  async function createTasks(companyId: string, total: number, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const tasks = Array.from({ length: total }, (_, index) => ({
      id: randomUUID(),
      companyId,
      title: "Private task title",
      status: "todo",
      originKind: "manual",
      createdAt: new Date(ago(60 * DAY).getTime() + index * 1000),
      ...overrides,
    }));
    for (let start = 0; start < tasks.length; start += 500) {
      await db.insert(issues).values(tasks.slice(start, start + 500));
    }
    return tasks;
  }

  it("reads only the oldest and the newest tasks of a large organization, and reports unknown for what it did not find", async () => {
    const companyId = await createCompany();
    const filler = await createTasks(companyId, CLOUD_PRODUCT_SUMMARY_TASK_WINDOW * 2 + 50);
    await createDocument(companyId, filler[0]!.id, "notes", ago(50 * DAY));
    await createDocument(companyId, filler[CLOUD_PRODUCT_SUMMARY_TASK_WINDOW + 10]!.id, "plan", ago(55 * DAY));
    await createDocument(companyId, filler[CLOUD_PRODUCT_SUMMARY_TASK_WINDOW * 2 + 10]!.id, "plan", ago(49 * DAY));
    await db.update(issues).set({ status: "done", completedAt: ago(2 * HOUR) }).where(eq(issues.id, filler[3]!.id));
    await createIssue(companyId, { status: "done", originKind: "manual", createdAt: ago(10 * DAY), completedAt: ago(5 * DAY) });

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    const unknown = { state: "unknown", firstAt: null, beforeSince: false };
    expect(summary.capabilities.ownTaskCompleted).toEqual({ state: "yes", firstAt: iso(5 * DAY), beforeSince: false });
    expect(summary.capabilities.artifactCreated).toEqual({ state: "yes", firstAt: iso(50 * DAY), beforeSince: false });
    expect(summary.capabilities.planCreated).toEqual({ state: "yes", firstAt: iso(49 * DAY), beforeSince: false });
    expect(summary.capabilities.planApproved).toEqual(unknown);
    expect(summary.capabilities.routineTaskCompleted).toEqual(unknown);
    expect(summary.capabilities.onboardingTaskCompleted).toEqual({ state: "no", firstAt: null, beforeSince: false });
    expect(summary.activity.tasksCompletedWeek).toBe(2);
  });

  it("gives an exact no when the two task windows cover each task", async () => {
    const no = { state: "no", firstAt: null, beforeSince: false };
    const oneWindow = await createCompany();
    await createTasks(oneWindow, CLOUD_PRODUCT_SUMMARY_TASK_WINDOW);
    const twoWindows = await createCompany();
    await createTasks(twoWindows, CLOUD_PRODUCT_SUMMARY_TASK_WINDOW * 2);

    for (const companyId of [oneWindow, twoWindows]) {
      const summary = await buildCloudProductSummary(db, { companyId, now: NOW });
      expect(summary.capabilities.ownTaskCompleted).toEqual(no);
      expect(summary.capabilities.routineTaskCompleted).toEqual(no);
      expect(summary.capabilities.planCreated).toEqual(no);
      expect(summary.capabilities.planApproved).toEqual(no);
      expect(summary.capabilities.artifactCreated).toEqual(no);
    }
  });

  it("reads each task once when many tasks have the same creation time", async () => {
    const companyId = await createCompany();
    const tasks = await createTasks(companyId, CLOUD_PRODUCT_SUMMARY_TASK_WINDOW * 2, { createdAt: ago(30 * DAY) });
    const ordered = tasks.map((task) => task.id).sort();
    for (const [index, id] of [ordered[CLOUD_PRODUCT_SUMMARY_TASK_WINDOW - 1]!, ordered[CLOUD_PRODUCT_SUMMARY_TASK_WINDOW]!].entries()) {
      await db.update(issues).set({ status: "done", completedAt: ago((index + 1) * DAY) }).where(eq(issues.id, id));
      await createDocument(companyId, id, index === 0 ? "plan" : "notes", ago((index + 3) * DAY));
    }

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.capabilities.ownTaskCompleted).toEqual({ state: "yes", firstAt: iso(2 * DAY), beforeSince: false });
    expect(summary.capabilities.planCreated).toEqual({ state: "yes", firstAt: iso(3 * DAY), beforeSince: false });
    expect(summary.capabilities.artifactCreated).toEqual({ state: "yes", firstAt: iso(4 * DAY), beforeSince: false });
    expect(summary.capabilities.planApproved).toEqual({ state: "no", firstAt: null, beforeSince: false });
  });

  it("returns no oldest blocked time when more tasks are blocked than the count cap", async () => {
    const companyId = await createCompany();
    await createTasks(companyId, CLOUD_PRODUCT_SUMMARY_COUNT_CAP + 1, { status: "blocked", blockedTransitionAt: ago(3 * DAY) });

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.waiting).toEqual({ state: "ok", blockedTasks: CLOUD_PRODUCT_SUMMARY_COUNT_CAP, oldestBlockedAt: null });
  });

  it("reports unknown for a section that cannot get a database connection in time, and reads the next sections", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    let transactions = 0;
    const busy = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: Parameters<typeof db.transaction>[0], config: Parameters<typeof db.transaction>[1]) => {
          transactions += 1;
          return transactions === 4 ? new Promise(() => {}) : target.transaction(run, config);
        };
      },
    }) as typeof db;
    const startedAt = Date.now();

    const summary = await buildCloudProductSummary(busy, { companyId, now: NOW, sectionTimeoutMs: 200 });

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(transactions).toBe(10);
    expect(summary.runs.state).toBe("unknown");
    expect(summary.waiting.state).toBe("ok");
    expect(summary.capabilities.ownTaskCompleted.state).toBe("yes");
  });

  it("stops each run count at the cap, and keeps the day and the week apart", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    const run = (endedAt: Date) => ({
      companyId,
      agentId,
      status: "succeeded",
      createdAt: new Date(endedAt.getTime() - 90_000),
      startedAt: new Date(endedAt.getTime() - 90_000),
      finishedAt: endedAt,
    });
    const today = Array.from({ length: CLOUD_PRODUCT_SUMMARY_COUNT_CAP + 40 }, () => run(ago(2 * HOUR)));
    for (let start = 0; start < today.length; start += 1000) {
      await db.insert(heartbeatRuns).values(today.slice(start, start + 1000));
    }
    await createRun(companyId, agentId, ago(3 * DAY), { status: "failed", errorCode: "adapter_failed" });
    await createRun(companyId, agentId, ago(HOUR), { status: "failed", errorCode: "adapter_failed" });
    await createRun(companyId, agentId, ago(5 * 60 * 1000), {
      status: "timed_out",
      createdAt: ago(6 * DAY),
      startedAt: ago(6 * DAY),
    });

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW });

    expect(summary.runs.state).toBe("ok");
    expect(summary.runs.day.succeeded).toBe(CLOUD_PRODUCT_SUMMARY_COUNT_CAP);
    expect(summary.runs.week.succeeded).toBe(CLOUD_PRODUCT_SUMMARY_COUNT_CAP);
    expect(summary.runs.day.failed).toBe(1);
    expect(summary.runs.week.failed).toBe(2);
    expect(summary.runs.day.timedOut).toBe(1);
    expect(summary.runs.recent).toHaveLength(20);
    expect(summary.runs.recent[0]).toEqual({ outcome: "timed_out", failureClass: "other", endedAt: iso(5 * 60 * 1000) });
    expect(summary.runs.recent[1]).toEqual({ outcome: "failed", failureClass: "execution_failure", endedAt: iso(HOUR) });
  });

  it("counts a run that started long ago and finished after the since time", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    await createRun(companyId, agentId, ago(5 * 60 * 1000), {
      status: "failed",
      errorCode: "adapter_failed",
      createdAt: ago(6 * DAY),
      startedAt: ago(6 * DAY),
    });
    await createRun(companyId, agentId, ago(2 * HOUR));

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW, since: ago(HOUR) });

    const counted = { succeeded: 0, failed: 1, cancelled: 0, timedOut: 0, failuresByClass: { execution_failure: 1 } };
    expect(summary.runs.day).toEqual(counted);
    expect(summary.runs.week).toEqual(counted);
    expect(summary.runs.recent).toEqual([{ outcome: "failed", failureClass: "execution_failure", endedAt: iso(5 * 60 * 1000) }]);
  });

  it("cancels a statement that runs past the section time limit, and reads the next sections", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    let transactions = 0;
    let cancelled: unknown = null;
    const slow = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: Parameters<typeof db.transaction>[0], config: Parameters<typeof db.transaction>[1]) => {
          transactions += 1;
          if (transactions !== 4) return target.transaction(run, config);
          return target.transaction(async (tx) => {
            let statements = 0;
            const sleepy = new Proxy(tx, {
              get(inner, key, innerReceiver) {
                if (key !== "execute") return Reflect.get(inner, key, innerReceiver);
                return async (query: Parameters<typeof tx.execute>[0]) => {
                  statements += 1;
                  if (statements === 2) {
                    try {
                      await inner.execute(sql`select pg_sleep(5)`);
                    } catch (err) {
                      cancelled = err;
                      throw err;
                    }
                  }
                  return inner.execute(query);
                };
              },
            }) as typeof tx;
            return run(sleepy);
          }, config);
        };
      },
    }) as typeof db;
    const startedAt = Date.now();

    const summary = await buildCloudProductSummary(slow, { companyId, now: NOW, sectionTimeoutMs: 300 });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(JSON.stringify([cancelled, (cancelled as { cause?: unknown } | null)?.cause])).toContain("57014");
    expect(summary.runs.state).toBe("unknown");
    expect(summary.setup.state).toBe("ok");
    expect(summary.waiting.state).toBe("ok");
    expect(summary.capabilities.ownTaskCompleted.state).toBe("yes");
  });

  it("returns no text that a customer wrote", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);

    const body = JSON.stringify(await buildCloudProductSummary(db, { companyId, now: NOW }));

    expect(body).not.toMatch(/Private|private|user-owner|rev-1|github/);
    expect(body).not.toContain(companyId);
  });

  it("returns no date and no count from before the since time", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    const since = ago(7 * DAY - HOUR);

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW, since });

    const before = { state: "yes", firstAt: null, beforeSince: true };
    const yes = (ms: number) => ({ state: "yes", firstAt: iso(ms), beforeSince: false });
    expect(summary.since).toBe(since.toISOString());
    expect(summary.capabilities).toEqual({
      modelConnected: before,
      connectorSetUp: yes(5 * DAY),
      agentCreated: before,
      secondAgentCreated: yes(6 * DAY),
      planCreated: before,
      planApproved: yes(6 * DAY),
      onboardingTaskCompleted: before,
      ownTaskCompleted: before,
      routineTaskCompleted: yes(3 * DAY),
      artifactCreated: before,
      routineCreated: before,
      routineRun: before,
    });
    expect(summary.activity.tasksCompletedMonth).toBe(2);
    expect(summary.activity.routineRunsMonth).toBe(1);

    const recentSince = ago(2 * DAY);
    const recent = await buildCloudProductSummary(db, { companyId, now: NOW, since: recentSince });
    expect(recent.runs.week).toEqual(recent.runs.day);
    expect(recent.runs.recent.every((run) => run.endedAt >= recentSince.toISOString())).toBe(true);
    expect(recent.runs.recent).toHaveLength(3);
    expect(recent.waiting).toEqual({ state: "ok", blockedTasks: 2, oldestBlockedAt: iso(30 * HOUR) });

    const latest = await buildCloudProductSummary(db, { companyId, now: NOW, since: ago(HOUR) });
    expect(latest.waiting).toEqual({ state: "ok", blockedTasks: 2, oldestBlockedAt: null });
    expect(JSON.stringify(latest)).not.toContain(iso(30 * HOUR));
  });

  it("reports unknown, never no or a date, when the time budget is used up", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);

    const summary = await buildCloudProductSummary(db, { companyId, now: NOW, budgetMs: 0 });

    for (const key of CLOUD_PRODUCT_CAPABILITIES) {
      expect([key, summary.capabilities[key]]).toEqual([key, { state: "unknown", firstAt: null, beforeSince: false }]);
    }
    expect(summary.runs.state).toBe("unknown");
    expect(summary.waiting.state).toBe("unknown");
    expect(summary.activity.state).toBe("unknown");
    expect(summary.setup.state).toBe("unknown");
  });

  it("keeps the other sections when one section fails, and reads in read-only transactions", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    const modes: unknown[] = [];
    let calls = 0;
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: Parameters<typeof db.transaction>[0], config: Parameters<typeof db.transaction>[1]) => {
          calls += 1;
          modes.push(config?.accessMode);
          if (calls === 4 || calls === 7) return Promise.reject(new Error("section failed"));
          return target.transaction(run, config);
        };
      },
    }) as typeof db;

    const summary = await buildCloudProductSummary(failing, { companyId, now: NOW });

    expect(calls).toBe(10);
    expect(modes.every((mode) => mode === "read only")).toBe(true);
    const unknown = { state: "unknown", firstAt: null, beforeSince: false };
    expect(summary.capabilities.onboardingTaskCompleted).toEqual(unknown);
    expect(summary.capabilities.ownTaskCompleted).toEqual(unknown);
    expect(summary.capabilities.routineTaskCompleted).toEqual(unknown);
    expect(summary.capabilities.modelConnected.state).toBe("yes");
    expect(summary.capabilities.artifactCreated.state).toBe("yes");
    expect(summary.capabilities.routineRun.state).toBe("yes");
    expect(summary.runs).toEqual({
      state: "unknown",
      day: { succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, failuresByClass: {} },
      week: { succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, failuresByClass: {} },
      recent: [],
    });
    expect(summary.waiting.state).toBe("ok");
    expect(summary.setup.state).toBe("ok");
  });

  it("stops a section that passes its deadline between statements, and keeps the sections before it", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    let time = 0;
    let transactions = 0;
    const slow = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: Parameters<typeof db.transaction>[0], config: Parameters<typeof db.transaction>[1]) => {
          transactions += 1;
          const index = transactions;
          return target.transaction(async (tx) => {
            if (index === 7) time += 5_000;
            return run(tx);
          }, config);
        };
      },
    }) as typeof db;

    const summary = await buildCloudProductSummary(slow, { companyId, now: NOW, clock: () => time, sectionTimeoutMs: 2_000, budgetMs: 6_000 });

    expect(summary.capabilities.modelConnected.state).toBe("yes");
    expect(summary.capabilities.planCreated.state).toBe("yes");
    expect(summary.capabilities.ownTaskCompleted.state).toBe("unknown");
    expect(summary.capabilities.artifactCreated.state).toBe("yes");
    expect(summary.runs.state).toBe("ok");
  });

  it("shares one computation between two requests for the same summary", async () => {
    const companyId = await createCompany();
    await seedOrganization(companyId);
    let transactions = 0;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: Parameters<typeof db.transaction>[0], config: Parameters<typeof db.transaction>[1]) => {
          transactions += 1;
          return target.transaction(run, config);
        };
      },
    }) as typeof db;

    const [first, second] = await Promise.all([
      sharedCloudProductSummary(counting, { companyId, now: NOW }),
      sharedCloudProductSummary(counting, { companyId, now: NOW }),
    ]);

    expect(second).toBe(first);
    expect(transactions).toBe(10);
    await sharedCloudProductSummary(counting, { companyId, now: NOW });
    expect(transactions).toBe(20);
  });

  it("cannot write, because each section runs in a read-only transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into companies (id, name, issue_prefix) values (${randomUUID()}, 'x', 'XWRITE')`);
      }, { accessMode: "read only" }),
    ).rejects.toThrow();
  });

  it("serves the summary only to a signed Cloud read, for the primary company only", async () => {
    const companyId = await createCompany(cloudTenantPrimaryCompanyId(STACK_ID));
    await createAgent(companyId, { createdAt: ago(2 * DAY) });
    const otherCompanyId = await createCompany();
    await seedOrganization(otherCompanyId);
    const app = createApp();
    const path = "/api/instance/product-summary";

    expect((await request(app).get(path)).status).toBe(403);
    expect((await request(app).get(path).set(CLOUD_CONTROL_HEADER, assertion("lifecycle:read"))).status).toBe(401);
    expect((await request(app).get(`${path}?since=yesterday`).set(CLOUD_CONTROL_HEADER, assertion("product-summary:read"))).status).toBe(400);
    expect((await request(app).get(`${path}?since=2026-11-01`).set(CLOUD_CONTROL_HEADER, assertion("product-summary:read"))).status).toBe(400);

    const response = await request(app).get(path).set(CLOUD_CONTROL_HEADER, assertion("product-summary:read"));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.version).toBe(1);
    expect(response.body.since).toBeNull();
    expect(response.body.capabilities.agentCreated.state).toBe("yes");
    expect(response.body.capabilities.modelConnected.state).toBe("no");
    expect(response.body.capabilities.routineRun.state).toBe("no");

    const since = "2026-01-01T00:00:00Z";
    const bounded = await request(app).get(`${path}?since=${encodeURIComponent(since)}`).set(CLOUD_CONTROL_HEADER, assertion("product-summary:read"));
    expect(bounded.status).toBe(200);
    expect(bounded.body.since).toBe("2026-01-01T00:00:00.000Z");
  });
});
