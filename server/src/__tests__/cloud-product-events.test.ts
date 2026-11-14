import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, cloudProductEvents, companies, companyOnboardingSeeds, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cloudControlMiddleware } from "../middleware/cloud-control.js";
import { cloudProductEventRoutes } from "../routes/cloud-product-events.js";
import { logActivity } from "../services/activity-log.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";
import {
  CLOUD_PRODUCT_EVENT_NAMES,
  CLOUD_PRODUCT_EVENT_START_CURSOR,
  draftCloudProductEvent,
  hasCloudProductEvent,
  listCloudProductEvents,
  recordCloudProductEvent,
  resetCloudProductEventPruneClockForTests,
  type CloudProductEventSource,
} from "../services/cloud-product-events.js";
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
    expect(new Set(names)).toEqual(new Set(CLOUD_PRODUCT_EVENT_NAMES.filter((name) => name !== "plan.created")));
  });

  it("applies only on Cloud-managed instances", () => {
    expect(hasCloudProductEvent(source(), CLOUD_ENV)).toBe(true);
    expect(hasCloudProductEvent(source(), SELF_HOSTED_ENV)).toBe(false);
    expect(hasCloudProductEvent(source({ action: "issue.comment_added" }), CLOUD_ENV)).toBe(false);
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
