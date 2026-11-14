import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, cloudProductEvents, companies, companyOnboardingSeeds, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cloudControlMiddleware } from "../middleware/cloud-control.js";
import { BUILT_IN_AGENT_METADATA_KEY } from "../lib/built-in-agent-metadata.js";
import { logger } from "../middleware/logger.js";
import { cloudProductEventRoutes } from "../routes/cloud-product-events.js";
import { logActivity } from "../services/activity-log.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";
import {
  CLOUD_PRODUCT_EVENT_NAMES,
  CLOUD_PRODUCT_EVENT_START_CURSOR,
  CLOUD_RUN_FAILURE_CLASSES,
  DIRECT_CLOUD_PRODUCT_EVENT_NAMES,
  cloudRunFailureClass,
  draftCloudProductEvent,
  hasCloudProductEvent,
  listCloudProductEvents,
  recordAgentFirstRunCloudProductEvent,
  recordCloudProductEvent,
  recordConnectorUsedCloudProductEvent,
  recordDirectCloudProductEvent,
  recordRunFinishedCloudProductEvent,
  resetCloudProductEventConnectorUseGuardForTests,
  resetCloudProductEventPruneClockForTests,
  type CloudProductEventConnectorUse,
  type CloudProductEventSource,
  type DirectCloudProductEvent,
} from "../services/cloud-product-events.js";
import { PERSON_OWNED_FAILURE_CODES, RESTART_CLASS_FAILURE_CODES } from "../services/continuation-cause.js";
import {
  CLOUD_CONTROL_AUDIENCE,
  CLOUD_CONTROL_HEADER,
  CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  resetCloudControlReplayFenceForTests,
  type CloudControlAction,
} from "../services/cloud-runtime-identity.js";

const STACK_ID = "stack-product-events-test";
const CLOUD_ENV = { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token" };
const SELF_HOSTED_ENV = {};

function source(overrides: Partial<CloudProductEventSource> = {}): CloudProductEventSource {
  return {
    companyId: randomUUID(),
    actorType: "user",
    actorId: "user-1",
    action: "routine.created",
    entityType: "routine",
    entityId: randomUUID(),
    details: {},
    ...overrides,
  };
}

describe("draftCloudProductEvent", () => {
  it.each([
    ["ai_connection.connected", { provider: "anthropic", method: "api_key", grantId: "g-1" }, "ai_provider.connected", { provider: "anthropic", method: "api_key" }],
    ["agent.created", { name: "Ada", role: "engineer" }, "agent.created", { role: "engineer", source: "direct" }],
    ["agent.hire_created", { name: "Ada", role: "cto" }, "agent.created", { role: "cto", source: "hire" }],
    ["issue.document_created", { key: "plan", title: "Launch plan" }, "plan.created", {}],
    ["issue.document_created", { key: "notes", title: "Notes" }, "artifact.created", { kind: "document" }],
    ["issue.work_product_created", { type: "pull_request", provider: "github" }, "artifact.created", { kind: "work_product", type: "pull_request" }],
    ["issue.attachment_added", { originalFilename: "Q3 numbers.xlsx", contentType: "application/pdf" }, "artifact.created", { kind: "attachment" }],
    ["routine.created", { title: "Weekly digest" }, "routine.created", {}],
    ["tool_connection.created", { transport: "mcp_remote", status: "active", enabled: true }, "connector.connected", { transport: "mcp_remote", status: "active" }],
    ["project.created", { name: "Website" }, "project.created", {}],
    ["goal.created", { title: "Grow revenue" }, "goal.created", {}],
    ["company.skill_created", {}, "skill.added", { source: "created" }],
    ["company.skill_catalog_installed", {}, "skill.added", { source: "catalog" }],
    ["issue.thread_interaction_accepted", { interactionKind: "request_confirmation" }, "interaction.resolved", { kind: "request_confirmation", result: "accepted" }],
    ["issue.thread_interaction_rejected", { interactionKind: "suggest_tasks" }, "interaction.resolved", { kind: "suggest_tasks", result: "rejected" }],
    ["issue.thread_interaction_answered", { interactionKind: "ask_user_questions" }, "interaction.resolved", { kind: "ask_user_questions", result: "answered" }],
  ])("maps %s to a named event with fixed values only", (action, details, name, properties) => {
    expect(draftCloudProductEvent(source({ action, details }))).toMatchObject({ name, properties });
  });

  it("keeps the routine identifier on a routine run", () => {
    const routineId = randomUUID();
    const draft = draftCloudProductEvent(source({
      action: "routine.run_triggered",
      details: { routineId, source: "schedule", status: "issue_created" },
    }));
    expect(draft).toMatchObject({ name: "routine.run_triggered", properties: { routineId, source: "schedule", status: "issue_created" } });
  });

  it("records a task completion only when the status changes to done", () => {
    const completed = source({ action: "issue.updated", entityType: "issue", details: { status: "done", _previous: { status: "in_progress" } } });
    expect(draftCloudProductEvent(completed)).toMatchObject({ name: "task.completed", describesIssue: true });
    expect(draftCloudProductEvent(source({ action: "issue.updated", details: { status: "done", previousStatus: "in_review" } })))
      .toMatchObject({ name: "task.completed" });
    expect(draftCloudProductEvent(source({ action: "issue.updated", details: { status: "done", _previous: { status: "done" } } }))).toBeNull();
    expect(draftCloudProductEvent(source({ action: "issue.updated", details: { title: "Renamed" } }))).toBeNull();
  });

  it("ignores a repeated completion request that changes no status", () => {
    const repeated = source({
      action: "issue.updated",
      details: { status: "done", _previous: { completedAt: "2099-01-01T00:00:00.000Z" } },
    });
    expect(draftCloudProductEvent(repeated)).toBeNull();
    expect(draftCloudProductEvent(source({ action: "issue.updated", details: { status: "done" } }))).toBeNull();
  });

  it("drops values that are not fixed slugs", () => {
    const draft = draftCloudProductEvent(source({
      action: "ai_connection.connected",
      details: { provider: "My Private Provider!", method: "api_key" },
    }));
    expect(draft?.properties).toEqual({ method: "api_key" });
  });

  it("ignores Cloud control activity and unlisted actions", () => {
    expect(draftCloudProductEvent(source({ actorId: "paperclip-cloud" }))).toBeNull();
    expect(draftCloudProductEvent(source({ action: "issue.comment_added" }))).toBeNull();
  });

  it("produces only listed event names", () => {
    const actions = [
      "ai_connection.connected", "agent.created", "issue.document_created", "issue.created", "routine.created",
      "routine.run_triggered", "tool_connection.created", "project.created", "goal.created", "company.skill_created",
      "issue.thread_interaction_accepted", "issue.work_product_created",
    ];
    const names = actions.map((action) => draftCloudProductEvent(source({ action }))?.name);
    names.push(draftCloudProductEvent(source({ action: "issue.updated", details: { status: "done", _previous: { status: "todo" } } }))?.name);
    const direct: readonly string[] = DIRECT_CLOUD_PRODUCT_EVENT_NAMES;
    expect(new Set(names)).toEqual(new Set(CLOUD_PRODUCT_EVENT_NAMES.filter((name) => name !== "plan.created" && !direct.includes(name))));
  });

  it("applies only on Cloud-managed instances", () => {
    expect(hasCloudProductEvent(source(), CLOUD_ENV)).toBe(true);
    expect(hasCloudProductEvent(source(), SELF_HOSTED_ENV)).toBe(false);
    expect(hasCloudProductEvent(source({ action: "issue.comment_added" }), CLOUD_ENV)).toBe(false);
  });
});

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

describe("direct cloud product events", () => {
  it("keeps the direct names inside the closed list", () => {
    const names: readonly string[] = CLOUD_PRODUCT_EVENT_NAMES;
    for (const name of DIRECT_CLOUD_PRODUCT_EVENT_NAMES) expect(names).toContain(name);
  });

  it("reads no data on a self-hosted instance", async () => {
    const unusedDb = new Proxy({}, {
      get() {
        throw new Error("the database must not be used");
      },
    }) as never;
    const options = { env: SELF_HOSTED_ENV };
    const event: DirectCloudProductEvent = {
      name: "plan.approved",
      companyId: randomUUID(),
      actorType: "user",
      actorId: "user-1",
      responsibleUserId: "user-1",
      entityType: "issue",
      entityId: randomUUID(),
    };
    const use: CloudProductEventConnectorUse = {
      companyId: randomUUID(),
      connectionId: randomUUID(),
      connectorKey: "github",
      status: "succeeded",
      actorType: "agent",
      actorId: randomUUID(),
      runId: null,
      issueId: null,
    };
    const agent = { id: randomUUID(), companyId: randomUUID(), role: "engineer", adapterType: "claude_local", metadata: null };

    expect(await recordDirectCloudProductEvent(unusedDb, event, options)).toBe(false);
    expect(await recordRunFinishedCloudProductEvent(unusedDb, randomUUID(), options)).toBe(false);
    expect(await recordAgentFirstRunCloudProductEvent(unusedDb, agent, options)).toBe(false);
    expect(await recordConnectorUsedCloudProductEvent(unusedDb, use, options)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("cloud product event storage", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_CLOUD_STACK_ID", "PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", "PAPERCLIP_MANAGED_CONFIG"];

  const pair = generateKeyPairSync("ed25519");
  const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "product-events-test-key", use: "sig", alg: "EdDSA" };
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
      requestId: `product-events-req-${(requestCounter += 1)}`,
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
    app.use(cloudProductEventRoutes(db));
    return app;
  }

  function gate() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  async function createCompany(id: string = randomUUID()) {
    await db.insert(companies).values({ id, name: "Product events fixture", issuePrefix: `E${id.slice(0, 6)}` });
    return id;
  }

  async function createAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Private agent name",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-configured-model" },
      ...overrides,
    });
    return id;
  }

  async function createRun(companyId: string, agentId: string, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date("2026-11-01T10:00:00.000Z"),
      finishedAt: new Date("2026-11-01T10:01:30.400Z"),
      ...overrides,
    });
    return id;
  }

  function connectorUse(companyId: string, overrides: Partial<CloudProductEventConnectorUse> = {}): CloudProductEventConnectorUse {
    return {
      companyId,
      connectionId: randomUUID(),
      connectorKey: "github",
      status: "succeeded",
      actorType: "agent",
      actorId: randomUUID(),
      runId: null,
      issueId: null,
      ...overrides,
    };
  }

  function eventsNamed(name: string) {
    return db.select().from(cloudProductEvents).where(eq(cloudProductEvents.name, name));
  }

  function stored(rows: unknown[]) {
    return JSON.stringify(rows, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  }

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-cloud-product-events-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key];
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = CLOUD_ENV.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    process.env.PAPERCLIP_CLOUD_STACK_ID = STACK_ID;
    process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = JSON.stringify({ keys: [publicJwk] });
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    resetCloudControlReplayFenceForTests();
    resetCloudProductEventPruneClockForTests();
    resetCloudProductEventConnectorUseGuardForTests();
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

  it("records a completed task with its origin and the responsible person", async () => {
    const companyId = await createCompany();
    const parentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Parent task" },
      { id: issueId, companyId, title: "Private customer wording", parentId, originKind: "routine_execution", createdByUserId: "user-owner" },
    ]);

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: randomUUID(),
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "done", _previous: { status: "in_progress" }, title: "Private customer wording" },
    });

    const rows = await db.select().from(cloudProductEvents).where(eq(cloudProductEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "task.completed",
      actorType: "agent",
      responsibleUserId: "user-owner",
      entityType: "issue",
      entityId: issueId,
      properties: { origin: "routine_execution", isSubtask: true, isOnboarding: false },
    });
    expect(Object.values(rows[0]!).map((value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)).join(" ")).not.toContain("Private customer wording");
  });

  it("marks the onboarding task, whether the wizard or the Cloud seed created it", async () => {
    const companyId = await createCompany();
    const seededId = randomUUID();
    const wizardId = randomUUID();
    const ownId = randomUUID();
    await db.insert(issues).values([
      { id: seededId, companyId, title: "Seeded first task" },
      { id: wizardId, companyId, title: "Wizard first task", originKind: "onboarding_first_task" },
      { id: ownId, companyId, title: "Own task" },
    ]);
    await db.insert(companyOnboardingSeeds).values({ companyId, revision: "1", issueId: seededId });

    for (const entityId of [seededId, wizardId, ownId]) {
      await recordCloudProductEvent(db, source({ companyId, action: "issue.created", entityType: "issue", entityId }), null);
    }

    const rows = await db.select().from(cloudProductEvents).where(eq(cloudProductEvents.companyId, companyId));
    const onboardingByIssue = Object.fromEntries(rows.map((row) => [row.entityId, row.properties.isOnboarding]));
    expect(onboardingByIssue).toEqual({ [seededId]: true, [wizardId]: true, [ownId]: false });
  });

  it("records nothing on a self-hosted instance and still logs the activity", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const companyId = await createCompany();

    await logActivity(db, { ...source({ companyId, action: "routine.created" }), actorType: "user" });

    expect(await db.select().from(cloudProductEvents)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toHaveLength(1);
  });

  it("keeps the activity when the event cannot be stored", async () => {
    const companyId = await createCompany();
    await db.execute(sql`ALTER TABLE cloud_product_events RENAME TO cloud_product_events_unavailable`);
    try {
      await logActivity(db, { ...source({ companyId, action: "routine.created" }), actorType: "user" });
    } finally {
      await db.execute(sql`ALTER TABLE cloud_product_events_unavailable RENAME TO cloud_product_events`);
    }

    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(cloudProductEvents)).toHaveLength(0);
  });

  it("pages events in order for one company", async () => {
    const companyId = await createCompany();
    const otherCompanyId = await createCompany();
    for (let index = 0; index < 3; index += 1) {
      await recordCloudProductEvent(db, source({ companyId, action: "project.created" }), null);
    }
    await recordCloudProductEvent(db, source({ companyId: otherCompanyId, action: "goal.created" }), null);

    const first = await listCloudProductEvents(db, { companyId, after: CLOUD_PRODUCT_EVENT_START_CURSOR, limit: 2 });
    expect(first.events.map((event) => event.name)).toEqual(["project.created", "project.created"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextAfter.endsWith(`.${first.events[1]!.sequence}`)).toBe(true);

    const second = await listCloudProductEvents(db, { companyId, after: first.nextAfter, limit: 2 });
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.events[0]!.sequence).toBeGreaterThan(first.events[1]!.sequence);

    const empty = await listCloudProductEvents(db, { companyId, after: second.nextAfter, limit: 2 });
    expect(empty).toEqual({ events: [], nextAfter: second.nextAfter, hasMore: false });
  });

  it("holds back a later event until an earlier open transaction ends", async () => {
    const companyId = await createCompany();
    const inserted = gate();
    const release = gate();
    const open = db.transaction(async (tx) => {
      await recordCloudProductEvent(tx as unknown as typeof db, source({ companyId, action: "project.created" }), null);
      inserted.open();
      await release.wait;
    });
    await inserted.wait;
    await recordCloudProductEvent(db, source({ companyId, action: "goal.created" }), null);

    const during = await listCloudProductEvents(db, { companyId, after: CLOUD_PRODUCT_EVENT_START_CURSOR, limit: 10 });
    expect(during).toEqual({ events: [], nextAfter: CLOUD_PRODUCT_EVENT_START_CURSOR, hasMore: false });

    release.open();
    await open;
    const afterCommit = await listCloudProductEvents(db, { companyId, after: during.nextAfter, limit: 10 });
    expect(afterCommit.events.map((event) => event.name)).toEqual(["project.created", "goal.created"]);
  });

  it("returns an event with a lower sequence that commits after the cursor moved", async () => {
    const companyId = await createCompany();
    const olderStarted = gate();
    const olderMayInsert = gate();
    const newerInserted = gate();
    const newerMayCommit = gate();
    const older = db.transaction(async (tx) => {
      await tx.execute(sql`select txid_current()`);
      olderStarted.open();
      await olderMayInsert.wait;
      await recordCloudProductEvent(tx as unknown as typeof db, source({ companyId, action: "project.created" }), null);
    });
    await olderStarted.wait;
    const newer = db.transaction(async (tx) => {
      await recordCloudProductEvent(tx as unknown as typeof db, source({ companyId, action: "goal.created" }), null);
      newerInserted.open();
      await newerMayCommit.wait;
    });
    await newerInserted.wait;
    olderMayInsert.open();
    await older;

    const first = await listCloudProductEvents(db, { companyId, after: CLOUD_PRODUCT_EVENT_START_CURSOR, limit: 10 });
    expect(first.events.map((event) => event.name)).toEqual(["project.created"]);

    newerMayCommit.open();
    await newer;
    const second = await listCloudProductEvents(db, { companyId, after: first.nextAfter, limit: 10 });
    expect(second.events.map((event) => event.name)).toEqual(["goal.created"]);
    expect(second.events[0]!.sequence).toBeLessThan(first.events[0]!.sequence);
  });

  it("removes events older than thirty days, at most once an hour", async () => {
    const companyId = await createCompany();
    const now = Date.now();
    const insertOld = () => db.insert(cloudProductEvents).values({
      companyId,
      name: "project.created",
      actorType: "user",
      actorId: "user-1",
      entityType: "project",
      entityId: randomUUID(),
      occurredAt: new Date(now - 31 * 24 * 60 * 60 * 1000),
    });

    await insertOld();
    await recordCloudProductEvent(db, source({ companyId, action: "goal.created" }), null, { now });
    expect((await db.select().from(cloudProductEvents)).map((row) => row.name)).toEqual(["goal.created"]);

    await insertOld();
    await recordCloudProductEvent(db, source({ companyId, action: "goal.created" }), null, { now: now + 60_000 });
    expect(await db.select().from(cloudProductEvents)).toHaveLength(3);

    await recordCloudProductEvent(db, source({ companyId, action: "goal.created" }), null, { now: now + 61 * 60_000 });
    expect((await db.select().from(cloudProductEvents)).map((row) => row.name)).toEqual(["goal.created", "goal.created", "goal.created"]);
  });

  it("records a finished run with its failure class and numbers, and no free text", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    const runId = await createRun(companyId, agentId, {
      status: "failed",
      error: "Private error text",
      errorCode: "provider_quota",
      responsibleUserId: "user-owner",
      usageJson: { model: "claude-fable-5-2", inputTokens: 1200.7, output_tokens: 340, cacheReadInputTokens: 55, note: "Private usage note" },
    });

    expect(await recordRunFinishedCloudProductEvent(db, runId)).toBe(true);

    const rows = await eventsNamed("run.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      responsibleUserId: "user-owner",
      entityType: "heartbeat_run",
      entityId: runId,
    });
    expect(rows[0]!.properties).toEqual({
      outcome: "failed",
      errorCode: "provider_quota",
      failureClass: "provider_limit",
      adapterType: "claude_local",
      model: "claude-fable-5-2",
      durationSeconds: 90,
      inputTokens: 1200,
      outputTokens: 340,
      cachedTokens: 55,
    });
    expect(stored(rows)).not.toMatch(/Private/);
  });

  it("omits the failure class of a successful run and a model that is not a fixed value", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { adapterConfig: { model: "Customer Model (private)" } });
    const runId = await createRun(companyId, agentId);

    expect(await recordRunFinishedCloudProductEvent(db, runId)).toBe(true);

    expect((await eventsNamed("run.finished"))[0]!.properties).toEqual({
      outcome: "succeeded",
      adapterType: "claude_local",
      durationSeconds: 90,
    });
  });

  it("classes an unlisted error code as other and drops an error code that is not a slug", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    const unlisted = await createRun(companyId, agentId, { status: "failed", errorCode: "a_code_added_later" });
    const freeText = await createRun(companyId, agentId, { status: "timed_out", errorCode: "Private failure sentence" });

    await recordRunFinishedCloudProductEvent(db, unlisted);
    await recordRunFinishedCloudProductEvent(db, freeText);

    const rows = await eventsNamed("run.finished");
    expect(rows.find((row) => row.entityId === unlisted)!.properties).toMatchObject({ errorCode: "a_code_added_later", failureClass: "other" });
    expect(rows.find((row) => row.entityId === freeText)!.properties).toEqual({
      outcome: "timed_out",
      failureClass: "other",
      adapterType: "claude_local",
      model: "claude-configured-model",
      durationSeconds: 90,
    });
  });

  it("records no run event for a run that is not finished, a built-in agent, or a self-hosted instance", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    const builtInAgentId = await createAgent(companyId, {
      metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "assistant", featureKeys: ["assistant"] } },
    });
    const running = await createRun(companyId, agentId, { status: "running", finishedAt: null });
    const builtIn = await createRun(companyId, builtInAgentId);
    const finished = await createRun(companyId, agentId);

    expect(await recordRunFinishedCloudProductEvent(db, running)).toBe(false);
    expect(await recordRunFinishedCloudProductEvent(db, builtIn)).toBe(false);
    expect(await recordRunFinishedCloudProductEvent(db, randomUUID())).toBe(false);
    expect(await recordRunFinishedCloudProductEvent(db, finished, { env: SELF_HOSTED_ENV })).toBe(false);
    expect(await db.select().from(cloudProductEvents)).toHaveLength(0);
  });

  it("warns and does not throw when a direct event cannot be stored", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    const runId = await createRun(companyId, agentId);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await db.execute(sql`ALTER TABLE cloud_product_events RENAME TO cloud_product_events_unavailable`);
    try {
      expect(await recordRunFinishedCloudProductEvent(db, runId)).toBe(false);
      expect(await recordAgentFirstRunCloudProductEvent(db, { id: agentId, companyId, role: "engineer", adapterType: "claude_local", metadata: null })).toBe(false);
      expect(await recordConnectorUsedCloudProductEvent(db, connectorUse(companyId))).toBe(false);
      expect(await recordDirectCloudProductEvent(db, {
        name: "plan.approved",
        companyId,
        actorType: "user",
        actorId: "user-1",
        responsibleUserId: "user-1",
        entityType: "issue",
        entityId: randomUUID(),
      })).toBe(false);
      expect(warn.mock.calls.map((call) => (call[0] as { name: string }).name))
        .toEqual(["run.finished", "agent.first_run", "connector.used", "plan.approved"]);
    } finally {
      warn.mockRestore();
      await db.execute(sql`ALTER TABLE cloud_product_events_unavailable RENAME TO cloud_product_events`);
    }
    expect(await db.select().from(cloudProductEvents)).toHaveLength(0);
  });

  it("stores only fixed values, numbers, and booleans from a direct event", async () => {
    const companyId = await createCompany();
    const issueId = randomUUID();

    expect(await recordDirectCloudProductEvent(db, {
      name: "plan.approved",
      companyId,
      actorType: "user",
      actorId: "user-1",
      responsibleUserId: "user-1",
      entityType: "issue",
      entityId: issueId,
      properties: {
        kind: "plan",
        count: 3,
        flag: true,
        title: "Private plan title",
        nested: { text: "Private nested text" },
        list: ["Private list text"],
        notFinite: Number.NaN,
        empty: null,
      },
    })).toBe(true);
    expect(await recordDirectCloudProductEvent(db, {
      name: "plan.approved",
      companyId,
      actorType: "system",
      actorId: "paperclip-cloud",
      responsibleUserId: null,
      entityType: "issue",
      entityId: issueId,
    })).toBe(false);

    const rows = await eventsNamed("plan.approved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: "user-1", responsibleUserId: "user-1", entityType: "issue", entityId: issueId });
    expect(rows[0]!.properties).toEqual({ kind: "plan", count: 3, flag: true });
    expect(stored(rows)).not.toMatch(/Private/);
  });

  it("records the first run of an agent with the responsible person of that run", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId, { role: "cto", adapterType: "codex_local" });
    await createRun(companyId, agentId, { responsibleUserId: "user-first", createdAt: new Date("2026-11-01T09:00:00.000Z") });
    await createRun(companyId, agentId, { responsibleUserId: "user-later", createdAt: new Date("2026-11-02T09:00:00.000Z") });
    const builtInAgentId = await createAgent(companyId, {
      metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "assistant", featureKeys: ["assistant"] } },
    });

    expect(await recordAgentFirstRunCloudProductEvent(db, { id: agentId, companyId, role: "cto", adapterType: "codex_local", metadata: null })).toBe(true);
    expect(await recordAgentFirstRunCloudProductEvent(db, {
      id: builtInAgentId,
      companyId,
      role: "engineer",
      adapterType: "claude_local",
      metadata: { [BUILT_IN_AGENT_METADATA_KEY]: { key: "assistant", featureKeys: ["assistant"] } },
    })).toBe(false);

    const rows = await eventsNamed("agent.first_run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "agent",
      actorId: agentId,
      responsibleUserId: "user-first",
      entityType: "agent",
      entityId: agentId,
      properties: { role: "cto", adapterType: "codex_local" },
    });
    expect(stored(rows)).not.toContain("Private agent name");
  });

  it("records a connector use one time for each connection and UTC day, also after a restart", async () => {
    const companyId = await createCompany();
    const agentId = await createAgent(companyId);
    const runId = await createRun(companyId, agentId, { responsibleUserId: "user-owner" });
    const now = Date.parse("2026-11-03T23:50:00.000Z");
    const use = connectorUse(companyId, { actorId: agentId, runId });
    const otherUse = connectorUse(companyId, { connectorKey: "Private Server Name", status: "failed", actorType: "user", actorId: "user-tester" });

    expect(await recordConnectorUsedCloudProductEvent(db, use, { now })).toBe(true);
    expect(await recordConnectorUsedCloudProductEvent(db, { ...use, status: "failed" }, { now: now + 60_000 })).toBe(false);
    expect(await recordConnectorUsedCloudProductEvent(db, otherUse, { now })).toBe(true);

    resetCloudProductEventConnectorUseGuardForTests();
    expect(await recordConnectorUsedCloudProductEvent(db, use, { now: now + 120_000 })).toBe(false);
    expect(await eventsNamed("connector.used")).toHaveLength(2);

    expect(await recordConnectorUsedCloudProductEvent(db, use, { now: now + 15 * 60_000 })).toBe(true);
    resetCloudProductEventConnectorUseGuardForTests();
    expect(await recordConnectorUsedCloudProductEvent(db, use, { now: now + 16 * 60_000 })).toBe(false);

    const rows = await eventsNamed("connector.used");
    const forConnection = rows.filter((row) => row.entityId === use.connectionId);
    expect(forConnection.map((row) => row.occurredAt.toISOString().slice(0, 10))).toEqual(["2026-11-03", "2026-11-04"]);
    expect(forConnection[0]).toMatchObject({
      actorType: "agent",
      actorId: agentId,
      responsibleUserId: "user-owner",
      entityType: "tool_connection",
      properties: { connectorKey: "github", status: "succeeded" },
    });
    expect(rows.find((row) => row.entityId === otherUse.connectionId)).toMatchObject({
      actorType: "user",
      actorId: "user-tester",
      responsibleUserId: "user-tester",
      properties: { status: "failed" },
    });
    expect(stored(rows)).not.toMatch(/Private/);
  });

  it("records one connector use when two requests for one connection run at the same time", async () => {
    const companyId = await createCompany();
    const use = connectorUse(companyId);
    const now = Date.parse("2026-11-03T12:00:00.000Z");

    const first = recordConnectorUsedCloudProductEvent(db, use, { now });
    resetCloudProductEventConnectorUseGuardForTests();
    const second = recordConnectorUsedCloudProductEvent(db, use, { now });

    expect([await first, await second].sort()).toEqual([false, true]);
    expect(await eventsNamed("connector.used")).toHaveLength(1);
  });

  it("serves events only to a signed Cloud read", async () => {
    const companyId = await createCompany(cloudTenantPrimaryCompanyId(STACK_ID));
    const otherCompanyId = await createCompany();
    await recordCloudProductEvent(db, source({ companyId, action: "project.created", entityType: "project" }), "user-owner");
    await recordCloudProductEvent(db, source({ companyId: otherCompanyId, action: "goal.created" }), null);
    const app = createApp();
    const path = "/api/instance/product-events";

    expect((await request(app).get(path)).status).toBe(403);
    expect((await request(app).get(path).set(CLOUD_CONTROL_HEADER, assertion("lifecycle:read"))).status).toBe(401);
    expect((await request(app).get(`${path}?limit=0`).set(CLOUD_CONTROL_HEADER, assertion("product-events:read"))).status).toBe(400);
    expect((await request(app).get(`${path}?after=12`).set(CLOUD_CONTROL_HEADER, assertion("product-events:read"))).status).toBe(400);

    const response = await request(app).get(path).set(CLOUD_CONTROL_HEADER, assertion("product-events:read"));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.hasMore).toBe(false);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]).toMatchObject({
      name: "project.created",
      actorId: "user-1",
      responsibleUserId: "user-owner",
      entityType: "project",
      properties: {},
    });
    expect(response.body.nextAfter).toMatch(new RegExp(`^\\d+\\.${response.body.events[0].sequence}$`));

    const next = await request(app)
      .get(`${path}?after=${response.body.nextAfter}`)
      .set(CLOUD_CONTROL_HEADER, assertion("product-events:read"));
    expect(next.body).toEqual({ events: [], nextAfter: response.body.nextAfter, hasMore: false });
  });
});
