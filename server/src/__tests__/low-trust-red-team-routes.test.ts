import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { WebSocketServer } from "ws";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agentRuntimeState,
  agents,
  approvals,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueDocuments,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { LOW_TRUST_QUARANTINED_BODY } from "../services/source-trust.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres low-trust route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type Fixture = Awaited<ReturnType<typeof seedLowTrustFixture>>;

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function deleteHeartbeatRunsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function expectNoCanary(value: unknown, ...markers: string[]) {
  const serialized = JSON.stringify(value);
  for (const marker of markers) expect(serialized).not.toContain(marker);
}

function agentActor(fixture: Fixture, agentId = fixture.agents.lowTrust.id): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId: fixture.company.id,
    runId: agentId === fixture.agents.lowTrust.id ? fixture.runs.lowTrust.id : fixture.runs.standard.id,
    source: "agent_jwt",
  };
}

function boardActor(fixture: Fixture): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [fixture.company.id],
    memberships: [{ companyId: fixture.company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use("/api", issueRoutes(db, {} as any));
  app.use(errorHandler);
  return app;
}

async function createControlledGatewayServer() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const agentPayloads: Array<Record<string, unknown>> = [];
  let firstWaitRelease: (() => void) | null = null;
  let firstWaitGate = new Promise<void>((resolve) => {
    firstWaitRelease = resolve;
  });
  let waitCount = 0;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    socket.on("message", async (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        agentPayloads.push((frame.params ?? {}) as Record<string, unknown>);
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId: typeof frame.params?.idempotencyKey === "string"
                ? frame.params.idempotencyKey
                : `run-${agentPayloads.length}`,
              status: "accepted",
              acceptedAt: Date.now(),
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        waitCount += 1;
        if (waitCount === 1) await firstWaitGate;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId: frame.params?.runId,
              status: "ok",
              startedAt: 1,
              endedAt: 2,
            },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayloads: () => agentPayloads,
    releaseFirstWait: () => {
      firstWaitRelease?.();
      firstWaitRelease = null;
      firstWaitGate = Promise.resolve();
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function snapshot(db: Db) {
  const [
    issueRows,
    commentRows,
    documentRows,
    workProductRows,
    approvalRows,
    relationRows,
    interactionRows,
    wakeRows,
    runRows,
    activityRows,
  ] = await Promise.all([
    db.select().from(issues),
    db.select().from(issueComments),
    db.select().from(documents),
    db.select().from(issueWorkProducts),
    db.select().from(approvals),
    db.select().from(issueRelations),
    db.select().from(issueThreadInteractions),
    db.select().from(agentWakeupRequests),
    db.select().from(heartbeatRuns),
    db.select().from(activityLog),
  ]);
  return {
    issues: issueRows,
    comments: commentRows,
    documents: documentRows,
    workProducts: workProductRows,
    approvals: approvalRows,
    relations: relationRows,
    interactions: interactionRows,
    wakeups: wakeRows,
    runs: runRows,
    activity: activityRows,
  };
}

async function createQuarantinedContinuationSummary(db: Db, fixture: Fixture, issueId: string) {
  const sourceTrust = {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "quarantined" as const,
    sourceIssueId: fixture.issues.assignedReview.id,
    sourceRunId: fixture.runs.lowTrust.id,
    sourceAgentId: fixture.agents.lowTrust.id,
  };
  const [document] = await db.insert(documents).values({
    companyId: fixture.company.id,
    title: "Continuation Summary",
    latestBody: `Continuation must not leak ${fixture.canaries.raw}`,
    createdByAgentId: fixture.agents.lowTrust.id,
    updatedByAgentId: fixture.agents.lowTrust.id,
    sourceTrust,
  }).returning();
  const [revision] = await db.insert(documentRevisions).values({
    companyId: fixture.company.id,
    documentId: document!.id,
    revisionNumber: 1,
    title: "Continuation Summary",
    body: `Continuation must not leak ${fixture.canaries.raw}`,
    createdByAgentId: fixture.agents.lowTrust.id,
  }).returning();
  await db.update(documents).set({ latestRevisionId: revision!.id }).where(eq(documents.id, document!.id));
  await db.insert(issueDocuments).values({
    companyId: fixture.company.id,
    issueId,
    documentId: document!.id,
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  });
  return document!;
}

async function seedLowTrustFixture(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const canary = (label: string) => `LT_REDTEAM_${nonce}_${label}`;
  const canaries = {
    issueSibling: canary("FLAG-ISSUE-SIBLING-7R4G"),
    commentSibling: canary("FLAG-COMMENT-SIBLING-7R4G"),
    documentSibling: canary("FLAG-DOC-SIBLING-7R4G"),
    workProductSibling: canary("FLAG-WP-SIBLING-7R4G"),
    approval: canary("FLAG-APPROVAL-7R4G"),
    agentConfig: canary("FLAG-AGENTCFG-7R4G"),
    raw: canary("IGNORE_ALL_PREVIOUS_INSTRUCTIONS FLAG-RAW-7R4G"),
  };

  const [company] = await db.insert(companies).values({
    name: `Low trust ${nonce}`,
    issuePrefix: `LT${nonce.slice(0, 4).toUpperCase()}`,
  }).returning();
  const [allowedProject] = await db.insert(projects).values({
    companyId: company!.id,
    name: `Allowed ${nonce}`,
    status: "in_progress",
  }).returning();
  const [outOfScopeProject] = await db.insert(projects).values({
    companyId: company!.id,
    name: `Out ${nonce}`,
    description: canary("FLAG-PROJECT-7R4G"),
    status: "in_progress",
  }).returning();

  const [collaborator] = await db.insert(agents).values({
    companyId: company!.id,
    name: "Same Boundary Collaborator",
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  }).returning();
  const [standard] = await db.insert(agents).values({
    companyId: company!.id,
    name: "Standard Engineer",
    role: "engineer",
    adapterType: "process",
    adapterConfig: { token: canaries.agentConfig },
    runtimeConfig: { env: { SECRET_MARKER: canaries.agentConfig } },
    permissions: {},
  }).returning();
  const [cto] = await db.insert(agents).values({
    companyId: company!.id,
    name: "CTO",
    role: "cto",
    adapterType: "process",
    adapterConfig: { token: canaries.agentConfig },
    runtimeConfig: { env: { SECRET_MARKER: canaries.agentConfig } },
    permissions: {},
  }).returning();

  const [reviewRoot] = await db.insert(issues).values({
    companyId: company!.id,
    projectId: allowedProject!.id,
    title: "Review root",
    status: "todo",
    priority: "medium",
  }).returning();
  const [assignedReview] = await db.insert(issues).values({
    companyId: company!.id,
    projectId: allowedProject!.id,
    parentId: reviewRoot!.id,
    title: "Assigned low-trust review",
    status: "in_progress",
    priority: "medium",
  }).returning();
  const [sameBoundaryChild] = await db.insert(issues).values({
    companyId: company!.id,
    projectId: allowedProject!.id,
    parentId: reviewRoot!.id,
    title: "Same boundary child",
    status: "todo",
    priority: "medium",
  }).returning();
  const [siblingOutOfScope] = await db.insert(issues).values({
    companyId: company!.id,
    projectId: outOfScopeProject!.id,
    title: `Sibling ${canaries.issueSibling}`,
    description: canaries.issueSibling,
    status: "todo",
    priority: "medium",
  }).returning();

  const [lowTrust] = await db.insert(agents).values({
    companyId: company!.id,
    name: "Low Trust Reviewer",
    role: "engineer",
    adapterType: "process",
    adapterConfig: { token: canaries.agentConfig },
    runtimeConfig: { env: { SECRET_MARKER: canaries.agentConfig } },
    permissions: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: {
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: company!.id,
          projectIds: [allowedProject!.id],
          rootIssueId: reviewRoot!.id,
          issueIds: [reviewRoot!.id, assignedReview!.id, sameBoundaryChild!.id],
          allowedAgentIds: [collaborator!.id],
        },
      },
    },
  }).returning();

  await db.update(issues).set({ assigneeAgentId: lowTrust!.id }).where(eq(issues.id, assignedReview!.id));
  assignedReview!.assigneeAgentId = lowTrust!.id;

  const executionPolicy = {
    authorizationPolicy: {
      trustBoundary: (lowTrust!.permissions as any).authorizationPolicy.trustBoundary,
    },
  };
  const [lowTrustRun] = await db.insert(heartbeatRuns).values({
    companyId: company!.id,
    agentId: lowTrust!.id,
    status: "running",
    contextSnapshot: {
      issueId: assignedReview!.id,
      executionPolicy,
    },
  }).returning();
  const [standardRun] = await db.insert(heartbeatRuns).values({
    companyId: company!.id,
    agentId: standard!.id,
    status: "running",
    contextSnapshot: { issueId: assignedReview!.id },
  }).returning();
  await db.update(issues).set({
    checkoutRunId: lowTrustRun!.id,
    executionRunId: lowTrustRun!.id,
    executionPolicy,
  }).where(eq(issues.id, assignedReview!.id));
  assignedReview!.checkoutRunId = lowTrustRun!.id;
  assignedReview!.executionRunId = lowTrustRun!.id;
  assignedReview!.executionPolicy = executionPolicy;

  await db.insert(issueComments).values({
    companyId: company!.id,
    issueId: siblingOutOfScope!.id,
    authorAgentId: standard!.id,
    authorType: "agent",
    body: canaries.commentSibling,
  });
  const [siblingDoc] = await db.insert(documents).values({
    companyId: company!.id,
    title: "Sibling doc",
    latestBody: canaries.documentSibling,
    createdByAgentId: standard!.id,
    updatedByAgentId: standard!.id,
  }).returning();
  const [siblingRevision] = await db.insert(documentRevisions).values({
    companyId: company!.id,
    documentId: siblingDoc!.id,
    revisionNumber: 1,
    title: "Sibling doc",
    body: canaries.documentSibling,
    createdByAgentId: standard!.id,
  }).returning();
  await db.update(documents).set({ latestRevisionId: siblingRevision!.id }).where(eq(documents.id, siblingDoc!.id));
  await db.insert(issueDocuments).values({
    companyId: company!.id,
    issueId: siblingOutOfScope!.id,
    documentId: siblingDoc!.id,
    key: "canary",
  });
  await db.insert(issueWorkProducts).values({
    companyId: company!.id,
    projectId: outOfScopeProject!.id,
    issueId: siblingOutOfScope!.id,
    type: "artifact",
    provider: "test",
    title: "Sibling work product",
    status: "active",
    summary: canaries.workProductSibling,
  });
  const [approval] = await db.insert(approvals).values({
    companyId: company!.id,
    type: "request_board_approval",
    requestedByAgentId: standard!.id,
    status: "pending",
    payload: { summary: canaries.approval },
  }).returning();
  await db.insert(issueApprovals).values({
    companyId: company!.id,
    issueId: assignedReview!.id,
    approvalId: approval!.id,
    linkedByAgentId: standard!.id,
  });

  return {
    company: company!,
    agents: { lowTrust: lowTrust!, standard: standard!, collaborator: collaborator!, cto: cto! },
    projects: { allowed: allowedProject!, outOfScope: outOfScopeProject! },
    issues: { reviewRoot: reviewRoot!, assignedReview: assignedReview!, sameBoundaryChild: sameBoundaryChild!, siblingOutOfScope: siblingOutOfScope! },
    approvals: { issueLinkedCanary: approval! },
    runs: { lowTrust: lowTrustRun!, standard: standardRun! },
    canaries,
  };
}

describeEmbeddedPostgres("low-trust red-team HTTP route regression suite", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-low-trust-red-team-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await deleteHeartbeatRunsAfterActivityLogDrains(db);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows bounded same-issue reads and writes while quarantining low-trust output", async () => {
    const fixture = await seedLowTrustFixture(db);
    const app = createApp(db, agentActor(fixture));

    const issueRead = await request(app).get(`/api/issues/${fixture.issues.assignedReview.id}`);
    expect(issueRead.status, JSON.stringify(issueRead.body)).toBe(200);
    expectNoCanary(issueRead.body, fixture.canaries.issueSibling, fixture.canaries.documentSibling);

    const comment = await request(app)
      .post(`/api/issues/${fixture.issues.assignedReview.id}/comments`)
      .send({ body: `review note ${fixture.canaries.raw}` });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    expect(comment.body.sourceTrust).toMatchObject({
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "quarantined",
      sourceIssueId: fixture.issues.assignedReview.id,
      sourceRunId: fixture.runs.lowTrust.id,
      sourceAgentId: fixture.agents.lowTrust.id,
    });

    const document = await request(app)
      .put(`/api/issues/${fixture.issues.assignedReview.id}/documents/review-notes`)
      .send({ format: "markdown", body: `notes ${fixture.canaries.raw}` });
    expect(document.status, JSON.stringify(document.body)).toBe(201);
    expect(document.body.sourceTrust).toMatchObject({
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "quarantined",
    });

    const workProduct = await request(app)
      .post(`/api/issues/${fixture.issues.assignedReview.id}/work-products`)
      .send({
        type: "artifact",
        provider: "test",
        title: "Review artifact",
        status: "active",
        summary: `artifact ${fixture.canaries.raw}`,
      });
    expect(workProduct.status, JSON.stringify(workProduct.body)).toBe(201);
    expect(workProduct.body.sourceTrust).toMatchObject({
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "quarantined",
    });
  });

  it("allows mentioned low-trust agents to comment on out-of-bound assigned issues", async () => {
    const fixture = await seedLowTrustFixture(db);
    const [targetIssue] = await db.insert(issues).values({
      companyId: fixture.company.id,
      projectId: fixture.projects.outOfScope.id,
      title: "Coach-owned mention target",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: fixture.agents.standard.id,
    }).returning();
    await db.insert(issueComments).values({
      companyId: fixture.company.id,
      issueId: targetIssue!.id,
      authorAgentId: fixture.agents.standard.id,
      authorType: "agent",
      body: `[@Low Trust Reviewer](agent://${fixture.agents.lowTrust.id}) please verify this issue.`,
    });

    const unmentioned = await db.insert(agents).values({
      companyId: fixture.company.id,
      name: "Unmentioned Low Trust Reviewer",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: fixture.agents.lowTrust.permissions,
    }).returning().then((rows) => rows[0]!);

    const comment = await request(createApp(db, agentActor(fixture)))
      .post(`/api/issues/${targetIssue!.id}/comments`)
      .send({ body: "Mention-scoped verification complete." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    expect(comment.body).toMatchObject({
      issueId: targetIssue!.id,
      authorAgentId: fixture.agents.lowTrust.id,
    });

    const unmentionedComment = await request(createApp(db, agentActor(fixture, unmentioned.id)))
      .post(`/api/issues/${targetIssue!.id}/comments`)
      .send({ body: "I was not mentioned." });
    expect(unmentionedComment.status, JSON.stringify(unmentionedComment.body)).toBe(403);
    expect(unmentionedComment.body.error).toBe("Issue is outside this actor's authorization boundary");
  });

  it("propagates denied low-trust policy conflicts on control-plane guards", async () => {
    const fixture = await seedLowTrustFixture(db);
    const conflictingExecutionPolicy = {
      authorizationPolicy: {
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: fixture.company.id,
          rootIssueId: fixture.issues.siblingOutOfScope.id,
        },
      },
    };
    await db.update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId: fixture.issues.assignedReview.id,
          executionPolicy: conflictingExecutionPolicy,
        },
      })
      .where(eq(heartbeatRuns.id, fixture.runs.lowTrust.id));

    const res = await request(createApp(db, agentActor(fixture)))
      .get(`/api/issues/${fixture.issues.assignedReview.id}/approvals`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Low-trust boundary root issue scopes do not overlap.");
  });

  it("restricts low-trust self inspection without changing standard-agent visibility", async () => {
    const fixture = await seedLowTrustFixture(db);

    const lowTrustRes = await request(createApp(db, agentActor(fixture))).get("/api/agents/me");
    expect(lowTrustRes.status, JSON.stringify(lowTrustRes.body)).toBe(200);
    expect(lowTrustRes.body).toMatchObject({
      id: fixture.agents.lowTrust.id,
      companyId: fixture.company.id,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
    });
    expect(lowTrustRes.body).not.toHaveProperty("adapterConfig");
    expect(lowTrustRes.body).not.toHaveProperty("runtimeConfig");
    expect(lowTrustRes.body).not.toHaveProperty("permissions");
    expect(lowTrustRes.body).not.toHaveProperty("access");
    expectNoCanary(lowTrustRes.body, fixture.canaries.agentConfig);

    const lowTrustSelfByIdRes = await request(createApp(db, agentActor(fixture)))
      .get(`/api/agents/${fixture.agents.lowTrust.id}`);
    expect(lowTrustSelfByIdRes.status, JSON.stringify(lowTrustSelfByIdRes.body)).toBe(200);
    expect(lowTrustSelfByIdRes.body).toMatchObject({
      id: fixture.agents.lowTrust.id,
      companyId: fixture.company.id,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
    });
    expect(lowTrustSelfByIdRes.body).not.toHaveProperty("adapterConfig");
    expect(lowTrustSelfByIdRes.body).not.toHaveProperty("runtimeConfig");
    expect(lowTrustSelfByIdRes.body).not.toHaveProperty("permissions");
    expect(lowTrustSelfByIdRes.body).not.toHaveProperty("access");
    expectNoCanary(lowTrustSelfByIdRes.body, fixture.canaries.agentConfig);

    const standardActor = agentActor(fixture, fixture.agents.standard.id);
    const standardRes = await request(createApp(db, { ...standardActor, runId: null })).get("/api/agents/me");
    expect(standardRes.status, JSON.stringify(standardRes.body)).toBe(200);
    expect(JSON.stringify(standardRes.body)).toContain(fixture.canaries.agentConfig);

    const issueScopedLowTrustRes = await request(createApp(db, standardActor)).get("/api/agents/me");
    expect(issueScopedLowTrustRes.status, JSON.stringify(issueScopedLowTrustRes.body)).toBe(200);
    expect(issueScopedLowTrustRes.body).toMatchObject({
      id: fixture.agents.standard.id,
      companyId: fixture.company.id,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
    });
    expect(issueScopedLowTrustRes.body).not.toHaveProperty("adapterConfig");
    expect(issueScopedLowTrustRes.body).not.toHaveProperty("runtimeConfig");
    expectNoCanary(issueScopedLowTrustRes.body, fixture.canaries.agentConfig);

    await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, fixture.issues.assignedReview.id));

    await db.update(projects).set({
      executionWorkspacePolicy: {
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: fixture.company.id,
            projectIds: [fixture.projects.allowed.id],
          },
        },
      },
    }).where(eq(projects.id, fixture.projects.allowed.id));

    const projectScopedLowTrustRes = await request(createApp(db, agentActor(fixture, fixture.agents.standard.id))).get("/api/agents/me");
    expect(projectScopedLowTrustRes.status, JSON.stringify(projectScopedLowTrustRes.body)).toBe(200);
    expect(projectScopedLowTrustRes.body).toMatchObject({
      id: fixture.agents.standard.id,
      companyId: fixture.company.id,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
    });
    expect(projectScopedLowTrustRes.body).not.toHaveProperty("adapterConfig");
    expect(projectScopedLowTrustRes.body).not.toHaveProperty("runtimeConfig");
    expectNoCanary(projectScopedLowTrustRes.body, fixture.canaries.agentConfig);
  });

  it("denies out-of-bound and control-plane attempts without leaking canaries or creating durable side effects", async () => {
    const fixture = await seedLowTrustFixture(db);
    const app = createApp(db, agentActor(fixture));
    const forbiddenMarkers = Object.values(fixture.canaries);

    const attempts = [
      {
        id: "LT-02",
        req: () => request(app).get(`/api/issues/${fixture.issues.siblingOutOfScope.id}`),
      },
      {
        id: "LT-08",
        req: () => request(app).get(`/api/issues/${fixture.issues.siblingOutOfScope.id}/documents/canary`),
      },
      {
        id: "LT-15/16",
        req: () => request(app).get(`/api/agents/${fixture.agents.cto.id}`),
      },
      {
        id: "LT-19",
        req: () => request(app).get(`/api/issues/${fixture.issues.assignedReview.id}/approvals`),
      },
      {
        id: "LT-26 child",
        req: () => request(app)
          .post(`/api/issues/${fixture.issues.assignedReview.id}/children`)
          .send({ title: `child ${fixture.canaries.issueSibling}` }),
      },
      {
        id: "LT-26 company issue",
        req: () => request(app)
          .post(`/api/companies/${fixture.company.id}/issues`)
          .send({ title: `child ${fixture.canaries.issueSibling}`, parentId: fixture.issues.assignedReview.id }),
      },
      {
        id: "LT-26 interaction",
        req: () => request(app)
          .post(`/api/issues/${fixture.issues.assignedReview.id}/interactions`)
          .send({
            kind: "ask_user_questions",
            title: "exfil",
            payload: {
              version: 1,
              questions: [{
                id: "q1",
                prompt: fixture.canaries.approval,
                selectionMode: "single",
                options: [
                  { id: "a", label: "A", description: "A" },
                  { id: "b", label: "B", description: "B" },
                ],
              }],
            },
          }),
      },
      {
        id: "LT-06 resume",
        req: () => request(app)
          .post(`/api/issues/${fixture.issues.assignedReview.id}/comments`)
          .send({ body: "resume please", resume: true }),
      },
      {
        id: "LT-06 blocker mutation",
        req: () => request(app)
          .patch(`/api/issues/${fixture.issues.assignedReview.id}`)
          .send({ comment: "add blocker", blockedByIssueIds: [fixture.issues.siblingOutOfScope.id] }),
      },
    ];

    for (const attempt of attempts) {
      const before = await snapshot(db);
      const res = await attempt.req();
      expect(res.status, `${attempt.id}: ${JSON.stringify(res.body)}`).toBe(403);
      expectNoCanary(res.body, ...forbiddenMarkers);
      const after = await snapshot(db);
      expect(after.issues.length, attempt.id).toBe(before.issues.length);
      expect(after.comments.length, attempt.id).toBe(before.comments.length);
      expect(after.documents.length, attempt.id).toBe(before.documents.length);
      expect(after.workProducts.length, attempt.id).toBe(before.workProducts.length);
      expect(after.approvals.length, attempt.id).toBe(before.approvals.length);
      expect(after.relations.length, attempt.id).toBe(before.relations.length);
      expect(after.interactions.length, attempt.id).toBe(before.interactions.length);
      expect(after.wakeups.length, attempt.id).toBe(before.wakeups.length);
      expect(after.runs.length, attempt.id).toBe(before.runs.length);
    }
  });

  it("counts blocked inbox issues with the low-trust boundary applied in the database", async () => {
    const fixture = await seedLowTrustFixture(db);
    await db.insert(issues).values([
      {
        companyId: fixture.company.id,
        projectId: fixture.projects.allowed.id,
        parentId: fixture.issues.reviewRoot.id,
        title: "Visible blocked vendor wait",
        status: "blocked",
        priority: "medium",
        description: "external owner: Visible vendor\nexternal action: Finish visible review",
      },
      {
        companyId: fixture.company.id,
        projectId: fixture.projects.outOfScope.id,
        title: "Hidden blocked vendor wait",
        status: "blocked",
        priority: "medium",
        description: "external owner: Hidden vendor\nexternal action: Finish hidden review",
      },
    ]);

    const boardCount = await request(createApp(db, boardActor(fixture)))
      .get(`/api/companies/${fixture.company.id}/issues/count`)
      .query({ attention: "blocked", q: "blocked vendor wait" });
    expect(boardCount.status, JSON.stringify(boardCount.body)).toBe(200);
    expect(boardCount.body.count).toBe(2);

    const lowTrustCount = await request(createApp(db, agentActor(fixture)))
      .get(`/api/companies/${fixture.company.id}/issues/count`)
      .query({ attention: "blocked", q: "blocked vendor wait" });
    expect(lowTrustCount.status, JSON.stringify(lowTrustCount.body)).toBe(200);
    expect(lowTrustCount.body.count).toBe(1);
  });

  it("redacts quarantined low-trust output from higher-trust wake and continuation contexts", async () => {
    const fixture = await seedLowTrustFixture(db);
    const lowTrustApp = createApp(db, agentActor(fixture));
    const standardApp = createApp(db, agentActor(fixture, fixture.agents.standard.id));
    const gateway = await createControlledGatewayServer();
    const heartbeat = heartbeatService(db);

    try {
      const comment = await request(lowTrustApp)
        .post(`/api/issues/${fixture.issues.assignedReview.id}/comments`)
        .send({
          body: `malicious result ${fixture.canaries.raw}`,
        });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);
      await db.update(issueComments).set({
        metadata: { canary: fixture.canaries.raw },
        presentation: { markdown: fixture.canaries.raw },
      }).where(eq(issueComments.id, comment.body.id));

      await createQuarantinedContinuationSummary(db, fixture, fixture.issues.reviewRoot.id);

      const lowTrustContext = await request(lowTrustApp)
        .get(`/api/issues/${fixture.issues.assignedReview.id}/heartbeat-context`)
        .query({ wakeCommentId: comment.body.id });
      expect(lowTrustContext.status, JSON.stringify(lowTrustContext.body)).toBe(200);
      expect(JSON.stringify(lowTrustContext.body.wakeComment)).toContain(fixture.canaries.raw);

      const higherTrustContext = await request(standardApp)
        .get(`/api/issues/${fixture.issues.reviewRoot.id}/heartbeat-context`);
      expect(higherTrustContext.status, JSON.stringify(higherTrustContext.body)).toBe(200);
      expect(higherTrustContext.body.continuationSummary).toMatchObject({
        body: LOW_TRUST_QUARANTINED_BODY,
        sourceTrust: {
          preset: LOW_TRUST_REVIEW_PRESET,
          disposition: "quarantined",
          sourceIssueId: fixture.issues.assignedReview.id,
          sourceRunId: fixture.runs.lowTrust.id,
          sourceAgentId: fixture.agents.lowTrust.id,
        },
      });
      expectNoCanary(higherTrustContext.body, fixture.canaries.raw);

      const bogusRunStandardApp = createApp(db, {
        ...agentActor(fixture, fixture.agents.standard.id),
        runId: randomUUID(),
      });
      const bogusRunContext = await request(bogusRunStandardApp)
        .get(`/api/issues/${fixture.issues.reviewRoot.id}/heartbeat-context`);
      expect(bogusRunContext.status, JSON.stringify(bogusRunContext.body)).toBe(200);
      expect(bogusRunContext.body.continuationSummary).toMatchObject({
        body: LOW_TRUST_QUARANTINED_BODY,
        sourceTrust: {
          preset: LOW_TRUST_REVIEW_PRESET,
          disposition: "quarantined",
        },
      });
      expectNoCanary(bogusRunContext.body, fixture.canaries.raw);

      await db.update(agents).set({
        status: "idle",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: gateway.url,
          headers: {
            "x-openclaw-token": "gateway-token",
          },
          payloadTemplate: {
            message: "wake now",
          },
          waitTimeoutMs: 2_000,
        },
      }).where(eq(agents.id, fixture.agents.standard.id));

      const run = await heartbeat.wakeup(fixture.agents.standard.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: {
          issueId: fixture.issues.reviewRoot.id,
          commentId: comment.body.id,
        },
        contextSnapshot: {
          issueId: fixture.issues.reviewRoot.id,
          taskId: fixture.issues.reviewRoot.id,
          wakeReason: "issue_commented",
          livenessContinuationAttempt: 1,
          livenessContinuationMaxAttempts: 2,
          livenessContinuationSourceRunId: fixture.runs.lowTrust.id,
          livenessContinuationState: "quarantined_low_trust_handoff",
          livenessContinuationReason: "Low-trust review output requires sanitized follow-up.",
          livenessContinuationInstruction: "Continue from the sanitized quarantine stub only.",
        },
        requestedByActorType: "system",
        requestedByActorId: null,
      });

      expect(run).not.toBeNull();
      await waitFor(() => gateway.getAgentPayloads().length === 1, 30_000);
      const payload = gateway.getAgentPayloads()[0] ?? {};
      expect(payload.paperclip).toMatchObject({
        wake: {
          reason: "issue_commented",
          issue: {
            id: fixture.issues.reviewRoot.id,
            title: fixture.issues.reviewRoot.title,
          },
          latestCommentId: comment.body.id,
          commentIds: [comment.body.id],
          comments: [
            {
              id: comment.body.id,
              issueId: fixture.issues.assignedReview.id,
              body: LOW_TRUST_QUARANTINED_BODY,
              presentation: null,
              metadata: null,
              sourceTrust: {
                preset: LOW_TRUST_REVIEW_PRESET,
                disposition: "quarantined",
                sourceIssueId: fixture.issues.assignedReview.id,
                sourceRunId: fixture.runs.lowTrust.id,
                sourceAgentId: fixture.agents.lowTrust.id,
              },
            },
          ],
          continuationSummary: {
            body: LOW_TRUST_QUARANTINED_BODY,
            sourceTrust: {
              preset: LOW_TRUST_REVIEW_PRESET,
              disposition: "quarantined",
            },
          },
          livenessContinuation: {
            attempt: 1,
            maxAttempts: 2,
            sourceRunId: fixture.runs.lowTrust.id,
            state: "quarantined_low_trust_handoff",
            reason: "Low-trust review output requires sanitized follow-up.",
            instruction: "Continue from the sanitized quarantine stub only.",
          },
        },
      });
      expect(String(payload.message ?? "")).toContain("## Paperclip Wake Payload");
      expectNoCanary(payload, fixture.canaries.raw);
      gateway.releaseFirstWait();
      await waitFor(async () => {
        const status = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run!.id))
          .then((rows) => rows[0]?.status ?? null);
        return status === "succeeded" || status === "failed" || status === "cancelled";
      }, 30_000);
    } finally {
      gateway.releaseFirstWait();
      await gateway.close();
    }
  }, 120_000);

  it("keeps board positive controls for issue-linked approvals and sanitized promotion", async () => {
    const fixture = await seedLowTrustFixture(db);
    const app = createApp(db, boardActor(fixture));

    const approvalsRes = await request(app).get(`/api/issues/${fixture.issues.assignedReview.id}/approvals`);
    expect(approvalsRes.status, JSON.stringify(approvalsRes.body)).toBe(200);
    expect(JSON.stringify(approvalsRes.body)).toContain(fixture.canaries.approval);

    const [rawProduct] = await db.insert(issueWorkProducts).values({
      companyId: fixture.company.id,
      projectId: fixture.projects.allowed.id,
      issueId: fixture.issues.assignedReview.id,
      type: "artifact",
      provider: "test",
      title: "Quarantined raw artifact",
      status: "active",
      summary: fixture.canaries.raw,
      sourceTrust: {
        preset: LOW_TRUST_REVIEW_PRESET,
        disposition: "quarantined",
        sourceIssueId: fixture.issues.assignedReview.id,
        sourceRunId: fixture.runs.lowTrust.id,
        sourceAgentId: fixture.agents.lowTrust.id,
      },
    }).returning();

    const [otherCompany] = await db.insert(companies).values({
      name: "Foreign low-trust source",
      issuePrefix: `FGN${randomUUID().slice(0, 4).toUpperCase()}`,
    }).returning();
    const [foreignIssue] = await db.insert(issues).values({
      companyId: otherCompany!.id,
      parentId: fixture.issues.assignedReview.id,
      title: "Foreign quarantined issue",
      status: "done",
      priority: "medium",
      sourceTrust: {
        preset: LOW_TRUST_REVIEW_PRESET,
        disposition: "quarantined",
        sourceIssueId: fixture.issues.assignedReview.id,
        sourceRunId: fixture.runs.lowTrust.id,
        sourceAgentId: fixture.agents.lowTrust.id,
      },
    }).returning();

    const rejectedPromotion = await request(app)
      .post(`/api/issues/${fixture.issues.assignedReview.id}/low-trust/promotions`)
      .send({
        sourceArtifactKind: "issue",
        sourceArtifactId: foreignIssue!.id,
        title: "Rejected foreign issue",
        summary: "Should not promote across company boundaries.",
      });
    expect(rejectedPromotion.status, JSON.stringify(rejectedPromotion.body)).toBe(404);
    expect(rejectedPromotion.body.error).toBe("Low-trust source artifact not found");

    const promotion = await request(app)
      .post(`/api/issues/${fixture.issues.assignedReview.id}/low-trust/promotions`)
      .send({
        sourceArtifactKind: "work_product",
        sourceArtifactId: rawProduct!.id,
        title: "Sanitized finding",
        summary: "Sanitized summary without raw instructions.",
      });
    expect(promotion.status, JSON.stringify(promotion.body)).toBe(201);
    expect(promotion.body.sourceTrust).toMatchObject({
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "promoted",
      sourceIssueId: fixture.issues.assignedReview.id,
      promotedFrom: {
        artifactKind: "work_product",
        artifactId: rawProduct!.id,
        issueId: fixture.issues.assignedReview.id,
      },
      promotedByActorType: "user",
      promotedByActorId: "board-user",
    });
    expect(promotion.body).toMatchObject({
      externalId: rawProduct!.id,
      metadata: {
        promotion: {
          sourceArtifactKind: "work_product",
          sourceArtifactId: rawProduct!.id,
        },
      },
      createdByRunId: null,
    });
    expect(typeof promotion.body.sourceTrust.promotedAt).toBe("string");
    expectNoCanary(promotion.body, fixture.canaries.raw);

    const [promotedSource] = await db
      .select({ sourceTrust: issueWorkProducts.sourceTrust })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, rawProduct!.id));
    expect(promotedSource?.sourceTrust).toMatchObject({
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "promoted",
      promotedFrom: {
        artifactKind: "work_product",
        artifactId: rawProduct!.id,
        issueId: fixture.issues.assignedReview.id,
      },
      promotedByActorType: "user",
      promotedByActorId: "board-user",
    });

    const duplicatePromotion = await request(app)
      .post(`/api/issues/${fixture.issues.assignedReview.id}/low-trust/promotions`)
      .send({
        sourceArtifactKind: "work_product",
        sourceArtifactId: rawProduct!.id,
        title: "Duplicate sanitized finding",
        summary: "Should not create another promoted artifact.",
      });
    expect(duplicatePromotion.status, JSON.stringify(duplicatePromotion.body)).toBe(422);
    expect(duplicatePromotion.body.error).toBe("Source artifact is not quarantined low-trust output");

    const productsForSource = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.externalId, rawProduct!.id));
    expect(productsForSource).toHaveLength(1);
  });
});
