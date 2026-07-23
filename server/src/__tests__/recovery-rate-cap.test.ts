import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  documentRevisions,
  documents,
  issueRelations,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "ok",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery rate cap tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("stranded issue recovery rate cap", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-rate-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(issues);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgents() {
    const companyId = randomUUID();
    const ctoAgentId = randomUUID();
    const engineerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "RateCapTestCo",
      issuePrefix: "RCT",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ctoAgentId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engineerAgentId,
        companyId,
        name: "Engineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo: ctoAgentId,
      },
    ]);

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: ctoAgentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1_000_000_00,
      hardStopEnabled: true,
      isActive: true,
    });

    return { companyId, ctoAgentId, engineerAgentId };
  }

  async function seedSourceIssue(companyId: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded source issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      originKind: "manual",
      originFingerprint: "default",
    });
    return issueId;
  }

  async function seedRecoveryIssues(companyId: string, count: number, assigneeAgentId: string) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: `Recovery issue ${i}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId,
        originKind: "stranded_issue_recovery",
        originId: randomUUID(),
        originFingerprint: `stranded_issue_recovery:${companyId}:${randomUUID()}:no-run`,
        createdAt: new Date(now - i * 60_000),
      });
    }
  }

  it("allows recovery creation when below the per-company-per-hour cap", async () => {
    const { companyId, ctoAgentId, engineerAgentId } = await seedCompanyAndAgents();
    const sourceIssueId = await seedSourceIssue(companyId, engineerAgentId);

    await seedRecoveryIssues(companyId, 10, ctoAgentId);

    const mockEnqueueWakeup = vi.fn(async () => null);
    const svc = recoveryService(db, { enqueueWakeup: mockEnqueueWakeup });

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0]!);

    await svc.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "Issue is stranded (test).",
    });

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, sourceIssueId),
        ),
      );

    expect(recoveryIssues.length).toBe(1);
  });

  it("blocks recovery creation when at or above the per-company-per-hour cap", async () => {
    const { companyId, ctoAgentId, engineerAgentId } = await seedCompanyAndAgents();
    const sourceIssueId = await seedSourceIssue(companyId, engineerAgentId);

    await seedRecoveryIssues(companyId, 50, ctoAgentId);

    const mockEnqueueWakeup = vi.fn(async () => null);
    const svc = recoveryService(db, { enqueueWakeup: mockEnqueueWakeup });

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0]!);

    await svc.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "Issue is stranded (test).",
    });

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, sourceIssueId),
        ),
      );

    expect(recoveryIssues.length).toBe(0);
    expect(mockEnqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not count recovery issues older than one hour toward the cap", async () => {
    const { companyId, ctoAgentId, engineerAgentId } = await seedCompanyAndAgents();
    const sourceIssueId = await seedSourceIssue(companyId, engineerAgentId);

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < 60; i++) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: `Old recovery issue ${i}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: ctoAgentId,
        originKind: "stranded_issue_recovery",
        originId: randomUUID(),
        originFingerprint: `stranded_issue_recovery:${companyId}:${randomUUID()}:no-run`,
        createdAt: new Date(twoHoursAgo - i * 60_000),
      });
    }

    const mockEnqueueWakeup = vi.fn(async () => null);
    const svc = recoveryService(db, { enqueueWakeup: mockEnqueueWakeup });

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sourceIssueId))
      .then((rows) => rows[0]!);

    await svc.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: null,
      comment: "Issue is stranded (test).",
    });

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, sourceIssueId),
        ),
      );

    expect(recoveryIssues.length).toBe(1);
  });
});
