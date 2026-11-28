import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  companySecretBindings,
  secretAccessEvents,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  principalPermissionGrants,
  projectWorkspaces,
  projects,
  responsibilities,
  responsibilityLinks,
  routineDocuments,
  routineRevisions,
  routineRuns,
  routines,
  routineTriggers,
  userWorkspacePreferences,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

function registerRoutineServiceMock() {
  vi.doMock("../services/routines.js", async () => {
    const actual = await vi.importActual<typeof import("../services/routines.js")>("../services/routines.js");

    return {
      ...actual,
      routineService: (db: any) =>
        actual.routineService(db, {
          heartbeat: {
            wakeup: async (agentId: string, wakeupOpts: any) => {
              const issueId =
                (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
                (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
                null;
              if (!issueId) return null;

              const issue = await db
                .select({ companyId: issues.companyId })
                .from(issues)
                .where(eq(issues.id, issueId))
                .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);
              if (!issue) return null;

              const queuedRunId = randomUUID();
              await db.insert(heartbeatRuns).values({
                id: queuedRunId,
                companyId: issue.companyId,
                agentId,
                invocationSource: wakeupOpts?.source ?? "assignment",
                triggerDetail: wakeupOpts?.triggerDetail ?? null,
                status: "queued",
                contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
              });
              await db
                .update(issues)
                .set({
                  executionRunId: queuedRunId,
                  executionLockedAt: new Date(),
                })
                .where(eq(issues.id, issueId));
              return { id: queuedRunId };
            },
          },
        }),
    };
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine routes end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-e2e-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(responsibilityLinks);
    await db.delete(responsibilities);
    await db.delete(userWorkspacePreferences);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(routineDocuments);
    await db.delete(routines);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/companies.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRoutineServiceMock();
    vi.doMock("../services/index.js", async () => {
      const [{ accessService }, { documentAnnotationService }, { logActivity }, { routineService }] = await Promise.all([
        import("../services/access.js"), import("../services/document-annotations.js"),
        import("../services/activity-log.js"), import("../services/routines.js"),
      ]);
      return { accessService, documentAnnotationService, logActivity, routineService };
    });
    vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
    vi.clearAllMocks();
  });

  async function createApp(actor: Record<string, unknown>) {
    const { errorHandler } = await import("../middleware/index.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function createAuthenticatedApp() {
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const { errorHandler } = await import("../middleware/index.js");
    const resolveSession = vi.fn(async () => null);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return { app, resolveSession };
  }

  async function postRoutineRun(
    app: express.Express,
    routineId: string,
    body: Record<string, unknown>,
  ) {
    let response = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send(body);
    if (response.status === 500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await request(app)
        .post(`/api/routines/${routineId}/run`)
        .send(body);
    }
    return response;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routine Project",
      status: "in_progress",
    });

    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { companyId, agentId, projectId, userId };
  }

  function routineResourceRequests(app: express.Express, routineId: string, triggerId = routineId) {
    const path = `/api/routines/${encodeURIComponent(routineId)}`;
    const triggerPath = `/api/routine-triggers/${encodeURIComponent(triggerId)}`;
    const nestedId = "12345678-1234-4234-8234-123456789abc";
    return [
      request(app).get(path),
      request(app).get(`${path}/runs`),
      request(app).get(`${path}/revisions`),
      request(app).get(`${path}/description/annotations`),
      request(app).get(`${path}/description/annotations/${nestedId}`),
      request(app).post(`${path}/description/annotations`).send({
        baseRevisionId: nestedId, baseRevisionNumber: 1, body: "Review this text",
        selector: {
          quote: { exact: "text" },
          position: { normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4 },
        },
      }),
      request(app).post(`${path}/description/annotations/${nestedId}/comments`).send({ body: "Review" }),
      request(app).patch(`${path}/description/annotations/${nestedId}`).send({ status: "resolved" }),
      request(app).patch(path).send({ title: "Updated routine" }),
      request(app).post(`${path}/revisions/${nestedId}/restore`).send({}),
      request(app).post(`${path}/triggers`).send({ kind: "api" }),
      request(app).post(`${path}/run`).send({}),
      request(app).patch(triggerPath).send({ enabled: false }),
      request(app).delete(triggerPath),
      request(app).post(`${triggerPath}/rotate-secret`).send({}),
    ];
  }

  it("returns not found without queries for malformed routine and trigger IDs on every resource route", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const actors = [
      { type: "board", userId, source: "session", companyIds: [companyId] },
      { type: "agent", agentId, companyId },
      { type: "none" },
    ];
    const fullId = "12345678-1234-4234-8234-123456789abc";
    for (const actor of actors) {
      const app = await createApp(actor);
      const spies = [
        vi.spyOn(db, "select"), vi.spyOn(db, "insert"),
        vi.spyOn(db, "update"), vi.spyOn(db, "delete"),
      ];
      try {
        for (const id of [fullId.slice(0, 8), "not-a-uuid", ` ${fullId}`, `${fullId}\n`, `{${fullId}\n}`]) {
          for (const pending of routineResourceRequests(app, id)) {
            const response = await pending;
            expect(response.status, JSON.stringify(response.body)).toBe(404);
            expect(response.body).toEqual({ error: pending.url.includes("/routine-triggers/")
              ? "Routine trigger not found" : "Routine not found" });
          }
        }
        const invalidBody = await request(app).patch("/api/routines/not-a-uuid").send({ title: 42 });
        expect(invalidBody.status).toBe(400);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
  }, 20_000);

  it("keeps missing and cross-company routine resources indistinguishable", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, assigneeAgentId: agentId, title: "Private routine" });
    await db.insert(routineTriggers).values({ id: triggerId, companyId, routineId, kind: "api" });
    for (const actor of [
      { type: "board", userId, source: "session", isInstanceAdmin: true, companyIds: [randomUUID()] },
      { type: "agent", agentId: randomUUID(), companyId: randomUUID() },
      { type: "none" },
    ]) {
      const app = await createApp(actor);
      for (const [id, tid] of [[routineId, triggerId], [routineId.toUpperCase(), `{${triggerId}}`], [randomUUID(), randomUUID()]]) {
        for (const pending of routineResourceRequests(app, id!, tid!)) {
          const response = await pending;
          expect(response.status, JSON.stringify(response.body)).toBe(404);
          expect(response.body).toEqual({ error: pending.url.includes("/routine-triggers/")
            ? "Routine trigger not found" : "Routine not found" });
        }
      }
    }
    expect(await db.select().from(routines)).toMatchObject([{ id: routineId, title: "Private routine" }]);
    expect(await db.select().from(routineTriggers)).toMatchObject([{ id: triggerId, enabled: true }]);
    expect(await db.select().from(activityLog)).toEqual([]);
  }, 20_000);

  it("preserves UUID routine reads and assignee-only mutations", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, assigneeAgentId: agentId, title: "Private routine" });
    await db.insert(routineTriggers).values({ id: triggerId, companyId, routineId, kind: "api" });
    const owner = await createApp({ type: "agent", agentId, companyId });
    const otherAgent = await createApp({ type: "agent", agentId: randomUUID(), companyId });
    const board = await createApp({ type: "board", userId, source: "session", companyIds: [companyId] });
    for (const app of [owner, otherAgent, board]) {
      const response = await request(app).get(`/api/routines/${routineId.toUpperCase()}`);
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(routineId);
    }
    for (const [index, pending] of routineResourceRequests(otherAgent, routineId, triggerId).entries()) {
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(index < 2 ? 200 : 403);
    }
    const updated = await request(owner).patch(`/api/routines/${routineId}`).send({ title: "Owner update" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.title).toBe("Owner update");
    const changedTrigger = await request(board).patch(`/api/routine-triggers/${triggerId}`).send({ enabled: false });
    expect(changedTrigger.status, JSON.stringify(changedTrigger.body)).toBe(200);
    expect(changedTrigger.body.enabled).toBe(false);
  }, 20_000);

  it.each(["bearer", "hmac_sha256", "github_hmac", "none"] as const)(
    "authenticates %s HTTP deliveries, persists payloads, and enforces trigger lifecycle",
    async (signingMode) => {
      vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
      const { companyId, agentId, projectId, userId } = await seedFixture();
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
        projectId, assigneeAgentId: agentId, title: "Webhook {{event}}",
        description: "Handle {{event}}", variables: [{ name: "event", type: "text", required: true }],
        concurrencyPolicy: "always_enqueue",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const routineId = created.body.id;
      const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode });
      expect(configured.status, JSON.stringify(configured.body)).toBe(201);
      const { trigger, secretMaterial } = configured.body;
      const detail = await request(board).get(`/api/routines/${routineId}`);
      expect(detail.body.triggers[0].webhookUrl).toBe(secretMaterial.webhookUrl);
      const path = new URL(secretMaterial.webhookUrl).pathname;
      const [{ actorMiddleware }, { boardMutationGuard }, { routineRoutes }, { errorHandler }] = await Promise.all([
        import("../middleware/auth.js"), import("../middleware/board-mutation-guard.js"),
        import("../routes/routines.js"), import("../middleware/error-handler.js"),
      ]);
      const ingress = express();
      ingress.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
      ingress.use(actorMiddleware(db, {
        deploymentMode: "authenticated",
        // A webhook must not acquire an ambient board session or need CSRF headers.
        resolveSession: async () => { throw new Error("Webhook must not resolve a browser session"); },
      }));
      ingress.use("/api", boardMutationGuard(), routineRoutes(db));
      ingress.use(errorHandler);
      const raw = '{ "event": "deploy", "detail": { "text": "café" } }';
      const timestamp = String(Math.floor(Date.now() / 1000));
      function delivery(secret = secretMaterial.webhookSecret, body = raw, ts = timestamp) {
        const req = request(ingress).post(path).set("Content-Type", "application/json");
        if (signingMode === "bearer") req.set("Authorization", `Bearer ${secret}`);
        if (signingMode === "hmac_sha256") {
          req.set("X-Paperclip-Timestamp", ts).set("X-Paperclip-Signature",
            `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex")}`);
        }
        if (signingMode === "github_hmac") req.set("X-Hub-Signature-256",
          `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
        return req.send(body);
      }
      if (signingMode !== "none") expect((await delivery("wrong-secret")).status).toBe(401);
      if (signingMode === "hmac_sha256" || signingMode === "github_hmac") {
        expect((await delivery(undefined, raw.replace("deploy", "tampered"))).status).toBe(401);
      }
      if (signingMode === "hmac_sha256") {
        expect((await delivery(undefined, raw, "1")).status).toBe(401);
        const malformed = await request(ingress).post(path).set("Content-Type", "application/json")
          .set("X-Paperclip-Timestamp", timestamp).set("X-Paperclip-Signature", "é".repeat(64)).send(raw);
        expect(malformed.status).toBe(401);
      }
      expect((await request(ingress).post(path).type("text").send(raw)).status).toBe(415);
      expect((await request(ingress).post(path).send([])).status).toBe(400);
      const accepted = await delivery();
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(accepted.body).toMatchObject({ source: "webhook", status: "issue_created" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, accepted.body.linkedIssueId));
      expect(issue).toMatchObject({ companyId, assigneeAgentId: agentId, title: "Webhook deploy", description: "Handle deploy" });
      const history = await request(board).get(`/api/routines/${routineId}/runs`);
      expect(history.body[0].triggerPayload).toMatchObject({ event: "deploy", detail: { text: "café" } });
      await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, issue.id));
      if (signingMode === "hmac_sha256") {
        expect((await delivery()).status).toBe(409);
      } else {
        const first = await delivery().set("Idempotency-Key", "delivery-2");
        const retry = await delivery().set("Idempotency-Key", "delivery-2");
        expect(retry.status).toBe(202);
        expect(retry.body.id).toBe(first.body.id);
        await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, first.body.linkedIssueId));
      }
      if (signingMode !== "none") {
        const rotated = await request(board).post(`/api/routine-triggers/${trigger.id}/rotate-secret`).send({});
        expect(rotated.status).toBe(200);
        expect(rotated.body.trigger.lastWebhookDelivery).toBeNull();
        expect((await delivery()).status).toBe(401);
        expect((await delivery(rotated.body.secretMaterial.webhookSecret)).status).toBe(202);
      }
      await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: false });
      expect((await delivery()).status).toBe(409);
      await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: true });
      await request(board).patch(`/api/routines/${routineId}`).send({ status: "paused" });
      expect((await delivery()).status).toBe(409);
    },
  );

  it("uses the normal public webhook for verified caller provenance and routine-wide receipts", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Ordinary webhook", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const a = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "app_webhook" });
    const b = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "app_webhook" });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    const [source] = await db.insert(issues).values({ companyId, title: "Caller source", createdByUserId: userId }).returning();
    const [caller] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: source!.id, status: "running" }).returning();
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", caller!.id)!;
    const { app: publicApp, resolveSession } = await createAuthenticatedApp();
    const delivery = (config: typeof a.body, scope = "routine") => request(publicApp)
      .post(new URL(config.secretMaterial.webhookUrl).pathname)
      .set("Authorization", `Bearer ${config.secretMaterial.webhookSecret}`)
      .set("X-Paperclip-Source-Run-Token", token).set("X-Paperclip-Idempotency-Scope", scope)
      .set("Idempotency-Key", "external-occurrence-1").send({ event: "any-provider.failure", createdByRunId: randomUUID() });
    expect((await delivery(a.body, "global")).status).toBe(400);
    const first = await delivery(a.body), retry = await delivery(b.body);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(retry.status).toBe(202);
    expect(first.body.createdByRunId).toBe(caller!.id);
    expect(retry.body.id).toBe(first.body.id);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(2);
    expect(resolveSession).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, caller!.id));
    expect((await delivery(a.body)).status).toBe(401);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    const removedPath = new URL(a.body.secretMaterial.webhookUrl).pathname.replace(/\/fire$/, "/sentry-run-failures");
    expect((await request(publicApp).post(removedPath).send({})).status).toBe(404);
  });

  it("preserves the authenticated caller and upstream routine through the routine HTTP API", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const create = (title: string) => request(board).post(`/api/companies/${companyId}/routines`)
      .send({ projectId, assigneeAgentId: agentId, title });
    const upstream = await create("Upstream routine"), downstream = await create("API consumer");
    expect(upstream.status).toBe(201); expect(downstream.status).toBe(201);
    const source = await request(board).post(`/api/routines/${upstream.body.id}/run`).send({});
    expect(source.status, JSON.stringify(source.body)).toBe(202);
    const [task] = await db.select().from(issues).where(eq(issues.id, source.body.linkedIssueId));
    const [caller] = await db.update(heartbeatRuns).set({ status: "running" })
      .where(eq(heartbeatRuns.id, task!.executionRunId!)).returning();
    const { app } = await createAuthenticatedApp();
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", caller!.id)!;
    const response = await request(app).post(`/api/routines/${downstream.body.id}/run`)
      .set("Authorization", `Bearer ${token}`).send({ source: "api" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.createdByRunId).toBe(caller!.id);
    const [receipt] = await db.select().from(routineRuns).where(eq(routineRuns.id, response.body.id));
    expect(receipt?.createdByRunId).toBe(caller!.id);
    const { readTaskCreationProvenance } = await import("../services/task-creation-provenance.js");
    expect(await readTaskCreationProvenance(db, companyId, response.body.linkedIssueId))
      .toEqual({ status: "complete", routineIds: [upstream.body.id, downstream.body.id].sort(), shareable: true });
  });

  it("keeps setup deliveries out of runs, persists test receipts, and restores removed triggers", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Verify deployment", description: "Inspect deployment", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer", setupPending: true });
    expect(configured.status).toBe(201);
    const { trigger, secretMaterial } = configured.body;
    const path = new URL(secretMaterial.webhookUrl).pathname;
    const publicApp = await createApp({ type: "none" });
    const deliver = (key: string, secret = secretMaterial.webhookSecret) => request(publicApp).post(path).set("Authorization", `Bearer ${secret}`).set("Idempotency-Key", key).send({ event: "deployment.completed" });
    await request(board).patch(`/api/routines/${routineId}`).send({ status: "paused" });
    expect((await deliver("bad", "wrong")).status).toBe(401);
    let detail = await request(board).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0]).toMatchObject({ setupPending: true, lastWebhookDelivery: { status: "rejected", test: true } });
    const tested = await deliver("setup-event");
    expect(tested.status, JSON.stringify(tested.body)).toBe(202);
    expect(tested.body).toMatchObject({ status: "test_received", routineStarted: false, linkedIssueId: null });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    // Read through a fresh app instance to prove the state is database-backed.
    const reopened = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    detail = await request(reopened).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0]).toMatchObject({ setupPending: true, lastWebhookDelivery: { status: "received", test: true } });
    expect(JSON.stringify(detail.body)).not.toContain(secretMaterial.webhookSecret);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: false })).status).toBe(200);
    await request(board).patch(`/api/routines/${routineId}`).send({ status: "active" });
    expect((await deliver("setup-event")).body.status).toBe("test_received");
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    const live = await deliver("live-event");
    expect(live.status, JSON.stringify(live.body)).toBe(202);
    expect(live.body.status).toBe("issue_created");
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await deliver("live-event")).body.id).toBe(live.body.id);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "routine.run_triggered"))).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ archived: true })).status).toBe(200);
    expect((await deliver("removed-event")).status).toBe(404);
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(0);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ archived: false })).status).toBe(200);
    detail = await request(board).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0].webhookUrl).toBe(secretMaterial.webhookUrl);
    expect((await deliver("restored-event")).status).toBe(202);
    const schedule = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "America/Chicago" });
    expect(schedule.status).toBe(201);
    await request(board).patch(`/api/routine-triggers/${schedule.body.trigger.id}`).send({ archived: true });
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(1);
    await request(board).patch(`/api/routine-triggers/${schedule.body.trigger.id}`).send({ archived: false });
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(2);
  });

  it("puts a live webhook back into test mode without starting runs and restores its last real delivery", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Triage alerts", description: "Look at the alert", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer" });
    expect(configured.status).toBe(201);
    const { trigger, secretMaterial } = configured.body;
    const path = new URL(secretMaterial.webhookUrl).pathname;
    const publicApp = await createApp({ type: "none" });
    const deliver = (key: string) => request(publicApp).post(path)
      .set("Authorization", `Bearer ${secretMaterial.webhookSecret}`).set("Idempotency-Key", key).send({ event: "alert.fired" });
    const triggerRow = async () => (await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)))[0]!;

    const live = await deliver("live-1");
    expect(live.body.status, JSON.stringify(live.body)).toBe("issue_created");
    expect(await db.select().from(issues)).toHaveLength(1);
    const realDelivery = (await triggerRow()).lastWebhookDelivery!;
    expect(realDelivery).toMatchObject({ status: "received", test: false });
    expect(realDelivery.previous).toBeUndefined();

    const outsider = await createApp({ type: "board", userId: randomUUID(), source: "session", companyIds: [randomUUID()] });
    expect((await request(outsider).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: true })).status).toBe(404);
    expect((await triggerRow()).setupPending).toBe(false);

    const started = await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: true });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body).toMatchObject({ setupPending: true, lastWebhookDelivery: realDelivery });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "routine.trigger_test_started"))).toHaveLength(1);
    const revisions = await request(board).get(`/api/routines/${routineId}/revisions`);
    expect(revisions.body.map((revision: { changeSummary: string }) => revision.changeSummary)).toContain("Started testing webhook");

    for (const key of ["test-1", "test-2"]) {
      const tested = await deliver(key);
      expect(tested.status, JSON.stringify(tested.body)).toBe(202);
      expect(tested.body).toMatchObject({ status: "test_received", routineStarted: false, linkedIssueId: null });
    }
    expect(await db.select().from(issues)).toHaveLength(1);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    expect((await triggerRow()).lastWebhookDelivery).toMatchObject({
      status: "received", test: true, previous: { ...realDelivery, test: false },
    });

    const finished = await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: false });
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ setupPending: false, lastWebhookDelivery: realDelivery });
    expect((await triggerRow()).lastWebhookDelivery).toEqual(realDelivery);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "routine.trigger_setup_finished"))).toHaveLength(1);
    expect((await request(board).get(`/api/routines/${routineId}/revisions`)).body
      .map((revision: { changeSummary: string }) => revision.changeSummary)).toContain("Finished testing webhook");

    // A sender retry of an event received during testing stays a test receipt.
    expect((await deliver("test-1")).body.status).toBe("test_received");
    expect(await db.select().from(issues)).toHaveLength(1);
    const next = await deliver("live-2");
    expect(next.body.status, JSON.stringify(next.body)).toBe("issue_created");
    expect(await db.select().from(issues)).toHaveLength(2);
    expect((await triggerRow()).lastWebhookDelivery).toMatchObject({ status: "received", test: false });
    expect((await triggerRow()).lastWebhookDelivery?.previous).toBeUndefined();
  });

  it("starts each test of a never-used webhook without the last test's result", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({ projectId, assigneeAgentId: agentId, title: "Quiet hook" });
    const routineId = created.body.id;
    const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer" });
    const { trigger, secretMaterial } = configured.body;
    const path = new URL(secretMaterial.webhookUrl).pathname;
    const publicApp = await createApp({ type: "none" });
    const triggerRow = async () => (await db.select().from(routineTriggers).where(eq(routineTriggers.id, trigger.id)))[0]!;

    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: true })).status).toBe(200);
    const tested = await request(publicApp).post(path).set("Authorization", `Bearer ${secretMaterial.webhookSecret}`)
      .set("Idempotency-Key", "test-1").send({ event: "ping" });
    expect(tested.body.status).toBe("test_received");
    expect((await triggerRow()).lastWebhookDelivery).toMatchObject({ status: "received", test: true, previous: null });

    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: false })).status).toBe(200);
    expect((await triggerRow()).lastWebhookDelivery).toBeNull();
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: true })).status).toBe(200);
    // A new test starts clean: nothing reads as "Test event received" before an event arrives.
    expect((await triggerRow()).lastWebhookDelivery).toBeNull();
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("only starts testing on an active, enabled webhook", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Triage alerts", description: "Look at the alert",
    });
    const routineId = created.body.id;
    const webhook = (await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer" })).body.trigger;
    const schedule = (await request(board).post(`/api/routines/${routineId}/triggers`)
      .send({ kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "UTC" })).body.trigger;
    const startTesting = (id: string, extra: Record<string, unknown> = {}) =>
      request(board).patch(`/api/routine-triggers/${id}`).send({ setupPending: true, ...extra });

    const scheduleAttempt = await startTesting(schedule.id);
    expect(scheduleAttempt.status).toBe(422);
    expect(scheduleAttempt.body.error).toBe("Only webhooks can be tested");

    const disablingAttempt = await startTesting(webhook.id, { enabled: false });
    expect(disablingAttempt.status).toBe(409);
    expect((await request(board).patch(`/api/routine-triggers/${webhook.id}`).send({ enabled: false })).status).toBe(200);
    const disabledAttempt = await startTesting(webhook.id);
    expect(disabledAttempt.status).toBe(409);
    expect(disabledAttempt.body.error).toBe("Turn the webhook on before testing it");
    await request(board).patch(`/api/routine-triggers/${webhook.id}`).send({ enabled: true });

    await request(board).patch(`/api/routine-triggers/${webhook.id}`).send({ archived: true });
    const archivedAttempt = await startTesting(webhook.id);
    expect(archivedAttempt.status).toBe(409);
    expect(archivedAttempt.body.error).toBe("This webhook was removed");
    await request(board).patch(`/api/routine-triggers/${webhook.id}`).send({ archived: false });

    await db.update(routines).set({ status: "archived" }).where(eq(routines.id, routineId));
    const archivedRoutineAttempt = await startTesting(webhook.id);
    expect(archivedRoutineAttempt.status).toBe(409);
    expect(archivedRoutineAttempt.body.error).toBe("This routine is archived");

    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, webhook.id)))[0]?.setupPending).toBe(false);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "routine.trigger_test_started"))).toHaveLength(0);
  });

  it("supports creating, scheduling, and manually running a routine through the API", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        activityGatePolicy: "require_external_activity",
        activityGateScope: "project",
      });

    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);
    expect(createRes.body.activityGatePolicy).toBe("require_external_activity");
    expect(createRes.body.activityGateScope).toBe("project");

    const routineId = createRes.body.id as string;

    const updateRes = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        activityGatePolicy: "always",
        activityGateScope: "company",
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.activityGatePolicy).toBe("always");
    expect(updateRes.body.activityGateScope).toBe("company");

    const triggerRes = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect([200, 201], JSON.stringify(triggerRes.body)).toContain(triggerRes.status);
    const createdTrigger = triggerRes.body.trigger ?? triggerRes.body;
    expect(createdTrigger.kind).toBe("schedule");
    expect(createdTrigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "e2e-test" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");
    expect(runRes.body.source).toBe("manual");
    expect(runRes.body.linkedIssueId).toBeTruthy();

    const listRes = await request(app).get(`/api/companies/${companyId}/routines`);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.find((r: { id: string }) => r.id === routineId);
    expect(listed).toBeDefined();
    expect(listed.activityGatePolicy).toBe("always");
    expect(listed.activityGateScope).toBe("company");
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0].cronExpression).toBe("0 10 * * 1-5");
    expect(listed.triggers[0].timezone).toBe("UTC");

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.activityGatePolicy).toBe("always");
    expect(detailRes.body.activityGateScope).toBe("company");
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(createdTrigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    expect(detailRes.body.recentRuns[0]?.id).toBe(runRes.body.id);
    expect(detailRes.body.activeIssue?.id).toBe(runRes.body.linkedIssueId);

    const runsRes = await request(app).get(`/api/routines/${routineId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    const [persistedRun] = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.id, runRes.body.id));
    expect(persistedRun?.id).toBe(runRes.body.id);

    const [issue] = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        originKind: issues.originKind,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toMatchObject({
      id: runRes.body.linkedIssueId,
      originId: routineId,
      originKind: "routine_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "routine.created",
        "routine.trigger_created",
        "routine.run_triggered",
      ]),
    );
  }, 15_000);

  it("runs routines with variable inputs and interpolates the execution issue description", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Repository triage",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        variables: [
          { name: "repo", type: "text", required: true },
          { name: "priority", type: "select", required: true, defaultValue: "high", options: ["high", "low"] },
        ],
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });

    const [issue] = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue?.description).toBe("Review paperclip for high bugs");
  });

  it("defaults activity gates and rejects invalid activity gate values", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Default activity gate",
        assigneeAgentId: agentId,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.activityGatePolicy).toBe("always");
    expect(createRes.body.activityGateScope).toBe("company");

    const invalidCreateRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Invalid activity gate",
        assigneeAgentId: agentId,
        activityGatePolicy: "when_busy",
      });

    expect(invalidCreateRes.status).toBe(400);

    const invalidPatchRes = await request(app)
      .patch(`/api/routines/${createRes.body.id}`)
      .send({ activityGateScope: "agent" });

    expect(invalidPatchRes.status).toBe(400);
  });

  it("allows drafting a routine without defaults and running it with one-off overrides", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        title: "Draft routine",
        description: "No saved defaults",
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);
    expect(createRes.body.projectId ?? null).toBeNull();
    expect(createRes.body.assigneeAgentId ?? null).toBeNull();
    expect(createRes.body.status).toBe("paused");

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");

    const [issue] = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("persists execution workspace selections from manual routine runs", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(instanceSettings).values({
      experimental: { enableIsolatedWorkspaces: true },
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Workspace-aware routine",
        assigneeAgentId: agentId,
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(runRes.status).toBe(202);

    const [issue] = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  describe("an agent acting for the routine's person", () => {
    /** A second agent, working in the person's own chat, so it acts for them. */
    async function helperFor(companyId: string, personUserId: string) {
      const [helper] = await db.insert(agents).values({
        companyId, name: "Helper", role: "general", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      }).returning();
      const [chat] = await db.insert(issues).values({ companyId, title: "Chat", createdByUserId: personUserId, responsibleUserId: personUserId }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: helper!.id, issueId: chat!.id, scopeKind: "issue", status: "running", contextSnapshot: { issueId: chat!.id } }).returning();
      const app = await createApp({
        type: "agent", agentId: helper!.id, companyId, runId: run!.id, source: "agent_jwt",
        onBehalfOfUserId: personUserId, onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }],
      });
      return { app, helperId: helper!.id };
    }

    async function personRoutine(companyId: string, agentId: string, userId: string, values: Record<string, unknown> = {}) {
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const created = await request(board).post(`/api/companies/${companyId}/routines`).send({ assigneeAgentId: agentId, title: "Weekly pipeline", ...values });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.id as string;
    }

    it("reschedules its person's routine run by another agent in one revision, with one schedule however often it races", async () => {
      const { companyId, agentId, userId } = await seedFixture();
      const routineId = await personRoutine(companyId, agentId, userId);
      const { app } = await helperFor(companyId, userId);
      const revisions = async () => db.select().from(routineRevisions).where(eq(routineRevisions.routineId, routineId));
      const before = (await revisions()).length;

      // No zone given, none on the routine and none saved for the person: the agent must name one.
      const unnamed = await request(app).patch(`/api/routines/${routineId}`).send({ title: "Pipeline review", schedule: { cronExpression: "30 9 * * 1" } });
      expect(unnamed.status).toBe(422);
      expect((await revisions()).length).toBe(before);

      await db.insert(userWorkspacePreferences).values({ userId, timeZone: "Europe/Berlin" });
      const changed = await request(app).patch(`/api/routines/${routineId}`).send({ title: "Pipeline review", schedule: { cronExpression: "30 9 * * 1" } });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      const after = await revisions();
      expect(after.length).toBe(before + 1);
      expect(after.find((revision) => revision.revisionNumber === Math.max(...after.map((r) => r.revisionNumber)))?.changeSummary).toBe("Updated routine and schedule");
      const schedules = async () => db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routineId));
      expect(await schedules()).toMatchObject([{ kind: "schedule", enabled: true, cronExpression: "30 9 * * 1", timezone: "Europe/Berlin" }]);

      // Two changes at once: the routine lock keeps one enabled schedule.
      await db.delete(routineTriggers).where(eq(routineTriggers.routineId, routineId));
      const raced = await Promise.all([
        request(app).patch(`/api/routines/${routineId}`).send({ schedule: { cronExpression: "0 8 * * *", timezone: "UTC" } }),
        request(app).patch(`/api/routines/${routineId}`).send({ schedule: { cronExpression: "0 18 * * *", timezone: "UTC" } }),
      ]);
      expect(raced.map((res) => res.status)).toEqual([200, 200]);
      expect((await schedules()).filter((trigger) => trigger.enabled)).toHaveLength(1);

      const off = await request(app).patch(`/api/routines/${routineId}`).send({ schedule: null });
      expect(off.status).toBe(200);
      expect((await schedules()).every((trigger) => !trigger.enabled)).toBe(true);

      // Handing the routine to another person with a new time: the time is in the new person's zone.
      const nextPerson = randomUUID();
      await accessService(db).ensureMembership(companyId, "user", nextPerson, "operator", "active");
      await db.insert(userWorkspacePreferences).values({ userId: nextPerson, timeZone: "Asia/Tokyo" });
      await db.delete(routineTriggers).where(eq(routineTriggers.routineId, routineId));
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const handed = await request(board).patch(`/api/routines/${routineId}`).send({ responsibleUserId: nextPerson, schedule: { cronExpression: "0 9 * * *" } });
      expect(handed.status, JSON.stringify(handed.body)).toBe(200);
      expect(await schedules()).toMatchObject([{ enabled: true, timezone: "Asia/Tokyo" }]);
    });

    it("refuses another person's routine, and needs the person's tasks:assign to take, turn on or reschedule one it does not run", async () => {
      const { companyId, agentId, userId } = await seedFixture();
      const memberId = randomUUID();
      await accessService(db).ensureMembership(companyId, "user", memberId, "operator", "active");
      // A member who may not assign tasks, as under a restricted assignment policy.
      vi.doMock("../services/index.js", async () => {
        const [{ accessService: realAccess }, { documentAnnotationService }, { logActivity }, { routineService }] = await Promise.all([
          import("../services/access.js"), import("../services/document-annotations.js"),
          import("../services/activity-log.js"), import("../services/routines.js"),
        ]);
        const accessService = (database: typeof db) => {
          const access = realAccess(database);
          return { ...access, canUser: async (...args: Parameters<typeof access.canUser>) =>
            (args[1] === memberId && args[2] === "tasks:assign" ? false : access.canUser(...args)) };
        };
        return { accessService, documentAnnotationService, logActivity, routineService };
      });
      const ownersRoutine = await personRoutine(companyId, agentId, userId);
      const membersRoutine = await personRoutine(companyId, agentId, userId, { status: "paused" });
      await db.update(routines).set({ responsibleUserId: memberId }).where(eq(routines.id, membersRoutine));

      const { app: forMember, helperId } = await helperFor(companyId, memberId);
      // Not the member's routine: no change at all.
      expect((await request(forMember).patch(`/api/routines/${ownersRoutine}`).send({ title: "x" })).status).toBe(403);
      // The member's routine: an ordinary change is fine, but the member may not assign tasks.
      expect((await request(forMember).patch(`/api/routines/${membersRoutine}`).send({ title: "Member pipeline" })).status).toBe(200);
      expect((await request(forMember).patch(`/api/routines/${membersRoutine}`).send({ assigneeAgentId: helperId })).status).toBe(403);
      expect((await request(forMember).patch(`/api/routines/${membersRoutine}`).send({ status: "active" })).status).toBe(403);
      expect((await request(forMember).patch(`/api/routines/${membersRoutine}`).send({ schedule: { cronExpression: "0 9 * * 1", timezone: "UTC" } })).status).toBe(403);
      expect((await request(forMember).post(`/api/routines/${membersRoutine}/triggers`).send({ kind: "schedule", cronExpression: "0 9 * * 1", timezone: "UTC" })).status).toBe(403);
      // Nor change an existing trigger, start the routine, or restore a revision of it.
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const trigger = await request(board).post(`/api/routines/${membersRoutine}/triggers`).send({ kind: "schedule", cronExpression: "0 9 * * 1", timezone: "UTC", enabled: false });
      expect(trigger.status, JSON.stringify(trigger.body)).toBe(201);
      expect((await request(forMember).patch(`/api/routine-triggers/${trigger.body.trigger.id}`).send({ enabled: true })).status).toBe(403);
      expect((await request(forMember).delete(`/api/routine-triggers/${trigger.body.trigger.id}`)).status).toBe(403);
      expect((await request(forMember).post(`/api/routines/${membersRoutine}/run`).send({})).status).toBe(403);
      const [revision] = await db.select().from(routineRevisions).where(eq(routineRevisions.routineId, membersRoutine)).limit(1);
      expect((await request(forMember).post(`/api/routines/${membersRoutine}/revisions/${revision!.id}/restore`).send({})).status).toBe(403);

      // The owner may assign tasks, so an agent acting for them may take the routine.
      const { app: forOwner, helperId: ownersHelper } = await helperFor(companyId, userId);
      const taken = await request(forOwner).patch(`/api/routines/${ownersRoutine}`).send({ assigneeAgentId: ownersHelper });
      expect(taken.status, JSON.stringify(taken.body)).toBe(200);
      // The agent that runs a routine still reschedules its own, also through its trigger.
      const runner = await createApp({ type: "agent", agentId, companyId });
      expect((await request(runner).patch(`/api/routines/${membersRoutine}`).send({ schedule: { cronExpression: "0 9 * * 1", timezone: "UTC" } })).status).toBe(200);
      expect((await request(runner).patch(`/api/routine-triggers/${trigger.body.trigger.id}`).send({ cronExpression: "0 10 * * 1" })).status).toBe(200);
    });

    it("filters the list in the query: words, status and routines filed under no responsibility", async () => {
      const { companyId, agentId, userId } = await seedFixture();
      await db.delete(instanceSettings);
      await db.insert(instanceSettings).values({ experimental: { enableResponsibilities: true } });
      const filed = await personRoutine(companyId, agentId, userId, { title: "Pipeline filed" });
      const loose = await personRoutine(companyId, agentId, userId, { title: "Pipeline loose", status: "paused" });
      await personRoutine(companyId, agentId, userId, { title: "Standup" });
      const [hiring] = await db.insert(responsibilities).values({ companyId, ownerUserId: userId, title: "Hiring", status: "active" }).returning();
      await db.insert(responsibilityLinks).values({ companyId, responsibilityId: hiring!.id, routineId: filed });
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const list = async (query: string) => (await request(board).get(`/api/companies/${companyId}/routines?${query}`)).body.map((routine: { id: string }) => routine.id);

      expect(await list("q=PIPELINE")).toEqual(expect.arrayContaining([filed, loose]));
      expect(await list("q=PIPELINE")).toHaveLength(2);
      expect(await list("q=pipeline&unfiled=true&status=paused")).toEqual([loose]);
      expect(await list(`responsibilityId=${hiring!.id}`)).toEqual([filed]);

      // The responsibility filters are part of the Responsibilities experiment; plain searches are not.
      await db.update(instanceSettings).set({ experimental: { enableResponsibilities: false } });
      (await import("../services/instance-settings-cache.js")).invalidateInstanceSettingsCache();
      const off = await request(board).get(`/api/companies/${companyId}/routines?unfiled=true`);
      expect(off.status).toBe(404);
      expect(off.body.code).toBe("responsibilities_disabled");
      expect(await list("q=standup")).toHaveLength(1);
    });
  });
});
