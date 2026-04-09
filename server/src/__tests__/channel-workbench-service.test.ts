import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { channelWorkbenchService } from "../services/channel-workbench.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres channel workbench service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("channelWorkbenchService activity overlay", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof channelWorkbenchService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-channel-workbench-");
    db = createDb(tempDb.connectionString);
    svc = channelWorkbenchService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    return companyId;
  }

  it("uses activity to move gate_stale overview and next actions into passed_with_exception", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.gate_rerun_requested",
      entityType: "channel_case",
      entityId: "case_s06",
      details: {
        previousScenario: "gate_stale",
        currentScenario: "passed_with_exception",
        gateRunId: "gate_run_case_s06_090000",
        status: "completed",
        gateSummaryStatus: "passed",
        targetPage: "snapshot_export",
      },
    });

    const overviewPayload = await svc.getOverview(companyId, "gate_stale");
    const nextActionsPayload = await svc.getNextActions(companyId, "gate_stale");

    expect(overviewPayload.scenario.key).toBe("passed_with_exception");
    expect(overviewPayload.overview.caseId).toBe("case_s06");
    expect(overviewPayload.overview.caseTitle).toBe("XX渠道签约改造");
    expect(overviewPayload.overview.hasStaleGate).toBe(false);
    expect(overviewPayload.overview.latestGateSummaryStatus).toBe("passed");
    expect(overviewPayload.overview.statusSummary.canEnterCoding).toBe(true);
    expect(overviewPayload.overview.evidenceProgress).toEqual({
      requiredCount: 8,
      completedCount: 5,
      blockingCount: 3,
    });
    expect(nextActionsPayload.scenario.key).toBe("passed_with_exception");
    expect(nextActionsPayload.items.map((item) => item.actionType)).toEqual([
      "review_exception",
      "export_ai",
    ]);
  });

  it("allows export_ai to execute from the effective scenario resolved by activity", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.gate_rerun_requested",
      entityType: "channel_case",
      entityId: "case_s06",
      details: {
        previousScenario: "gate_stale",
        currentScenario: "passed_with_exception",
        gateRunId: "gate_run_case_s06_090000",
        status: "completed",
        gateSummaryStatus: "passed",
        targetPage: "snapshot_export",
      },
    });

    const result = await svc.exportAi(companyId, "gate_stale");

    expect(result.caseId).toBe("case_s06");
    expect(result.snapshotId).toBe("snap_s06_004");
    expect(result.currentScenario.key).toBe("passed_with_exception");
    expect(result.targetPage).toBe("evidence_dod");
  });

  it("patches DoD evidence progress from activity while keeping remaining actions", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.evidence_uploaded",
      entityType: "channel_case",
      entityId: "case_s09",
      details: {
        previousScenario: "dod_blocked",
        currentScenario: "dod_blocked",
        evidenceId: "evidence_case_s09_101010",
        obligationId: "dod_s09_001",
        status: "completed",
        evidenceStatus: "uploaded",
        completedEvidenceCount: 6,
        remainingBlockingCount: 2,
        dodSummaryStatus: "blocked",
        targetPage: "evidence_dod",
      },
    });

    const overviewPayload = await svc.getOverview(companyId, "dod_blocked");
    const nextActionsPayload = await svc.getNextActions(companyId, "dod_blocked");

    expect(overviewPayload.overview.evidenceProgress).toEqual({
      requiredCount: 8,
      completedCount: 6,
      blockingCount: 2,
    });
    expect(overviewPayload.overview.topBlockingItems).toEqual([
      expect.objectContaining({
        type: "dod_obligation",
        ownerRole: "test",
      }),
    ]);
    expect(overviewPayload.overview.statusSummary.summaryText).toContain("仍有 2 项 DoD 阻塞");
    expect(nextActionsPayload.items.map((item) => item.actionType)).toEqual(["upload_evidence"]);
  });

  it("removes export_ai from next actions after a completed export activity", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.ai_package_exported",
      entityType: "channel_case",
      entityId: "case_s08",
      details: {
        previousScenario: "passed_with_exception",
        currentScenario: "passed_with_exception",
        exportId: "ai_export_case_s08_111111",
        snapshotId: "snap_s08_005",
        ruleVersion: "v1.2.0",
        status: "completed",
        packageStatus: "exported",
        targetPage: "evidence_dod",
      },
    });

    const overviewPayload = await svc.getOverview(companyId, "passed_with_exception");
    const nextActionsPayload = await svc.getNextActions(companyId, "passed_with_exception");

    expect(overviewPayload.overview.currentStage).toBe("evidence");
    expect(overviewPayload.overview.statusSummary.reasonCode).toBe("AI_PACKAGE_EXPORTED_DOD_PENDING");
    expect(nextActionsPayload.items.map((item) => item.actionType)).toEqual([
      "upload_evidence",
      "review_exception",
    ]);
  });

  it("returns snapshot export detail with the latest export record", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.ai_package_exported",
      entityType: "channel_case",
      entityId: "case_s08",
      details: {
        previousScenario: "passed_with_exception",
        currentScenario: "passed_with_exception",
        exportId: "ai_export_case_s08_111111",
        snapshotId: "snap_s08_005",
        ruleVersion: "v1.2.0",
        status: "completed",
        packageStatus: "exported",
        targetPage: "evidence_dod",
      },
    });

    const payload = await svc.getSnapshotExport(companyId, "passed_with_exception");

    expect(payload.detail.snapshotId).toBe("snap_s08_005");
    expect(payload.detail.packageStatus).toBe("exported");
    expect(payload.detail.latestExport?.exportId).toBe("ai_export_case_s08_111111");
    expect(payload.detail.nextOwnerRole).toBe("test");
    expect(payload.detail.nextStep).toContain("DoD");
  });

  it("returns DoD detail patched by evidence upload activity", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.evidence_uploaded",
      entityType: "channel_case",
      entityId: "case_s09",
      details: {
        previousScenario: "dod_blocked",
        currentScenario: "dod_blocked",
        evidenceId: "evidence_case_s09_121212",
        obligationId: "dod_s09_001",
        status: "completed",
        evidenceStatus: "uploaded",
        completedEvidenceCount: 6,
        remainingBlockingCount: 2,
        dodSummaryStatus: "blocked",
        targetPage: "evidence_dod",
      },
    });

    const payload = await svc.getEvidenceDod(companyId, "dod_blocked");

    expect(payload.detail.completedObligationCount).toBe(6);
    expect(payload.detail.blockingCount).toBe(2);
    expect(payload.detail.nextOwnerRole).toBe("test");
    expect(payload.detail.nextStep).toContain("剩余 2 项");
    expect(payload.detail.latestUpload?.evidenceId).toBe("evidence_case_s09_121212");
    expect(payload.detail.items[0]).toEqual(expect.objectContaining({
      obligationId: "dod_s09_001",
      status: "complete",
    }));
  });

  it("returns gate result detail synthesized from rerun activity after stale gate recovery", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.gate_rerun_requested",
      entityType: "channel_case",
      entityId: "case_s06",
      details: {
        previousScenario: "gate_stale",
        currentScenario: "passed_with_exception",
        gateRunId: "gate_run_case_s06_090000",
        status: "completed",
        gateSummaryStatus: "passed",
        targetPage: "snapshot_export",
      },
    });

    const payload = await svc.getGateResult(companyId, "gate_stale");

    expect(payload.detail.gateRunId).toBe("gate_run_case_s06_090000");
    expect(payload.detail.summaryStatus).toBe("passed");
    expect(payload.detail.nextOwnerRole).toBe("dev");
    expect(payload.detail.nextStep).toContain("AI 导出");
    expect(payload.detail.findings).toEqual([]);
  });

  it("returns issue ledger detail for blocking gate issues", async () => {
    const companyId = await seedCompany();

    const payload = await svc.getIssueLedger(companyId, "gate_failed");

    expect(payload.detail.openCount).toBe(5);
    expect(payload.detail.blockingCount).toBe(3);
    expect(payload.detail.nextOwnerRole).toBe("dev");
    expect(payload.detail.nextStep).toContain("G2-013 术语不一致");
    expect(payload.detail.items[0]).toEqual(expect.objectContaining({
      title: "G2-013 术语不一致",
      blockingStage: "gate",
    }));
    expect(payload.detail.items.some((item) => item.status === "waiting_external")).toBe(true);
  });

  it("returns empty source document detail for no_source", async () => {
    const companyId = await seedCompany();

    const payload = await svc.getSourceDocuments(companyId, "no_source");

    expect(payload.detail.totalCount).toBe(0);
    expect(payload.detail.nextOwnerRole).toBe("pm");
    expect(payload.detail.nextStep).toContain("产品");
    expect(payload.detail.items).toEqual([]);
  });

  it("derives source document detail counts from the overview state", async () => {
    const companyId = await seedCompany();

    const payload = await svc.getSourceDocuments(companyId, "passed_with_exception");

    expect(payload.detail.totalCount).toBe(6);
    expect(payload.detail.items).toHaveLength(6);
    expect(payload.detail.nextOwnerRole).toBe("dev");
    expect(payload.detail.nextStep).toContain("规范沉淀");
    expect(payload.detail.items.filter((item) => item.isCritical)).toHaveLength(3);
    expect(payload.detail.items.filter((item) => item.snapshotStatus === "snapshotted")).toHaveLength(5);
  });

  it("returns spec editor detail for spec_incomplete", async () => {
    const companyId = await seedCompany();

    const payload = await svc.getSpecEditor(companyId, "spec_incomplete");

    expect(payload.detail.bundleId).toBe("bundle_case_s02");
    expect(payload.detail.errorSections).toBe(1);
    expect(payload.detail.nextOwnerRole).toBe("dev");
    expect(payload.detail.nextStep).toContain("runtime-rules");
    expect(payload.detail.items.map((item) => item.sectionType)).toContain("runtime_rules");
    expect(payload.detail.items.find((item) => item.sectionType === "testcases")?.lintStatus).toBe("warn");
  });

  it("keeps draft sections visible in spec detail when gate is stale", async () => {
    const companyId = await seedCompany();

    const payload = await svc.getSpecEditor(companyId, "gate_stale");

    expect(payload.detail.draftSections).toBe(1);
    expect(payload.detail.warnSections).toBeGreaterThanOrEqual(1);
    expect(payload.detail.nextOwnerRole).toBe("dev");
    expect(payload.detail.nextStep).toContain("草稿章节");
    expect(payload.detail.items.some((item) => item.status === "draft")).toBe(true);
  });

  it("returns role lanes derived from service-side next actions", async () => {
    const companyId = await seedCompany();

    const payload = await svc.getRoleView(companyId, "spec_incomplete");

    expect(payload.detail.caseId).toBe("case_s02");
    expect(payload.detail.lanes).toEqual([
      expect.objectContaining({
        role: "pm",
        status: "idle",
        totalActions: 0,
        summary: "当前首屏没有分配给该角色的动作。",
        primaryAction: null,
      }),
      expect.objectContaining({
        role: "reviewer",
        status: "idle",
        totalActions: 0,
        summary: "当前首屏没有分配给该角色的动作。",
        primaryAction: null,
      }),
      expect.objectContaining({
        role: "dev",
        status: "blocked",
        totalActions: 1,
        summary: expect.stringContaining("timeout"),
        primaryAction: expect.objectContaining({
          actionType: "publish_spec",
          targetPage: "spec_editor",
        }),
      }),
      expect.objectContaining({
        role: "test",
        status: "blocked",
        totalActions: 1,
        summary: expect.stringContaining("测试义务"),
        primaryAction: expect.objectContaining({
          actionType: "complete_spec",
          targetPage: "spec_editor",
        }),
      }),
    ]);
  });

  it("moves role ownership after export into the DoD lane", async () => {
    const companyId = await seedCompany();

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "channel_workbench.ai_package_exported",
      entityType: "channel_case",
      entityId: "case_s08",
      details: {
        previousScenario: "passed_with_exception",
        currentScenario: "passed_with_exception",
        exportId: "ai_export_case_s08_141414",
        snapshotId: "snap_s08_005",
        ruleVersion: "v1.2.0",
        status: "completed",
        packageStatus: "exported",
        targetPage: "evidence_dod",
      },
    });

    const payload = await svc.getRoleView(companyId, "passed_with_exception");
    const testLane = payload.detail.lanes.find((lane) => lane.role === "test");
    const reviewerLane = payload.detail.lanes.find((lane) => lane.role === "reviewer");
    const devLane = payload.detail.lanes.find((lane) => lane.role === "dev");

    expect(testLane).toEqual(expect.objectContaining({
      status: "blocked",
      totalActions: 1,
      blockingActions: 1,
      summary: expect.stringContaining("DoD"),
      primaryAction: expect.objectContaining({
        actionType: "upload_evidence",
        targetPage: "evidence_dod",
      }),
    }));
    expect(reviewerLane?.primaryAction?.actionType).toBe("review_exception");
    expect(reviewerLane?.status).toBe("assist");
    expect(devLane?.primaryAction).toBeNull();
    expect(devLane?.status).toBe("idle");
  });
});
