import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  inboxDismissals,
  invites,
  joinRequests,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { inboxDismissalService } from "../services/inbox-dismissals.ts";
import { sidebarBadgeService } from "../services/sidebar-badges.ts";
import { errorHandler } from "../middleware/error-handler.js";
import { inboxDismissalRoutes } from "../routes/inbox-dismissals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres inbox dismissal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("inbox dismissals", () => {
  let db!: ReturnType<typeof createDb>;
  let dismissalsSvc!: ReturnType<typeof inboxDismissalService>;
  let badgesSvc!: ReturnType<typeof sidebarBadgeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-dismissals-");
    db = createDb(tempDb.connectionString);
    dismissalsSvc = inboxDismissalService(db);
    badgesSvc = sidebarBadgeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(inboxDismissals);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(heartbeatRuns);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("upserts a single dismissal record per user and inbox item key", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const firstDismissedAt = new Date("2026-03-11T01:00:00.000Z");
    const secondDismissedAt = new Date("2026-03-11T02:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await dismissalsSvc.dismiss(companyId, userId, "approval:approval-1", firstDismissedAt);
    await dismissalsSvc.dismiss(companyId, userId, "approval:approval-1", secondDismissedAt);

    const dismissals = await dismissalsSvc.list(companyId, userId);

    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]?.itemKey).toBe("approval:approval-1");
    expect(new Date(dismissals[0]?.dismissedAt ?? 0).toISOString()).toBe(secondDismissedAt.toISOString());
  });

  function createInboxDismissalApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", inboxDismissalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("honors dismissal timestamps and resurfaces approvals with newer activity", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const primaryAgentId = randomUUID();
    const secondaryAgentId = randomUUID();
    const hiddenApprovalId = randomUUID();
    const resurfacedApprovalId = randomUUID();
    const inviteId = randomUUID();
    const hiddenJoinRequestId = randomUUID();
    const hiddenRunId = randomUUID();
    const visibleRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: primaryAgentId,
        companyId,
        name: "Primary",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondaryAgentId,
        companyId,
        name: "Secondary",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(approvals).values([
      {
        id: hiddenApprovalId,
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      },
      {
        id: resurfacedApprovalId,
        companyId,
        type: "hire_agent",
        status: "revision_requested",
        payload: {},
        updatedAt: new Date("2026-03-11T03:00:00.000Z"),
      },
    ]);

    await db.insert(invites).values({
      id: inviteId,
      companyId,
      inviteType: "company_join",
      tokenHash: "hash-1",
      allowedJoinTypes: "both",
      expiresAt: new Date("2026-03-12T00:00:00.000Z"),
    });

    await db.insert(joinRequests).values({
      id: hiddenJoinRequestId,
      inviteId,
      companyId,
      requestType: "human",
      status: "pending_approval",
      requestIp: "127.0.0.1",
      createdAt: new Date("2026-03-11T01:00:00.000Z"),
      updatedAt: new Date("2026-03-11T01:00:00.000Z"),
    });

    await db.insert(heartbeatRuns).values([
      {
        id: hiddenRunId,
        companyId,
        agentId: primaryAgentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: new Date("2026-03-11T01:00:00.000Z"),
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      },
      {
        id: visibleRunId,
        companyId,
        agentId: secondaryAgentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: new Date("2026-03-11T04:00:00.000Z"),
        updatedAt: new Date("2026-03-11T04:00:00.000Z"),
      },
    ]);

    await dismissalsSvc.dismiss(companyId, userId, `approval:${hiddenApprovalId}`, new Date("2026-03-11T02:00:00.000Z"));
    await dismissalsSvc.dismiss(companyId, userId, `approval:${resurfacedApprovalId}`, new Date("2026-03-11T02:00:00.000Z"));
    await dismissalsSvc.dismiss(companyId, userId, `join:${hiddenJoinRequestId}`, new Date("2026-03-11T02:00:00.000Z"));
    await dismissalsSvc.dismiss(companyId, userId, `run:${hiddenRunId}`, new Date("2026-03-11T02:00:00.000Z"));

    const dismissedAtByKey = new Map(
      (await dismissalsSvc.list(companyId, userId)).map((dismissal) => [
        dismissal.itemKey,
        new Date(dismissal.dismissedAt).getTime(),
      ]),
    );

    const badges = await badgesSvc.get(companyId, {
      dismissals: dismissedAtByKey,
      joinRequests: [{
        id: hiddenJoinRequestId,
        createdAt: new Date("2026-03-11T01:00:00.000Z"),
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      }],
      unreadTouchedIssues: 1,
    });

    expect(badges).toEqual({
      inbox: 3,
      approvals: 1,
      failedRuns: 1,
      joinRequests: 0,
    });
  });

  it("resolves a failed heartbeat run without mutating run history", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      createdAt: new Date("2026-03-11T01:00:00.000Z"),
      updatedAt: new Date("2026-03-11T01:00:00.000Z"),
    });

    const app = createInboxDismissalApp({
      type: "board",
      source: "local_implicit",
      userId,
    });

    const response = await request(app)
      .post(`/api/heartbeat-runs/${runId}/resolve`)
      .send({})
      .expect(201);

    expect(response.body).toMatchObject({
      companyId,
      userId,
      itemKey: `run:${runId}`,
    });

    const dismissedAtByKey = new Map(
      (await dismissalsSvc.list(companyId, userId)).map((dismissal) => [
        dismissal.itemKey,
        new Date(dismissal.dismissedAt).getTime(),
      ]),
    );
    const badges = await badgesSvc.get(companyId, { dismissals: dismissedAtByKey });

    expect(badges.failedRuns).toBe(0);
    expect(badges.inbox).toBe(0);

    const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persistedRun?.status).toBe("failed");
  });

  it("does not disclose heartbeat runs outside the board actor companies", async () => {
    const actorCompanyId = randomUUID();
    const runCompanyId = randomUUID();
    const userId = "board-user";
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values([
      {
        id: actorCompanyId,
        name: "Actor Company",
        issuePrefix: "ACT",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: runCompanyId,
        name: "Run Company",
        issuePrefix: "RUN",
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values({
      id: agentId,
      companyId: runCompanyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: runCompanyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      createdAt: new Date("2026-03-11T01:00:00.000Z"),
      updatedAt: new Date("2026-03-11T01:00:00.000Z"),
    });

    const app = createInboxDismissalApp({
      type: "board",
      source: "session",
      userId,
      companyIds: [actorCompanyId],
      memberships: [{ companyId: actorCompanyId, status: "active", membershipRole: "member" }],
    });

    await request(app)
      .post(`/api/heartbeat-runs/${runId}/resolve`)
      .send({})
      .expect(404);

    await expect(dismissalsSvc.list(runCompanyId, userId)).resolves.toHaveLength(0);
  });

  it("does not resolve successful heartbeat runs", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      createdAt: new Date("2026-03-11T01:00:00.000Z"),
      updatedAt: new Date("2026-03-11T01:00:00.000Z"),
    });

    const app = createInboxDismissalApp({
      type: "board",
      source: "local_implicit",
      userId,
    });

    await request(app)
      .post(`/api/heartbeat-runs/${runId}/resolve`)
      .send({})
      .expect(400);

    await expect(dismissalsSvc.list(companyId, userId)).resolves.toHaveLength(0);
  });
});
