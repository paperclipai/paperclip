import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  classifyRecoveryHandoff,
  evaluateRecoveryRateAlert,
  MAX_WINDOW_WEEKS,
  recoveryObservabilityService,
  type WeeklyRecoveryRate,
} from "../services/recovery-observability.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery observability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function week(runs: number, recoveryActions: number, weekStart: string): WeeklyRecoveryRate {
  return {
    weekStart,
    runs,
    recoveryActions,
    ratePercent: runs > 0 ? Math.round((recoveryActions / runs) * 10000) / 100 : 0,
  };
}

describe("evaluateRecoveryRateAlert", () => {
  it("fires when a week crosses the 2% threshold", () => {
    const weekly = [
      week(1000, 12, "2026-06-01"), // 1.20%
      week(2364, 77, "2026-07-06"), // 3.26% — the regression week
      week(1000, 10, "2026-07-13"), // 1.00%
    ];

    const alert = evaluateRecoveryRateAlert(weekly, 2);

    expect(alert.breached).toBe(true);
    expect(alert.breachedWeeks.map((w) => w.weekStart)).toEqual(["2026-07-06"]);
    expect(alert.latestWeek?.weekStart).toBe("2026-07-13");
    expect(alert.latestWeekBreached).toBe(false);
  });

  it("stays quiet when every week is under the threshold", () => {
    const weekly = [week(1000, 13, "2026-06-01"), week(1000, 19, "2026-06-08")];
    const alert = evaluateRecoveryRateAlert(weekly, 2);
    expect(alert.breached).toBe(false);
    expect(alert.breachedWeeks).toHaveLength(0);
    expect(alert.latestWeekBreached).toBe(false);
  });

  it("flags the latest week when it is the one that regresses", () => {
    const weekly = [week(1000, 10, "2026-07-06"), week(1000, 30, "2026-07-13")]; // 1% then 3%
    const alert = evaluateRecoveryRateAlert(weekly, 2);
    expect(alert.latestWeekBreached).toBe(true);
  });
});

describe("classifyRecoveryHandoff", () => {
  const base = {
    status: "resolved",
    outcome: "restored",
    ownerAgentId: "manager",
    returnOwnerAgentId: "coder",
    finalAssigneeAgentId: "coder",
    finalIssueStatus: "done",
  };

  it("marks a manager who kept and completed the work as owner_completed", () => {
    expect(
      classifyRecoveryHandoff({ ...base, finalAssigneeAgentId: "manager", finalIssueStatus: "done" }),
    ).toBe("owner_completed");
  });

  it("marks work returned to the original assignee as handed_back", () => {
    expect(classifyRecoveryHandoff({ ...base, finalAssigneeAgentId: "coder" })).toBe("handed_back");
  });

  it("marks work delegated to a different specialist as handed_back", () => {
    expect(classifyRecoveryHandoff({ ...base, finalAssigneeAgentId: "other-agent" })).toBe(
      "handed_back",
    );
  });

  it("marks the original agent recovering its own issue as self_recovery", () => {
    expect(
      classifyRecoveryHandoff({ ...base, ownerAgentId: "coder", returnOwnerAgentId: "coder" }),
    ).toBe("self_recovery");
  });

  it("treats still-active actions as active regardless of assignee", () => {
    expect(classifyRecoveryHandoff({ ...base, status: "active" })).toBe("active");
  });
});

describeEmbeddedPostgres("recovery observability report", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const now = new Date("2026-07-15T12:00:00.000Z");
  // Monday of each relevant week (matches Postgres date_trunc('week', ...)).
  const regressionWeek = new Date("2026-07-08T12:00:00.000Z"); // in week 2026-07-06
  const latestWeek = new Date("2026-07-14T12:00:00.000Z"); // in week 2026-07-13

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-observability-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBaseline() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const otherId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values(
      [managerId, coderId, otherId].map((id, index) => ({
        id,
        companyId,
        name: `agent-${index}`,
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );

    // 100 runs in the regression week, 100 in the latest week.
    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 100 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: coderId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: regressionWeek,
      })),
      ...Array.from({ length: 100 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: coderId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: latestWeek,
      })),
    ]);

    return { companyId, managerId, coderId, otherId };
  }

  async function seedRecoveryAction(input: {
    companyId: string;
    n: number;
    createdAt: Date;
    cause: string;
    errorCode: string;
    status: string;
    outcome: string | null;
    ownerAgentId: string | null;
    returnOwnerAgentId: string | null;
    finalAssigneeAgentId: string | null;
    finalIssueStatus: string;
  }) {
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: input.companyId,
      title: `Source ${input.n}`,
      status: input.finalIssueStatus,
      priority: "medium",
      assigneeAgentId: input.finalAssigneeAgentId,
      issueNumber: input.n,
      identifier: `SRC-${input.n}`,
    });
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId: input.companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      status: input.status,
      ownerType: input.ownerAgentId ? "agent" : "board",
      ownerAgentId: input.ownerAgentId,
      returnOwnerAgentId: input.returnOwnerAgentId,
      previousOwnerAgentId: input.returnOwnerAgentId,
      cause: input.cause,
      fingerprint: `fp-${input.n}`,
      evidence: { latestRunErrorCode: input.errorCode },
      nextAction: "recover",
      outcome: input.outcome,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
  }

  it("fires the threshold alert on synthetic data crossing 2% of runs", async () => {
    const { companyId, managerId, coderId } = await seedBaseline();

    // Regression week: 3 recovery actions against 100 runs => 3% > 2%.
    for (let i = 0; i < 3; i += 1) {
      await seedRecoveryAction({
        companyId,
        n: i + 1,
        createdAt: regressionWeek,
        cause: "stranded_assigned_issue",
        errorCode: "process_lost",
        status: "resolved",
        outcome: "restored",
        ownerAgentId: managerId,
        returnOwnerAgentId: coderId,
        finalAssigneeAgentId: managerId,
        finalIssueStatus: "done",
      });
    }
    // Latest week: 1 recovery action against 100 runs => 1% (under threshold).
    await seedRecoveryAction({
      companyId,
      n: 99,
      createdAt: latestWeek,
      cause: "stranded_assigned_issue",
      errorCode: "process_lost",
      status: "resolved",
      outcome: "restored",
      ownerAgentId: coderId,
      returnOwnerAgentId: coderId,
      finalAssigneeAgentId: coderId,
      finalIssueStatus: "done",
    });

    const report = await recoveryObservabilityService(db).report(companyId, {
      now,
      weeks: 8,
      thresholdPercent: 2,
    });

    expect(report.alert.breached).toBe(true);
    expect(report.alert.breachedWeeks.map((w) => w.weekStart)).toEqual(["2026-07-06"]);
    const regression = report.weekly.find((w) => w.weekStart === "2026-07-06");
    expect(regression).toMatchObject({ runs: 100, recoveryActions: 3, ratePercent: 3 });
    const latest = report.weekly.find((w) => w.weekStart === "2026-07-13");
    expect(latest).toMatchObject({ runs: 100, recoveryActions: 1, ratePercent: 1 });
    expect(report.alert.latestWeekBreached).toBe(false);
  });

  it("computes the handed_back vs owner_completed ratio and per-cause routing", async () => {
    const { companyId, managerId, coderId, otherId } = await seedBaseline();

    // Two manager takeovers where the manager kept and completed the work.
    for (let i = 0; i < 2; i += 1) {
      await seedRecoveryAction({
        companyId,
        n: i + 1,
        createdAt: regressionWeek,
        cause: "stranded_assigned_issue",
        errorCode: "adapter_failed",
        status: "resolved",
        outcome: "restored",
        ownerAgentId: managerId,
        returnOwnerAgentId: coderId,
        finalAssigneeAgentId: managerId,
        finalIssueStatus: "done",
      });
    }
    // One takeover handed back to the original assignee.
    await seedRecoveryAction({
      companyId,
      n: 3,
      createdAt: regressionWeek,
      cause: "stranded_assigned_issue",
      errorCode: "adapter_failed",
      status: "resolved",
      outcome: "restored",
      ownerAgentId: managerId,
      returnOwnerAgentId: coderId,
      finalAssigneeAgentId: coderId,
      finalIssueStatus: "in_progress",
    });
    // One handed to a different specialist (still counts as handed back).
    await seedRecoveryAction({
      companyId,
      n: 4,
      createdAt: regressionWeek,
      cause: "stranded_assigned_issue",
      errorCode: "adapter_failed",
      status: "resolved",
      outcome: "restored",
      ownerAgentId: managerId,
      returnOwnerAgentId: coderId,
      finalAssigneeAgentId: otherId,
      finalIssueStatus: "in_progress",
    });
    // Original agent recovered its own process_lost issue (self recovery).
    await seedRecoveryAction({
      companyId,
      n: 5,
      createdAt: regressionWeek,
      cause: "process_lost",
      errorCode: "process_lost",
      status: "resolved",
      outcome: "restored",
      ownerAgentId: coderId,
      returnOwnerAgentId: coderId,
      finalAssigneeAgentId: coderId,
      finalIssueStatus: "done",
    });
    // Escalated actions are still active, but they need their own routing counter.
    await seedRecoveryAction({
      companyId,
      n: 6,
      createdAt: regressionWeek,
      cause: "stranded_assigned_issue",
      errorCode: "manual_escalation",
      status: "escalated",
      outcome: null,
      ownerAgentId: managerId,
      returnOwnerAgentId: coderId,
      finalAssigneeAgentId: managerId,
      finalIssueStatus: "in_progress",
    });

    const report = await recoveryObservabilityService(db).report(companyId, { now, weeks: 8 });

    expect(report.handoff.ownerCompleted).toBe(2);
    expect(report.handoff.handedBack).toBe(2);
    expect(report.handoff.selfRecovery).toBe(1);
    expect(report.handoff.resolvedTakeovers).toBe(4);
    expect(report.handoff.handedBackRatio).toBe(50);
    expect(report.handoff.ownerCompletedRatio).toBe(50);

    const strandedCause = report.byCause.find(
      (c) => c.cause === "stranded_assigned_issue" && c.latestRunErrorCode === "adapter_failed",
    );
    expect(strandedCause?.count).toBe(4);

    const processLostRouting = report.perCauseRouting.find((r) => r.cause === "process_lost");
    expect(processLostRouting?.retriedByOriginalSucceeded).toBe(1);
    const strandedRouting = report.perCauseRouting.find(
      (r) => r.cause === "stranded_assigned_issue",
    );
    expect(strandedRouting?.ownerCompleted).toBe(2);
    expect(strandedRouting?.handedBack).toBe(2);
    expect(strandedRouting?.active).toBe(1);
    expect(strandedRouting?.escalated).toBe(1);
  });

  it("caps the reporting window so a huge `weeks` value can't over-allocate", async () => {
    const { companyId } = await seedBaseline();

    const report = await recoveryObservabilityService(db).report(companyId, {
      now,
      weeks: 100_000,
    });

    expect(report.window.weeks).toBe(MAX_WINDOW_WEEKS);
    expect(report.window.since).toBe(report.weekly[0]?.weekStart);
    expect(report.window.since).not.toContain("T");
    expect(report.weekly).toHaveLength(MAX_WINDOW_WEEKS);
  });
});
