import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  instanceSettings,
  issueComments,
  issues,
  principalPermissionGrants,
  tokenCapResets,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping token-cap reset route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /api/agents/:agentId/token-cap/reset", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-token-cap-reset-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(tokenCapResets);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/budgets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/workspace-operations.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    // Stub heavy adapters/telemetry that don't need real implementations
    vi.doMock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
    vi.doMock("@paperclipai/shared/telemetry", () => ({
      trackAgentCreated: vi.fn(),
      trackErrorHandlerCrash: vi.fn(),
    }));
    vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
      const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>(
        "@paperclipai/adapter-opencode-local/server",
      );
      return { ...actual, ensureOpenCodeModelConfiguredAndAvailable: vi.fn() };
    });
  });

  async function createApp(actor: Record<string, unknown>) {
    const [{ agentRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/agents.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedFixture(opts: {
    agentCap?: number | null;
    recoverIssueTitle?: string;
    recoverIssueStatus?: string;
    recoverIssueCreatedByRole?: "ceo" | "engineer" | null;
    recoverIssueCreatedByUser?: boolean;
    userRole?: "owner" | "member";
    hasBudgetReportComment?: boolean;
    tokenUsage?: number;
    priorResetOffset?: number;
  } = {}) {
    const {
      agentCap = 1000,
      recoverIssueTitle = "Recover",
      recoverIssueStatus = "todo",
      recoverIssueCreatedByRole = "ceo",
      recoverIssueCreatedByUser = false,
      userRole = "owner",
      hasBudgetReportComment = true,
      tokenUsage = 900,
      priorResetOffset = 0,
    } = opts;

    const companyId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const targetAgentId = randomUUID();
    const ceoAgentId = randomUUID();
    const userId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "ResetCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: targetAgentId,
        companyId,
        name: "TargetAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        monthlyTokenCapTokens: agentCap,
      },
      {
        id: ceoAgentId,
        companyId,
        name: "CeoAgent",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const access = accessService(db);
    await access.ensureMembership(companyId, "user", userId, userRole, "active");

    // Create recover issue authored by the appropriate principal
    const recoverIssueCreatorAgentId = (() => {
      if (recoverIssueCreatedByUser) return null;
      if (recoverIssueCreatedByRole === "ceo") return ceoAgentId;
      if (recoverIssueCreatedByRole === "engineer") return targetAgentId;
      return null;
    })();
    const recoverIssueCreatorUserId = recoverIssueCreatedByUser ? userId : null;

    const [recoverIssueRow] = await db
      .insert(issues)
      .values({
        companyId,
        title: recoverIssueTitle,
        status: recoverIssueStatus,
        priority: "high",
        createdByAgentId: recoverIssueCreatorAgentId,
        createdByUserId: recoverIssueCreatorUserId,
      })
      .returning({ id: issues.id });
    const recoverIssueId = recoverIssueRow!.id;

    // Budget report comment from target agent if requested
    if (hasBudgetReportComment) {
      await db.insert(issueComments).values({
        companyId,
        issueId: recoverIssueId,
        authorAgentId: targetAgentId,
        authorType: "agent",
        body: "## Budget Report\n\nThis month I used 900 tokens on tasks X, Y, Z.",
      });
    }

    // Seed token usage
    if (tokenUsage > 0) {
      const now = new Date();
      await db.insert(costEvents).values({
        agentId: targetAgentId,
        companyId,
        provider: "anthropic",
        model: "claude-3-opus",
        inputTokens: tokenUsage,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        occurredAt: now,
      });
    }

    // Prior reset offset if any
    if (priorResetOffset > 0) {
      const now = new Date();
      const monthDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
      await db.insert(tokenCapResets).values({
        agentId: targetAgentId,
        companyId,
        month: monthDate,
        offsetTokens: priorResetOffset,
        resetAt: new Date(),
        authorizedByUserId: userId,
      });
    }

    return { companyId, targetAgentId, ceoAgentId, recoverIssueId, userId };
  }

  // ─── Auth: 403 paths ────────────────────────────────────────────────────────

  it("returns 403 for an unauthenticated request", async () => {
    const { targetAgentId, recoverIssueId } = await seedFixture();
    const app = await createApp({ type: "none" });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(403);
  });

  it("returns 403 for a non-CEO agent caller", async () => {
    const { targetAgentId, recoverIssueId, companyId } = await seedFixture();
    const engineerAgentId = randomUUID();
    await db.insert(agents).values({
      id: engineerAgentId,
      companyId,
      name: "EngineerAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = await createApp({ type: "agent", agentId: engineerAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(403);
  });

  it("returns 403 for a board user with non-owner membership role", async () => {
    const { targetAgentId, recoverIssueId, companyId, userId } = await seedFixture({ userRole: "member" });
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(403);
  });

  // ─── Auth: 200 success paths ─────────────────────────────────────────────────

  it("allows a CEO agent to reset (auth path a)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture();
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agentId: targetAgentId,
      offsetTokens: 900,
      netUsageAfter: 0,
    });
    expect(res.body.resetId).toBeTruthy();
    // Verify token_cap_resets row used authorizedByAgentId
    const resets = await db.select().from(tokenCapResets).where(eq(tokenCapResets.agentId, targetAgentId));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.authorizedByAgentId).toBe(ceoAgentId);
    expect(resets[0]!.authorizedByUserId).toBeNull();
  });

  it("allows an owner board user to reset (auth path b)", async () => {
    const { targetAgentId, recoverIssueId, companyId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
    // Verify token_cap_resets row used authorizedByUserId
    const resets = await db.select().from(tokenCapResets).where(eq(tokenCapResets.agentId, targetAgentId));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.authorizedByUserId).toBe(userId);
    expect(resets[0]!.authorizedByAgentId).toBeNull();
  });

  // ─── Validation failures: 422 ───────────────────────────────────────────────

  it("returns 422 when recoverIssueId is missing", async () => {
    const { targetAgentId, ceoAgentId, companyId } = await seedFixture();
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({});
    expect(res.status).toBe(422);
  });

  it("returns 422 when recover issue does not exist (validation 1)", async () => {
    const { targetAgentId, ceoAgentId, companyId } = await seedFixture();
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId: randomUUID() });
    expect(res.status).toBe(422);
  });

  it("returns 422 when recover issue is done (validation 1)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      recoverIssueStatus: "done",
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  it("returns 422 when recover issue is cancelled (validation 1)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      recoverIssueStatus: "cancelled",
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  it("returns 422 when recover issue was authored by a non-CEO agent (validation 2)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      recoverIssueCreatedByRole: "engineer",
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  it("allows recover issue authored by an owner user (validation 2 alternate path)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      recoverIssueCreatedByUser: true,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
  });

  it("returns 422 when recover issue title is not 'Recover' and has no recover label (validation 3)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      recoverIssueTitle: "Budget recovery request",
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  it("returns 422 when no Budget Report comment from target agent (validation 4)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      hasBudgetReportComment: false,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  it("returns 422 when agent usage is below 80% threshold (validation 5)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      tokenUsage: 700,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  it("returns 422 when agent has no token cap configured (validation 5)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      agentCap: null,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });

  // ─── Happy path: full effect ─────────────────────────────────────────────────

  it("happy path: inserts token_cap_resets, closes recover ticket, posts both comments, returns 200", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({ tokenUsage: 900 });

    // Give target agent an active in_progress issue for the notification comment
    const [activeIssueRow] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Active work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: targetAgentId,
      })
      .returning({ id: issues.id });
    const activeIssueId = activeIssueRow!.id;

    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agentId: targetAgentId,
      offsetTokens: 900,
      netUsageAfter: 0,
    });
    expect(typeof res.body.resetId).toBe("string");

    // token_cap_resets row inserted
    const resets = await db.select().from(tokenCapResets).where(eq(tokenCapResets.agentId, targetAgentId));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.offsetTokens).toBe(900);
    expect(resets[0]!.recoverIssueId).toBe(recoverIssueId);

    // Recover issue closed
    const [recoverIssueUpdated] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, recoverIssueId));
    expect(recoverIssueUpdated!.status).toBe("done");

    // Comment on recover issue
    const recoverComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, recoverIssueId),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(recoverComments.some((c) => c.body.includes("Reset applied at"))).toBe(true);
    expect(recoverComments.some((c) => c.body.includes("Offset tokens: 900"))).toBe(true);

    // Comment on active issue
    const activeIssueComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, activeIssueId),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(activeIssueComments.some((c) => c.body.includes("Token cap reset approved"))).toBe(true);
  });

  it("passes at exactly 80% (boundary: netUsage === 0.8 * cap)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      agentCap: 1000,
      tokenUsage: 800,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
  });

  it("passes when agent is hard-stopped (netUsage >= cap)", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      agentCap: 1000,
      tokenUsage: 1000,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
    const resets = await db.select().from(tokenCapResets).where(eq(tokenCapResets.agentId, targetAgentId));
    expect(resets[0]!.offsetTokens).toBe(1000);
  });

  it("accounts for prior resets when computing net usage", async () => {
    // 1000 raw usage - 200 prior offset = 800 net; cap 1000 → 80% → passes
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      agentCap: 1000,
      tokenUsage: 1000,
      priorResetOffset: 200,
    });
    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
    // offsetTokens = netUsage = 1000 - 200 = 800
    expect(res.body.offsetTokens).toBe(800);
  });

  it("Budget Report heading match is case-insensitive and anchored to line start", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      hasBudgetReportComment: false,
    });
    // Insert comment with mixed-case heading
    await db.insert(issueComments).values({
      companyId,
      issueId: recoverIssueId,
      authorAgentId: targetAgentId,
      authorType: "agent",
      body: "Some intro text\n## budget REPORT\n\nDetails here.",
    });

    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(200);
  });

  it("rejects Budget Report not at line start", async () => {
    const { targetAgentId, ceoAgentId, recoverIssueId, companyId } = await seedFixture({
      hasBudgetReportComment: false,
    });
    // Heading is preceded by text on same line — not a line-start heading
    await db.insert(issueComments).values({
      companyId,
      issueId: recoverIssueId,
      authorAgentId: targetAgentId,
      authorType: "agent",
      body: "text ## Budget Report more text",
    });

    const app = await createApp({ type: "agent", agentId: ceoAgentId, companyId });
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/token-cap/reset`)
      .send({ recoverIssueId });
    expect(res.status).toBe(422);
  });
});
