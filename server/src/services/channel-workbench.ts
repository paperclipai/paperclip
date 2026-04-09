import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies } from "@paperclipai/db";
import {
  channelWorkbenchPageDefinitions,
  channelWorkbenchScenarioDefinitions,
  type ChannelWorkbenchAction,
  type ChannelWorkbenchDodItem,
  type ChannelWorkbenchEvidenceDodResponse,
  type ChannelWorkbenchExportAiResponse,
  type ChannelWorkbenchGateResultResponse,
  type ChannelWorkbenchIssueLedgerResponse,
  type ChannelWorkbenchOverview,
  type ChannelWorkbenchNextActionsResponse,
  type ChannelWorkbenchOverviewResponse,
  type ChannelWorkbenchRerunGateResponse,
  type ChannelWorkbenchRoleViewResponse,
  type ChannelWorkbenchScenarioDefinition,
  type ChannelWorkbenchScenarioKey,
  type ChannelWorkbenchSourceDocumentsResponse,
  type ChannelWorkbenchSpecEditorResponse,
  type ChannelWorkbenchSnapshotExportResponse,
  type ChannelWorkbenchUploadEvidenceResponse,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";

type ScenarioRecord = {
  overview: ChannelWorkbenchOverviewResponse;
  nextActions: ChannelWorkbenchNextActionsResponse;
};

type ChannelWorkbenchActivity = typeof activityLog.$inferSelect;

type ResolvedScenarioState = {
  currentScenarioKey: ChannelWorkbenchScenarioKey;
  overviewResponse: ChannelWorkbenchOverviewResponse;
  nextActionsResponse: ChannelWorkbenchNextActionsResponse;
  activity: ChannelWorkbenchActivity[];
};

const roleLabelMap: Record<string, string> = {
  pm: "产品",
  reviewer: "架构",
  dev: "开发",
  test: "测试",
};

const scenarioMap: Record<ChannelWorkbenchScenarioKey, ScenarioRecord> = {
  no_source: {
    overview: {
      scenario: channelWorkbenchScenarioDefinitions[0],
      fixturePaths: [
        "fixtures/channel_workflow_platform/cases/overview.no_source.json",
        "fixtures/channel_workflow_platform/cases/next_actions.no_source.json",
        "fixtures/channel_workflow_platform/source_documents/list.empty.json",
      ],
      overview: {
        caseId: "case_s01",
        caseTitle: "XX渠道代发一期",
        channelName: "XX渠道",
        currentStage: "intake",
        codingReadiness: "blocked",
        latestGateSummaryStatus: "missing",
        latestSnapshotStatus: "missing",
        dodSummaryStatus: "not_started",
        hasStaleGate: false,
        hasActiveException: false,
        activeExceptionCount: 0,
        blockingIssueCount: 0,
        currentSnapshot: null,
        specProgress: {
          bundleExists: false,
          publishedSections: 0,
          totalSections: 0,
          draftSections: 0,
        },
        sourceProgress: {
          totalCount: 0,
          criticalCount: 0,
          snapshottedCount: 0,
          inaccessibleCriticalCount: 0,
        },
        issueProgress: {
          blockingIssueCount: 0,
          openIssueCount: 0,
          waitingExternalCount: 0,
        },
        evidenceProgress: {
          requiredCount: 0,
          completedCount: 0,
          blockingCount: 0,
        },
        topBlockingItems: [],
        statusSummary: {
          canEnterCoding: false,
          summaryText: "还没有来源资料，当前不能进入编码。",
          reasonCode: "NO_SOURCE_DOCUMENTS",
        },
      },
    },
    nextActions: {
      scenario: channelWorkbenchScenarioDefinitions[0],
      items: [
        {
          actionId: "act_s01_001",
          actionType: "add_source",
          title: "添加关键来源资料",
          reason: "当前没有任何关键来源资料。",
          impact: "补齐后才能生成规范模板并继续后续流程。",
          ownerRole: "pm",
          priority: 98,
          isBlocking: true,
          ctaLabel: "添加资料",
          ctaType: "navigate",
          targetPage: "source_documents",
        },
      ],
    },
  },
  spec_incomplete: {
    overview: {
      scenario: channelWorkbenchScenarioDefinitions[1],
      fixturePaths: [
        "fixtures/channel_workflow_platform/cases/overview.spec_incomplete.json",
        "fixtures/channel_workflow_platform/cases/spec_bundle.incomplete.json",
        "fixtures/channel_workflow_platform/cases/next_actions.spec_incomplete.json",
      ],
      overview: {
        caseId: "case_s02",
        caseTitle: "XX渠道回调改造",
        channelName: "XX渠道",
        currentStage: "spec",
        codingReadiness: "blocked",
        latestGateSummaryStatus: "missing",
        latestSnapshotStatus: "missing",
        dodSummaryStatus: "not_started",
        hasStaleGate: false,
        hasActiveException: false,
        activeExceptionCount: 0,
        blockingIssueCount: 0,
        currentSnapshot: null,
        specProgress: {
          bundleExists: true,
          publishedSections: 5,
          totalSections: 7,
          draftSections: 2,
          requiredMissingSections: ["runtime_rules", "testcases"],
        },
        sourceProgress: {
          totalCount: 4,
          criticalCount: 2,
          snapshottedCount: 4,
          inaccessibleCriticalCount: 0,
        },
        issueProgress: {
          blockingIssueCount: 0,
          openIssueCount: 0,
          waitingExternalCount: 0,
        },
        evidenceProgress: {
          requiredCount: 0,
          completedCount: 0,
          blockingCount: 0,
        },
        topBlockingItems: [
          {
            id: "runtime_rules",
            type: "spec_section",
            title: "runtime-rules 章节未发布",
            reason: "timeout 与重试策略未补齐。",
            ownerRole: "dev",
          },
        ],
        statusSummary: {
          canEnterCoding: false,
          summaryText: "规范章节未发布完成，当前不能进入 Gate。",
          reasonCode: "SPEC_SECTION_NOT_PUBLISHED",
        },
      },
    },
    nextActions: {
      scenario: channelWorkbenchScenarioDefinitions[1],
      items: [
        {
          actionId: "act_s02_001",
          actionType: "publish_spec",
          title: "发布 runtime-rules 章节",
          reason: "timeout 与重试策略未补齐，当前阻塞 Gate。",
          impact: "发布后可继续生成快照并运行 Gate。",
          ownerRole: "dev",
          priority: 90,
          isBlocking: true,
          ctaLabel: "去编辑规范",
          ctaType: "navigate",
          targetPage: "spec_editor",
        },
        {
          actionId: "act_s02_002",
          actionType: "complete_spec",
          title: "补齐 testcases 关键义务项",
          reason: "testcases 章节仍缺关键测试义务。",
          impact: "补齐后可满足最小必填项要求。",
          ownerRole: "test",
          priority: 86,
          isBlocking: true,
          ctaLabel: "补齐义务项",
          ctaType: "navigate",
          targetPage: "spec_editor",
        },
      ],
    },
  },
  gate_failed: {
    overview: {
      scenario: channelWorkbenchScenarioDefinitions[2],
      fixturePaths: [
        "fixtures/channel_workflow_platform/cases/overview.gate_failed.json",
        "fixtures/channel_workflow_platform/cases/next_actions.gate_failed.json",
        "fixtures/channel_workflow_platform/gate_runs/gate_run.failed.json",
        "fixtures/channel_workflow_platform/issues/ledger.blocking.json",
      ],
      overview: {
        caseId: "case_s04",
        caseTitle: "XX渠道开户",
        channelName: "XX渠道",
        currentStage: "gate",
        codingReadiness: "blocked",
        latestGateSummaryStatus: "failed",
        latestSnapshotStatus: "available",
        dodSummaryStatus: "not_started",
        hasStaleGate: false,
        hasActiveException: false,
        activeExceptionCount: 0,
        blockingIssueCount: 3,
        currentSnapshot: {
          snapshotId: "snap_s04_003",
          ruleVersion: "v1.2.0",
          frozenAt: "2026-04-07T14:10:00Z",
        },
        specProgress: {
          bundleExists: true,
          publishedSections: 7,
          totalSections: 7,
          draftSections: 0,
        },
        sourceProgress: {
          totalCount: 5,
          criticalCount: 3,
          snapshottedCount: 5,
          inaccessibleCriticalCount: 0,
        },
        issueProgress: {
          blockingIssueCount: 3,
          openIssueCount: 5,
          waitingExternalCount: 1,
        },
        evidenceProgress: {
          requiredCount: 0,
          completedCount: 0,
          blockingCount: 0,
        },
        topBlockingItems: [
          {
            id: "finding_s04_001",
            type: "gate_finding",
            title: "G2-013 术语不一致",
            reason: "receiver 与 glossary 定义不一致。",
            ownerRole: "dev",
          },
          {
            id: "finding_s04_002",
            type: "gate_finding",
            title: "G3-004 外部确认未关闭",
            reason: "错误码语义尚未确认。",
            ownerRole: "pm",
          },
        ],
        statusSummary: {
          canEnterCoding: false,
          summaryText: "最近一次 Gate 未通过，需先修复阻塞项。",
          reasonCode: "LATEST_GATE_FAILED",
        },
      },
    },
    nextActions: {
      scenario: channelWorkbenchScenarioDefinitions[2],
      items: [
        {
          actionId: "act_s04_001",
          actionType: "publish_spec",
          title: "补齐 runtime-rules 中 timeout 策略",
          reason: "G2-006 指出 timeout 与重试规则缺失。",
          impact: "发布后可重新运行 Gate-2。",
          ownerRole: "dev",
          priority: 100,
          isBlocking: true,
          ctaLabel: "去处理",
          ctaType: "navigate",
          targetPage: "spec_editor",
        },
        {
          actionId: "act_s04_002",
          actionType: "follow_up_external",
          title: "关闭外部错误码语义问题",
          reason: "G3-004 关联的问题仍处于外部待确认。",
          impact: "关闭后可消除 Gate-3 阻塞项。",
          ownerRole: "pm",
          priority: 90,
          isBlocking: true,
          ctaLabel: "去问题账本",
          ctaType: "navigate",
          targetPage: "issue_ledger",
        },
        {
          actionId: "act_s04_003",
          actionType: "rerun_gate",
          title: "修复后重新运行 GATE",
          reason: "当前阻塞项修复后需要重新裁决。",
          impact: "成功通过后可进入 AI 导出。",
          ownerRole: "reviewer",
          priority: 70,
          isBlocking: true,
          ctaLabel: "立即重跑",
          ctaType: "mutation",
          targetPage: "gate_result",
        },
      ],
    },
  },
  gate_stale: {
    overview: {
      scenario: channelWorkbenchScenarioDefinitions[3],
      fixturePaths: [
        "fixtures/channel_workflow_platform/cases/overview.gate_stale.json",
        "fixtures/channel_workflow_platform/cases/next_actions.gate_stale.json",
        "fixtures/channel_workflow_platform/gate_runs/gate_run.stale.json",
      ],
      overview: {
        caseId: "case_s06",
        caseTitle: "XX渠道签约改造",
        channelName: "XX渠道",
        currentStage: "gate",
        codingReadiness: "blocked",
        latestGateSummaryStatus: "stale",
        latestSnapshotStatus: "stale",
        dodSummaryStatus: "not_started",
        hasStaleGate: true,
        hasActiveException: false,
        activeExceptionCount: 0,
        blockingIssueCount: 0,
        currentSnapshot: {
          snapshotId: "snap_s06_004",
          ruleVersion: "v1.2.0",
          frozenAt: "2026-04-07T13:40:00Z",
        },
        specProgress: {
          bundleExists: true,
          publishedSections: 7,
          totalSections: 7,
          draftSections: 1,
        },
        sourceProgress: {
          totalCount: 4,
          criticalCount: 2,
          snapshottedCount: 4,
          inaccessibleCriticalCount: 0,
        },
        issueProgress: {
          blockingIssueCount: 0,
          openIssueCount: 0,
          waitingExternalCount: 0,
        },
        evidenceProgress: {
          requiredCount: 0,
          completedCount: 0,
          blockingCount: 0,
        },
        topBlockingItems: [
          {
            id: "stale_s06_001",
            type: "stale_notice",
            title: "当前 Gate 结果已过期",
            reason: "发布内容已变化，需重新运行 Gate。",
            ownerRole: "reviewer",
          },
        ],
        statusSummary: {
          canEnterCoding: false,
          summaryText: "当前 Gate 结果基于旧快照，需重跑后才能继续。",
          reasonCode: "LATEST_GATE_STALE",
        },
      },
    },
    nextActions: {
      scenario: channelWorkbenchScenarioDefinitions[3],
      items: [
        {
          actionId: "act_s06_001",
          actionType: "rerun_gate",
          title: "重新运行 GATE",
          reason: "规范章节已更新，当前 Gate 结果已过期。",
          impact: "重跑后可恢复裁决可信度。",
          ownerRole: "reviewer",
          priority: 80,
          isBlocking: true,
          ctaLabel: "重新运行",
          ctaType: "mutation",
          targetPage: "gate_result",
        },
      ],
    },
  },
  passed_with_exception: {
    overview: {
      scenario: channelWorkbenchScenarioDefinitions[4],
      fixturePaths: [
        "fixtures/channel_workflow_platform/cases/overview.passed_with_exception.json",
        "fixtures/channel_workflow_platform/cases/next_actions.passed_with_exception.json",
      ],
      overview: {
        caseId: "case_s08",
        caseTitle: "XX渠道补单接口",
        channelName: "XX渠道",
        currentStage: "ai_ready",
        codingReadiness: "warning",
        latestGateSummaryStatus: "passed",
        latestSnapshotStatus: "available",
        dodSummaryStatus: "in_progress",
        hasStaleGate: false,
        hasActiveException: true,
        activeExceptionCount: 1,
        blockingIssueCount: 0,
        currentSnapshot: {
          snapshotId: "snap_s08_005",
          ruleVersion: "v1.2.0",
          frozenAt: "2026-04-07T12:20:00Z",
        },
        specProgress: {
          bundleExists: true,
          publishedSections: 7,
          totalSections: 7,
          draftSections: 0,
        },
        sourceProgress: {
          totalCount: 6,
          criticalCount: 3,
          snapshottedCount: 5,
          inaccessibleCriticalCount: 0,
        },
        issueProgress: {
          blockingIssueCount: 0,
          openIssueCount: 1,
          waitingExternalCount: 0,
        },
        evidenceProgress: {
          requiredCount: 8,
          completedCount: 5,
          blockingCount: 3,
        },
        topBlockingItems: [],
        statusSummary: {
          canEnterCoding: true,
          summaryText: "当前可以进入编码，但存在到期前必须补齐的例外项。",
          reasonCode: "PASSED_WITH_ACTIVE_EXCEPTION",
        },
      },
    },
    nextActions: {
      scenario: channelWorkbenchScenarioDefinitions[4],
      items: [
        {
          actionId: "act_s08_001",
          actionType: "review_exception",
          title: "查看即将到期的例外项",
          reason: "存在 1 个已批准例外即将到期。",
          impact: "提前处理可避免 readiness 回落为阻塞。",
          ownerRole: "reviewer",
          priority: 68,
          isBlocking: false,
          ctaLabel: "查看例外",
          ctaType: "navigate",
          targetPage: "snapshot_export",
        },
        {
          actionId: "act_s08_002",
          actionType: "export_ai",
          title: "导出 AI 包",
          reason: "当前快照已通过 Gate 且允许进入编码。",
          impact: "导出后开发可以开始编码。",
          ownerRole: "dev",
          priority: 60,
          isBlocking: false,
          ctaLabel: "导出 AI 包",
          ctaType: "mutation",
          targetPage: "snapshot_export",
        },
      ],
    },
  },
  dod_blocked: {
    overview: {
      scenario: channelWorkbenchScenarioDefinitions[5],
      fixturePaths: [
        "fixtures/channel_workflow_platform/cases/overview.dod_blocked.json",
        "fixtures/channel_workflow_platform/cases/dod_check.blocked.json",
        "fixtures/channel_workflow_platform/cases/next_actions.dod_blocked.json",
      ],
      overview: {
        caseId: "case_s09",
        caseTitle: "XX渠道批量开户",
        channelName: "XX渠道",
        currentStage: "dod",
        codingReadiness: "ready",
        latestGateSummaryStatus: "passed",
        latestSnapshotStatus: "available",
        dodSummaryStatus: "blocked",
        hasStaleGate: false,
        hasActiveException: false,
        activeExceptionCount: 0,
        blockingIssueCount: 0,
        currentSnapshot: {
          snapshotId: "snap_s09_006",
          ruleVersion: "v1.2.0",
          frozenAt: "2026-04-07T10:20:00Z",
        },
        specProgress: {
          bundleExists: true,
          publishedSections: 7,
          totalSections: 7,
          draftSections: 0,
        },
        sourceProgress: {
          totalCount: 7,
          criticalCount: 4,
          snapshottedCount: 7,
          inaccessibleCriticalCount: 0,
        },
        issueProgress: {
          blockingIssueCount: 0,
          openIssueCount: 0,
          waitingExternalCount: 0,
        },
        evidenceProgress: {
          requiredCount: 8,
          completedCount: 5,
          blockingCount: 3,
        },
        topBlockingItems: [
          {
            id: "dod_s09_001",
            type: "dod_obligation",
            title: "traceId 贯通验证缺失",
            reason: "staging 证据尚未上传。",
            ownerRole: "test",
          },
        ],
        statusSummary: {
          canEnterCoding: true,
          summaryText: "编码前裁决已通过，但完成定义仍被关键证据阻塞。",
          reasonCode: "DOD_BLOCKED",
        },
      },
    },
    nextActions: {
      scenario: channelWorkbenchScenarioDefinitions[5],
      items: [
        {
          actionId: "act_s09_001",
          actionType: "upload_evidence",
          title: "上传 traceId 贯通验证证据",
          reason: "当前关键义务项仍缺证据。",
          impact: "上传后可减少 DoD 阻塞项。",
          ownerRole: "test",
          priority: 58,
          isBlocking: true,
          ctaLabel: "上传证据",
          ctaType: "navigate",
          targetPage: "evidence_dod",
        },
      ],
    },
  },
};

const channelWorkbenchActionSet = new Set([
  "channel_workbench.gate_rerun_requested",
  "channel_workbench.ai_package_exported",
  "channel_workbench.evidence_uploaded",
]);

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isScenarioKey(value: unknown): value is ChannelWorkbenchScenarioKey {
  return typeof value === "string" && channelWorkbenchScenarioDefinitions.some((scenario) => scenario.key === value);
}

function readScenarioDetail(
  details: Record<string, unknown> | null | undefined,
  key: string,
): ChannelWorkbenchScenarioKey | null {
  const value = details?.[key];
  return isScenarioKey(value) ? value : null;
}

function readStringDetail(details: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumberDetail(details: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = details?.[key];
  return typeof value === "number" ? value : null;
}

function readDodSummaryStatus(
  details: Record<string, unknown> | null | undefined,
): ChannelWorkbenchOverview["dodSummaryStatus"] | null {
  const value = details?.dodSummaryStatus;
  return value === "blocked" || value === "in_progress" || value === "complete" ? value : null;
}

function syncScenarioDefinition(state: ResolvedScenarioState) {
  const definition = getScenarioDefinition(state.currentScenarioKey);
  state.overviewResponse.scenario = definition;
  state.nextActionsResponse.scenario = definition;
}

function mergeFixturePaths(currentPaths: string[], nextPaths: string[]) {
  return Array.from(new Set([...currentPaths, ...nextPaths]));
}

function applyPassedWithExceptionState(state: ResolvedScenarioState) {
  const overview = state.overviewResponse.overview;
  const template = scenarioMap.passed_with_exception.overview.overview;

  state.currentScenarioKey = "passed_with_exception";
  state.overviewResponse.fixturePaths = mergeFixturePaths(
    state.overviewResponse.fixturePaths,
    scenarioMap.passed_with_exception.overview.fixturePaths,
  );
  overview.currentStage = template.currentStage;
  overview.codingReadiness = template.codingReadiness;
  overview.latestGateSummaryStatus = template.latestGateSummaryStatus;
  overview.latestSnapshotStatus = overview.currentSnapshot ? "available" : template.latestSnapshotStatus;
  overview.dodSummaryStatus = template.dodSummaryStatus;
  overview.hasStaleGate = false;
  overview.hasActiveException = true;
  overview.activeExceptionCount = template.activeExceptionCount;
  overview.blockingIssueCount = 0;
  overview.issueProgress.blockingIssueCount = 0;
  overview.issueProgress.waitingExternalCount = 0;
  overview.evidenceProgress = cloneValue(template.evidenceProgress);
  overview.topBlockingItems = [];
  overview.statusSummary = cloneValue(template.statusSummary);
  state.nextActionsResponse.items = cloneValue(scenarioMap.passed_with_exception.nextActions.items);
  syncScenarioDefinition(state);
}

function removeAction(items: ChannelWorkbenchAction[], actionType: string) {
  return items.filter((item) => item.actionType !== actionType);
}

function applyExportAiState(state: ResolvedScenarioState) {
  const overview = state.overviewResponse.overview;
  const hasDodBlocker = overview.evidenceProgress.blockingCount > 0;

  overview.currentStage = "evidence";
  overview.latestSnapshotStatus = "available";
  overview.statusSummary = {
    canEnterCoding: true,
    summaryText: hasDodBlocker
      ? "AI 包已导出，开发可基于当前冻结快照开工，但 DoD 关键证据仍需继续补齐。"
      : "AI 包已导出，开发可基于当前冻结快照开工。",
    reasonCode: hasDodBlocker ? "AI_PACKAGE_EXPORTED_DOD_PENDING" : "AI_PACKAGE_EXPORTED",
  };
  const remainingActions = removeAction(state.nextActionsResponse.items, "export_ai");

  if (hasDodBlocker) {
    const uploadEvidenceAction = cloneValue(scenarioMap.dod_blocked.nextActions.items[0]);
    uploadEvidenceAction.reason = "AI 包已导出后，当前主链路的剩余风险转为 DoD 关键证据未闭环。";
    uploadEvidenceAction.impact = "继续补齐证据后，才能降低交付收口风险。";
    uploadEvidenceAction.priority = 64;
    state.nextActionsResponse.items = [uploadEvidenceAction, ...remainingActions];
    return;
  }

  state.nextActionsResponse.items = remainingActions;
}

function applyUploadEvidenceState(state: ResolvedScenarioState, event: ChannelWorkbenchActivity) {
  const overview = state.overviewResponse.overview;
  const completedEvidenceCount = readNumberDetail(event.details, "completedEvidenceCount");
  const remainingBlockingCount = readNumberDetail(event.details, "remainingBlockingCount");
  const obligationId = readStringDetail(event.details, "obligationId");
  const dodSummaryStatus = readDodSummaryStatus(event.details);

  if (completedEvidenceCount !== null) {
    overview.evidenceProgress.completedCount = completedEvidenceCount;
  }
  if (remainingBlockingCount !== null) {
    overview.evidenceProgress.blockingCount = Math.max(remainingBlockingCount, 0);
  }
  if (dodSummaryStatus) {
    overview.dodSummaryStatus = dodSummaryStatus;
  }
  overview.evidenceProgress.requiredCount = Math.max(
    overview.evidenceProgress.requiredCount,
    overview.evidenceProgress.completedCount + overview.evidenceProgress.blockingCount,
  );

  if (obligationId) {
    overview.topBlockingItems = overview.topBlockingItems.filter((item) => item.id !== obligationId);
  }

  if (overview.evidenceProgress.blockingCount === 0 || overview.dodSummaryStatus === "complete") {
    overview.topBlockingItems = overview.topBlockingItems.filter((item) => item.type !== "dod_obligation");
    overview.statusSummary = {
      canEnterCoding: true,
      summaryText: "关键 DoD 证据已补齐，当前没有剩余阻塞义务。",
      reasonCode: "DOD_COMPLETE",
    };
    state.nextActionsResponse.items = removeAction(state.nextActionsResponse.items, "upload_evidence");
    return;
  }

  if (!overview.topBlockingItems.some((item) => item.type === "dod_obligation")) {
    overview.topBlockingItems.push({
      id: obligationId ? `${obligationId}_remaining` : "dod_remaining_blockers",
      type: "dod_obligation",
      title: `仍有 ${overview.evidenceProgress.blockingCount} 项关键证据待补齐`,
      reason: "最近一次上传已完成，但 DoD 关键义务尚未全部闭环。",
      ownerRole: "test",
    });
  }

  overview.statusSummary = {
    canEnterCoding: true,
    summaryText: `已补齐 1 项关键证据，仍有 ${overview.evidenceProgress.blockingCount} 项 DoD 阻塞待收口。`,
    reasonCode: "DOD_BLOCKED",
  };
}

function applyActivityEvent(state: ResolvedScenarioState, event: ChannelWorkbenchActivity) {
  if (!channelWorkbenchActionSet.has(event.action)) {
    return;
  }

  if (event.action === "channel_workbench.gate_rerun_requested") {
    const currentScenario = readScenarioDetail(event.details, "currentScenario");
    if (currentScenario === "passed_with_exception") {
      applyPassedWithExceptionState(state);
      return;
    }

    if (currentScenario) {
      state.currentScenarioKey = currentScenario;
      syncScenarioDefinition(state);
    }
    return;
  }

  if (event.action === "channel_workbench.ai_package_exported") {
    applyExportAiState(state);
    return;
  }

  if (event.action === "channel_workbench.evidence_uploaded") {
    applyUploadEvidenceState(state, event);
  }
}

function getLatestActivityByAction(
  activity: ChannelWorkbenchActivity[],
  action: string,
): ChannelWorkbenchActivity | null {
  const reversed = [...activity].reverse();
  return reversed.find((item) => item.action === action) ?? null;
}

function buildSnapshotExportDetail(state: ResolvedScenarioState): ChannelWorkbenchSnapshotExportResponse {
  const overview = state.overviewResponse.overview;
  const latestExport = getLatestActivityByAction(state.activity, "channel_workbench.ai_package_exported");
  const exportId = readStringDetail(latestExport?.details, "exportId");
  const exportSnapshotId = readStringDetail(latestExport?.details, "snapshotId");
  const exportRuleVersion = readStringDetail(latestExport?.details, "ruleVersion");
  const exportStatus = readStringDetail(latestExport?.details, "status");
  const packageStatus = readStringDetail(latestExport?.details, "packageStatus");
  const detailPackageStatus =
    packageStatus === "queued" || packageStatus === "exported"
      ? packageStatus
      : exportId
        ? "exported"
        : "not_exported";
  const nextOwnerRole =
    detailPackageStatus === "exported"
      ? overview.evidenceProgress.blockingCount > 0
        ? "test"
        : overview.hasActiveException
          ? "reviewer"
          : "dev"
      : overview.hasActiveException
        ? "reviewer"
        : "dev";
  const nextStep =
    detailPackageStatus === "exported"
      ? overview.evidenceProgress.blockingCount > 0
        ? `AI 包已导出，下一步由测试补齐剩余 ${overview.evidenceProgress.blockingCount} 项 DoD 关键证据。`
        : overview.hasActiveException
          ? "AI 包已导出，下一步由架构角色跟踪活动例外直到收口。"
          : "AI 包已导出，当前主链路已可交给开发执行并准备后续收口。"
      : overview.hasActiveException
        ? `当前存在 ${overview.activeExceptionCount} 个活动例外，导出前建议先由架构角色完成例外检查。`
        : "当前冻结快照已具备导出条件，下一步由开发导出 AI 包。";

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      "fixtures/channel_workflow_platform/cases/overview.passed_with_exception.json",
    ]),
    detail: {
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      snapshotId: overview.currentSnapshot?.snapshotId ?? null,
      ruleVersion: overview.currentSnapshot?.ruleVersion ?? null,
      frozenAt: overview.currentSnapshot?.frozenAt ?? null,
      latestGateSummaryStatus: overview.latestGateSummaryStatus,
      hasActiveException: overview.hasActiveException,
      activeExceptionCount: overview.activeExceptionCount,
      packageStatus: detailPackageStatus,
      notice:
        detailPackageStatus === "exported"
          ? "最近一次 AI 包已导出，当前重点转为跟踪 DoD 收口与例外项。"
          : overview.currentSnapshot
            ? "当前冻结快照可用于导出 AI 包；导出后开发可直接开工。"
            : "当前还没有可导出的冻结快照。",
      nextOwnerRole,
      nextStep,
      latestExport:
        latestExport &&
        exportId &&
        exportSnapshotId &&
        exportRuleVersion &&
        (exportStatus === "accepted" || exportStatus === "completed") &&
        (packageStatus === "queued" || packageStatus === "exported")
          ? {
              exportId,
              snapshotId: exportSnapshotId,
              ruleVersion: exportRuleVersion,
              exportedAt: latestExport.createdAt.toISOString(),
              status: exportStatus,
              packageStatus,
            }
          : null,
    },
  };
}

function createPlaceholderDodItem(index: number): ChannelWorkbenchDodItem {
  return {
    obligationId: `dod_remaining_${index + 1}`,
    obligationTitle: `剩余关键义务 ${index + 1}`,
    status: "missing",
    sourceSection: "general",
    verificationType: "manual",
    environment: "staging",
    recommendedAction: "upload_evidence",
  };
}

function buildBlockedDodItems(state: ResolvedScenarioState): ChannelWorkbenchDodItem[] {
  const overview = state.overviewResponse.overview;
  const latestUpload = getLatestActivityByAction(state.activity, "channel_workbench.evidence_uploaded");
  const uploadedObligationId = readStringDetail(latestUpload?.details, "obligationId");
  const baseItems: ChannelWorkbenchDodItem[] = [
    {
      obligationId: "dod_s09_001",
      obligationTitle: "traceId 贯通验证",
      status: uploadedObligationId === "dod_s09_001" ? "complete" : "missing",
      sourceSection: "observability",
      verificationType: "observability",
      environment: "staging",
      recommendedAction: uploadedObligationId === "dod_s09_001" ? "none" : "upload_evidence",
    },
    {
      obligationId: "dod_s09_002",
      obligationTitle: "回调竞态场景验证",
      status: "expired",
      sourceSection: "scenarios",
      verificationType: "scenario",
      environment: "staging",
      recommendedAction: "reupload_evidence",
    },
  ];
  const visibleBlockingCount = baseItems.filter((item) => item.status !== "complete").length;
  const placeholderCount = Math.max(overview.evidenceProgress.blockingCount - visibleBlockingCount, 0);

  return [
    ...baseItems,
    ...Array.from({ length: placeholderCount }, (_, index) => createPlaceholderDodItem(index)),
  ];
}

function buildEvidenceDodDetail(state: ResolvedScenarioState): ChannelWorkbenchEvidenceDodResponse {
  const overview = state.overviewResponse.overview;
  const latestUpload = getLatestActivityByAction(state.activity, "channel_workbench.evidence_uploaded");
  const evidenceId = readStringDetail(latestUpload?.details, "evidenceId");
  const obligationId = readStringDetail(latestUpload?.details, "obligationId");
  const status = readStringDetail(latestUpload?.details, "status");
  const evidenceStatus = readStringDetail(latestUpload?.details, "evidenceStatus");
  const isComplete = overview.dodSummaryStatus === "complete" || overview.evidenceProgress.blockingCount === 0;
  const summaryStatus = isComplete
    ? "complete"
    : overview.dodSummaryStatus === "in_progress"
      ? "in_progress"
      : "blocked";
  const nextOwnerRole = isComplete ? "reviewer" : "test";
  const nextStep = isComplete
    ? "关键 DoD 证据已齐备，下一步由架构角色做最终交付收口确认。"
    : latestUpload
      ? `最近一次上传已完成，下一步继续由测试补齐剩余 ${overview.evidenceProgress.blockingCount} 项关键义务。`
      : `当前仍有 ${overview.evidenceProgress.blockingCount} 项关键证据缺失，下一步由测试开始补传。`;

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      isComplete
        ? "fixtures/channel_workflow_platform/cases/dod_check.complete.json"
        : "fixtures/channel_workflow_platform/cases/dod_check.blocked.json",
    ]),
    detail: {
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      snapshotId: overview.currentSnapshot?.snapshotId ?? null,
      summaryStatus,
      requiredObligationCount: overview.evidenceProgress.requiredCount,
      completedObligationCount: overview.evidenceProgress.completedCount,
      blockingCount: overview.evidenceProgress.blockingCount,
      nextOwnerRole,
      nextStep,
      latestUpload:
        latestUpload &&
        evidenceId &&
        obligationId &&
        (status === "accepted" || status === "completed") &&
        (evidenceStatus === "queued" || evidenceStatus === "uploaded")
          ? {
              evidenceId,
              obligationId,
              uploadedAt: latestUpload.createdAt.toISOString(),
              status,
              evidenceStatus,
            }
          : null,
      items: isComplete
        ? [
            {
              obligationId: "dod_ready_001",
              obligationTitle: "traceId 贯通验证",
              status: "complete",
              sourceSection: "observability",
              verificationType: "observability",
              environment: "staging",
              recommendedAction: "none",
            },
          ]
        : buildBlockedDodItems(state),
    },
  };
}

function buildGateResultDetail(state: ResolvedScenarioState): ChannelWorkbenchGateResultResponse {
  const overview = state.overviewResponse.overview;
  const latestRerun = getLatestActivityByAction(state.activity, "channel_workbench.gate_rerun_requested");
  const rerunGateRunId = readStringDetail(latestRerun?.details, "gateRunId");
  const rerunSummaryStatus = readStringDetail(latestRerun?.details, "gateSummaryStatus");

  if (rerunGateRunId && rerunSummaryStatus === "passed") {
    const rerunCreatedAt = latestRerun ? latestRerun.createdAt.toISOString() : new Date().toISOString();
    return {
      scenario: state.overviewResponse.scenario,
      fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
        "fixtures/channel_workflow_platform/gate_runs/gate_run.passed.json",
      ]),
      detail: {
        caseId: overview.caseId,
        gateRunId: rerunGateRunId,
        snapshotId: overview.currentSnapshot?.snapshotId ?? null,
        ruleVersion: overview.currentSnapshot?.ruleVersion ?? null,
        status: "passed",
        summaryStatus: "passed",
        startedAt: rerunCreatedAt,
        endedAt: rerunCreatedAt,
        linkedIssueCount: 0,
        staleReason: null,
        nextOwnerRole: "dev",
        nextStep: "当前裁决已通过，下一步由开发或产品转入快照确认与 AI 导出。",
        gateSummary: {
          gate1Status: "passed",
          gate2Status: "passed",
          gate3Status: "passed",
        },
        findings: [],
      },
    };
  }

  if (state.currentScenarioKey === "gate_failed") {
    const findings = overview.topBlockingItems
      .filter((item) => item.type === "gate_finding")
      .map((item, index) => ({
        findingId: item.id,
        ruleId: index === 0 ? "G2-013" : "G3-004",
        gateStage: index === 0 ? "GATE-2" : "GATE-3",
        severity: item.ownerRole === "dev" ? "critical" : "high",
        title: item.title,
        reason: item.reason,
        ownerRole: item.ownerRole,
        allowException: item.ownerRole === "pm" ? "controlled" : "never",
      }));

    return {
      scenario: state.overviewResponse.scenario,
      fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
        "fixtures/channel_workflow_platform/gate_runs/gate_run.failed.json",
      ]),
      detail: {
        caseId: overview.caseId,
        gateRunId: "gate_s04_001",
        snapshotId: overview.currentSnapshot?.snapshotId ?? null,
        ruleVersion: overview.currentSnapshot?.ruleVersion ?? null,
        status: "failed",
        summaryStatus: "failed",
        startedAt: "2026-04-07T14:20:00Z",
        endedAt: "2026-04-07T14:22:00Z",
        linkedIssueCount: overview.issueProgress.blockingIssueCount,
        staleReason: null,
        nextOwnerRole: findings[0]?.ownerRole ?? "reviewer",
        nextStep:
          findings.length > 0
            ? `当前首要动作由${roleLabelMap[findings[0].ownerRole] ?? findings[0].ownerRole}处理“${findings[0].title}”，随后再由架构角色重新裁决。`
            : "当前 Gate 未通过，下一步先收敛阻塞发现项，再重新裁决。",
        gateSummary: {
          gate1Status: "passed",
          gate2Status: "failed",
          gate3Status: "failed",
        },
        findings,
      },
    };
  }

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      "fixtures/channel_workflow_platform/gate_runs/gate_run.stale.json",
    ]),
    detail: {
      caseId: overview.caseId,
      gateRunId: "gate_s06_002",
      snapshotId: overview.currentSnapshot?.snapshotId ?? null,
      ruleVersion: overview.currentSnapshot?.ruleVersion ?? null,
      status: overview.hasStaleGate ? "stale" : "passed",
      summaryStatus: overview.hasStaleGate ? "stale" : "passed",
      startedAt: overview.currentSnapshot?.frozenAt ?? null,
      endedAt: overview.currentSnapshot?.frozenAt ?? null,
      linkedIssueCount: overview.issueProgress.blockingIssueCount,
      staleReason: overview.hasStaleGate ? "发布内容已变化，需要基于最新快照重新裁决。" : null,
      nextOwnerRole: overview.hasStaleGate ? "reviewer" : "dev",
      nextStep: overview.hasStaleGate
        ? "当前结果已过期，下一步由架构角色基于最新快照重新运行 Gate。"
        : "当前裁决仍有效，下一步可继续进入快照导出或交付收口。",
      gateSummary: {
        gate1Status: "passed",
        gate2Status: overview.hasStaleGate ? "stale" : "passed",
        gate3Status: overview.hasStaleGate ? "stale" : "passed",
      },
      findings: [],
    },
  };
}

function buildIssueLedgerDetail(state: ResolvedScenarioState): ChannelWorkbenchIssueLedgerResponse {
  const overview = state.overviewResponse.overview;
  const waitingExternalOnly = overview.issueProgress.waitingExternalCount > 0 && overview.issueProgress.blockingIssueCount === 0;
  const baseBlockingItems = overview.topBlockingItems.filter(
    (item) => item.type === "gate_finding" || item.type === "issue" || item.type === "dod_obligation",
  );
  const items: ChannelWorkbenchIssueLedgerResponse["detail"]["items"] = baseBlockingItems.map((item, index) => ({
    issueId: `issue_${overview.caseId}_${index + 1}`,
    title: item.title,
    severity: item.type === "dod_obligation" ? "critical" : item.ownerRole === "pm" ? "high" : "critical",
    status: item.type === "dod_obligation" ? "in_progress" : "open",
    ownerName: item.ownerRole === "test" ? "测试A" : item.ownerRole === "pm" ? "产品经理A" : "张三",
    dueAt: `2026-04-08T${String(12 + index * 2).padStart(2, "0")}:00:00Z`,
    sourceRuleId:
      item.type === "dod_obligation"
        ? "DOD-001"
        : item.ownerRole === "pm"
          ? "G3-004"
          : "G2-013",
    blockingStage: item.type === "dod_obligation" ? "dod" : "gate",
  }));

  if (overview.issueProgress.waitingExternalCount > 0) {
    items.push({
      issueId: `issue_external_${overview.caseId}`,
      title: "外部错误码语义待确认",
      severity: "high",
      status: "waiting_external",
      ownerName: "产品经理A",
      dueAt: "2026-04-08T12:00:00Z",
      sourceRuleId: "G3-004",
      blockingStage: "gate",
    });
  }

  while (items.length < overview.issueProgress.blockingIssueCount) {
    const index = items.length;
    items.push({
      issueId: `issue_placeholder_${overview.caseId}_${index + 1}`,
      title: `阻塞问题 ${index + 1}`,
      severity: "medium",
      status: "open",
      ownerName: "协作中",
      dueAt: null,
      sourceRuleId: null,
      blockingStage: overview.currentStage === "dod" ? "dod" : "gate",
    });
  }

  const nextOwnerRole =
    items[0]?.status === "waiting_external"
      ? "pm"
      : baseBlockingItems[0]?.ownerRole ?? (waitingExternalOnly ? "pm" : overview.currentStage === "dod" ? "test" : "reviewer");
  const nextStep =
    items[0]?.status === "waiting_external"
      ? "当前账本以外部待确认为主，下一步由产品推进外部反馈闭环。"
      : items[0]
        ? `当前优先处理“${items[0].title}”，收敛后再继续推进主链路。`
        : "当前账本没有额外阻塞，下一步可回到主链路继续推进。";

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      waitingExternalOnly
        ? "fixtures/channel_workflow_platform/issues/ledger.waiting_external_only.json"
        : "fixtures/channel_workflow_platform/issues/ledger.blocking.json",
    ]),
    detail: {
      caseId: overview.caseId,
      waitingExternalOnly,
      openCount: Math.max(overview.issueProgress.openIssueCount, items.length),
      blockingCount: overview.issueProgress.blockingIssueCount,
      nextOwnerRole,
      nextStep,
      items,
    },
  };
}

function sortActions(items: ChannelWorkbenchAction[]) {
  return [...items].sort((left, right) => {
    if (left.isBlocking !== right.isBlocking) {
      return left.isBlocking ? -1 : 1;
    }
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

function buildComputedNextActions(state: ResolvedScenarioState): ChannelWorkbenchAction[] {
  const overview = state.overviewResponse.overview;
  const latestExport = getLatestActivityByAction(state.activity, "channel_workbench.ai_package_exported");
  const actions: ChannelWorkbenchAction[] = [];
  const requiredMissingSections = overview.specProgress.requiredMissingSections ?? [];
  const pushAction = (action: ChannelWorkbenchAction) => {
    actions.push(action);
  };

  if (overview.sourceProgress.totalCount === 0) {
    pushAction({
      actionId: `act_${overview.caseId}_add_source`,
      actionType: "add_source",
      title: "添加关键来源资料",
      reason: "当前没有任何关键来源资料。",
      impact: "补齐后才能生成规范模板并继续后续流程。",
      ownerRole: "pm",
      priority: 98,
      isBlocking: true,
      ctaLabel: "添加资料",
      ctaType: "navigate",
      targetPage: "source_documents",
    });
    return sortActions(actions);
  }

  if (overview.sourceProgress.inaccessibleCriticalCount > 0) {
    pushAction({
      actionId: `act_${overview.caseId}_restore_source_access`,
      actionType: "fix_source",
      title: `恢复 ${overview.sourceProgress.inaccessibleCriticalCount} 份关键资料可访问性`,
      reason: "关键资料仍存在失效链接或权限问题，规范与快照链路无法稳定复现。",
      impact: "恢复访问后，规范编辑和后续 Gate 才能继续建立在可信输入之上。",
      ownerRole: "pm",
      priority: 94,
      isBlocking: true,
      ctaLabel: "去资料页",
      ctaType: "navigate",
      targetPage: "source_documents",
    });
  }

  for (const section of requiredMissingSections) {
    if (section === "runtime_rules") {
      pushAction({
        actionId: `act_${overview.caseId}_publish_runtime_rules`,
        actionType: "publish_spec",
        title: "发布 runtime-rules 章节",
        reason: "timeout、重试或幂等规则仍未发布，当前无法进入可信 Gate。",
        impact: "发布后可恢复接口运行规则的审查基础。",
        ownerRole: "dev",
        priority: 90,
        isBlocking: true,
        ctaLabel: "去编辑规范",
        ctaType: "navigate",
        targetPage: "spec_editor",
      });
      continue;
    }

    if (section === "testcases") {
      pushAction({
        actionId: `act_${overview.caseId}_complete_testcases`,
        actionType: "complete_spec",
        title: "补齐 testcases 关键义务项",
        reason: "测试义务仍不完整，后续 Gate 与 DoD 都会失去验证抓手。",
        impact: "补齐后可减少后续收口阶段的返工。",
        ownerRole: "test",
        priority: 86,
        isBlocking: true,
        ctaLabel: "补齐义务项",
        ctaType: "navigate",
        targetPage: "spec_editor",
      });
      continue;
    }

    pushAction({
      actionId: `act_${overview.caseId}_publish_${section}`,
      actionType: "publish_spec",
      title: `发布 ${section} 章节`,
      reason: `${section} 当前仍未达到可发布状态。`,
      impact: "补齐后可减少后续 Gate 的不确定性。",
      ownerRole: "dev",
      priority: 82,
      isBlocking: true,
      ctaLabel: "去编辑规范",
      ctaType: "navigate",
      targetPage: "spec_editor",
    });
  }

  if (requiredMissingSections.length === 0 && overview.specProgress.draftSections > 0) {
    pushAction({
      actionId: `act_${overview.caseId}_publish_draft_sections`,
      actionType: "publish_spec",
      title: `清理并发布 ${overview.specProgress.draftSections} 个草稿章节`,
      reason: "当前仍存在草稿章节，快照与 Gate 仍可能使用到未冻结内容。",
      impact: "发布后可减少 Gate stale 与多人协作理解偏差。",
      ownerRole: "dev",
      priority: 84,
      isBlocking: true,
      ctaLabel: "去编辑规范",
      ctaType: "navigate",
      targetPage: "spec_editor",
    });
  }

  if (actions.some((item) => item.targetPage === "spec_editor" || item.targetPage === "source_documents")) {
    return sortActions(actions);
  }

  if (!overview.currentSnapshot) {
    pushAction({
      actionId: `act_${overview.caseId}_create_snapshot`,
      actionType: "create_snapshot",
      title: "生成冻结快照",
      reason: "规范已满足最小发布条件，但当前还没有冻结快照。",
      impact: "生成快照后才能运行 Gate 或继续导出链路。",
      ownerRole: "dev",
      priority: 79,
      isBlocking: true,
      ctaLabel: "查看快照",
      ctaType: "navigate",
      targetPage: "snapshot_export",
    });
    return sortActions(actions);
  }

  if (overview.currentSnapshot && overview.latestGateSummaryStatus === "missing") {
    pushAction({
      actionId: `act_${overview.caseId}_run_gate`,
      actionType: "run_gate",
      title: "运行首次 GATE",
      reason: "已有冻结快照，但当前还没有可信裁决结果。",
      impact: "拿到 Gate 结果后，才能判断是否允许进入编码。",
      ownerRole: "reviewer",
      priority: 78,
      isBlocking: true,
      ctaLabel: "去 Gate",
      ctaType: "navigate",
      targetPage: "gate_result",
    });
    return sortActions(actions);
  }

  if (overview.hasStaleGate) {
    pushAction({
      actionId: `act_${overview.caseId}_rerun_gate`,
      actionType: "rerun_gate",
      title: "重新运行 GATE",
      reason: "规范章节已更新，当前 Gate 结果已过期。",
      impact: "重跑后可恢复裁决可信度。",
      ownerRole: "reviewer",
      priority: 80,
      isBlocking: true,
      ctaLabel: "重新运行",
      ctaType: "mutation",
      targetPage: "gate_result",
    });
    return sortActions(actions);
  }

  if (overview.latestGateSummaryStatus === "failed") {
    const leadFinding = overview.topBlockingItems.find((item) => item.type === "gate_finding");

    if (leadFinding) {
      pushAction({
        actionId: `act_${overview.caseId}_resolve_${leadFinding.id}`,
        actionType: leadFinding.ownerRole === "pm" ? "follow_up_external" : "publish_spec",
        title: `处理 Gate 阻塞：${leadFinding.title}`,
        reason: leadFinding.reason,
        impact: "先收敛最高优先级阻塞，再进入下一次裁决。",
        ownerRole: leadFinding.ownerRole,
        priority: 100,
        isBlocking: true,
        ctaLabel: leadFinding.ownerRole === "pm" ? "去问题账本" : "去处理",
        ctaType: "navigate",
        targetPage: leadFinding.ownerRole === "pm" ? "issue_ledger" : "spec_editor",
      });
    }

    if (overview.issueProgress.waitingExternalCount > 0) {
      pushAction({
        actionId: `act_${overview.caseId}_follow_external`,
        actionType: "follow_up_external",
        title: `关闭 ${overview.issueProgress.waitingExternalCount} 个外部待确认问题`,
        reason: "仍有外部待确认问题阻塞 Gate。",
        impact: "关闭后可消除 Gate-3 的跨团队阻塞。",
        ownerRole: "pm",
        priority: 92,
        isBlocking: true,
        ctaLabel: "去问题账本",
        ctaType: "navigate",
        targetPage: "issue_ledger",
      });
    }

    if (overview.issueProgress.blockingIssueCount > 0) {
      pushAction({
        actionId: `act_${overview.caseId}_triage_blocking_issues`,
        actionType: "fix_issue",
        title: `收敛 ${overview.issueProgress.blockingIssueCount} 个阻塞问题`,
        reason: "问题账本仍存在直接阻塞 Gate 或 DoD 的事项。",
        impact: "统一梳理 owner 和优先级后，多角色推进会更稳定。",
        ownerRole: "reviewer",
        priority: 88,
        isBlocking: true,
        ctaLabel: "查看问题",
        ctaType: "navigate",
        targetPage: "issue_ledger",
      });
    }

    pushAction({
      actionId: `act_${overview.caseId}_rerun_gate_after_fix`,
      actionType: "rerun_gate",
      title: "修复后重新运行 GATE",
      reason: "阻塞项关闭后需要重新裁决。",
      impact: "通过后可进入快照导出阶段。",
      ownerRole: "reviewer",
      priority: 70,
      isBlocking: true,
      ctaLabel: "立即重跑",
      ctaType: "mutation",
      targetPage: "gate_result",
    });
    return sortActions(actions);
  }

  if (overview.hasActiveException) {
    pushAction({
      actionId: `act_${overview.caseId}_review_exception`,
      actionType: "review_exception",
      title: "查看即将到期的例外项",
      reason: `存在 ${overview.activeExceptionCount} 个活动例外需要持续跟踪。`,
      impact: "提前处理可避免 readiness 回落为阻塞。",
      ownerRole: "reviewer",
      priority: 68,
      isBlocking: false,
      ctaLabel: "查看例外",
      ctaType: "navigate",
      targetPage: "snapshot_export",
    });
  }

  if (
    !latestExport &&
    overview.currentStage === "ai_ready" &&
    overview.currentSnapshot &&
    overview.latestGateSummaryStatus === "passed" &&
    !overview.hasStaleGate
  ) {
    pushAction({
      actionId: `act_${overview.caseId}_export_ai`,
      actionType: "export_ai",
      title: "导出 AI 包",
      reason: "当前快照已通过 Gate 且允许进入编码。",
      impact: "导出后开发可以开始编码。",
      ownerRole: "dev",
      priority: 60,
      isBlocking: false,
      ctaLabel: "导出 AI 包",
      ctaType: "mutation",
      targetPage: "snapshot_export",
    });
  }

  if (
    overview.evidenceProgress.blockingCount > 0 &&
    (overview.currentStage === "evidence" || overview.currentStage === "dod" || overview.dodSummaryStatus === "blocked")
  ) {
    pushAction({
      actionId: `act_${overview.caseId}_upload_evidence`,
      actionType: "upload_evidence",
      title:
        latestExport || overview.currentStage === "evidence"
          ? `上传关键证据并推进剩余 ${overview.evidenceProgress.blockingCount} 项 DoD 收口`
          : "上传 traceId 贯通验证证据",
      reason:
        latestExport || overview.currentStage === "evidence"
          ? "AI 包已导出后，当前主链路风险已转为 DoD 关键证据未闭环。"
          : "当前关键义务项仍缺证据。",
      impact:
        latestExport || overview.currentStage === "evidence"
          ? "继续补齐证据后，才能降低交付收口风险。"
          : "上传后可减少 DoD 阻塞项。",
      ownerRole: "test",
      priority: latestExport || overview.currentStage === "evidence" ? 64 : 58,
      isBlocking: true,
      ctaLabel: "上传证据",
      ctaType: "navigate",
      targetPage: "evidence_dod",
    });
  }

  return sortActions(actions);
}

function buildSourceDocumentsDetail(state: ResolvedScenarioState): ChannelWorkbenchSourceDocumentsResponse {
  const overview = state.overviewResponse.overview;
  const sourceTypes = ["link", "apifox", "file", "wiki"] as const;
  const sourceTitles = ["渠道接口文档", "APIFOX 项目", "错误码说明", "渠道 FAQ", "联调邮件", "回调样例"] as const;
  const ownerNames = ["张三", "李四", "王五", "测试A"] as const;
  const items =
    state.currentScenarioKey === "no_source"
      ? []
      : Array.from({ length: overview.sourceProgress.totalCount }, (_, index) => {
          const isCritical = index < overview.sourceProgress.criticalCount;
          const isInaccessibleCritical = isCritical && index < overview.sourceProgress.inaccessibleCriticalCount;
          const isSnapshotted = index < overview.sourceProgress.snapshottedCount;
          const isStale = !isInaccessibleCritical && !isSnapshotted && index === overview.sourceProgress.totalCount - 1;

          return {
            sourceId: `src_${overview.caseId}_${index + 1}`,
            sourceType: sourceTypes[index % sourceTypes.length],
            sourceTitle: `${sourceTitles[index % sourceTitles.length]} ${index + 1}`,
            isCritical,
            snapshotStatus: isInaccessibleCritical ? "missing" : isSnapshotted ? "snapshotted" : isStale ? "stale" : "unsnapshotted",
            availabilityStatus: isInaccessibleCritical ? "inaccessible" : isStale ? "stale" : "accessible",
            ownerName: ownerNames[index % ownerNames.length],
          };
        });
  const nextOwnerRole =
    overview.sourceProgress.totalCount === 0
      ? "pm"
      : overview.sourceProgress.inaccessibleCriticalCount > 0
        ? "pm"
        : overview.sourceProgress.snapshottedCount < overview.sourceProgress.criticalCount
          ? "dev"
          : "dev";
  const nextStep =
    overview.sourceProgress.totalCount === 0
      ? "当前还没有来源资料，下一步由产品先补齐关键输入。"
      : overview.sourceProgress.inaccessibleCriticalCount > 0
        ? `当前有 ${overview.sourceProgress.inaccessibleCriticalCount} 份关键资料不可访问，下一步由产品协调恢复链接或权限。`
        : overview.sourceProgress.snapshottedCount < overview.sourceProgress.criticalCount
          ? "关键资料尚未全部进入快照链路，下一步由开发补齐冻结前整理。"
          : "来源资料已基本齐备，下一步可进入规范沉淀与章节发布。";

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      state.currentScenarioKey === "no_source"
        ? "fixtures/channel_workflow_platform/source_documents/list.empty.json"
        : "fixtures/channel_workflow_platform/source_documents/list.mixed.json",
    ]),
    detail: {
      caseId: overview.caseId,
      totalCount: overview.sourceProgress.totalCount,
      criticalCount: overview.sourceProgress.criticalCount,
      snapshottedCount: overview.sourceProgress.snapshottedCount,
      inaccessibleCriticalCount: overview.sourceProgress.inaccessibleCriticalCount,
      nextOwnerRole,
      nextStep,
      items,
    },
  };
}

function buildSpecEditorDetail(state: ResolvedScenarioState): ChannelWorkbenchSpecEditorResponse {
  const overview = state.overviewResponse.overview;
  const sectionCatalog = [
    { sectionId: "glossary", title: "术语表" },
    { sectionId: "api_contract", title: "接口契约" },
    { sectionId: "runtime_rules", title: "运行规则" },
    { sectionId: "error_codes", title: "错误码" },
    { sectionId: "testcases", title: "测试用例" },
    { sectionId: "observability", title: "可观测性" },
    { sectionId: "examples", title: "样例与边界" },
  ] as const;
  const requiredMissing = new Set(overview.specProgress.requiredMissingSections ?? []);
  const extraDraftSlots = Math.max(overview.specProgress.draftSections - requiredMissing.size, 0);
  const extraDraftSectionIds = new Set(
    sectionCatalog
      .slice(0, overview.specProgress.totalSections)
      .map((section) => section.sectionId)
      .filter((sectionId) => !requiredMissing.has(sectionId))
      .slice(-extraDraftSlots),
  );
  const items = sectionCatalog.slice(0, overview.specProgress.totalSections).map((section, index) => {
    const isRequiredMissing = requiredMissing.has(section.sectionId);
    const shouldBeDraft = isRequiredMissing || extraDraftSectionIds.has(section.sectionId);
    const lintStatus = isRequiredMissing
      ? section.sectionId === "testcases"
        ? "warn"
        : "error"
      : shouldBeDraft
        ? "warn"
        : "clean";
    const totalFields = section.sectionId === "runtime_rules" || section.sectionId === "testcases" ? 5 : 3;
    const completedFields = isRequiredMissing
      ? Math.max(totalFields - 2, 1)
      : shouldBeDraft
        ? totalFields - 1
        : totalFields;
    const status = shouldBeDraft ? "draft" : "published";
    const lastPublishedAt = status === "published" ? `2026-04-07T${String(10 + index).padStart(2, "0")}:00:00Z` : null;

    return {
      sectionId: `sec_${section.sectionId}_${overview.caseId}`,
      sectionType: section.sectionId,
      title: section.title,
      status,
      completedFields,
      totalFields,
      lintStatus,
      lastPublishedAt,
    };
  });
  const errorSections = items.filter((item) => item.lintStatus === "error").length;
  const warnSections = items.filter((item) => item.lintStatus === "warn").length;
  const leadDraftItem = items.find((item) => item.status === "draft") ?? null;
  const nextOwnerRole =
    requiredMissing.has("testcases")
      ? "test"
      : requiredMissing.size > 0 || overview.specProgress.draftSections > 0
        ? "dev"
        : "reviewer";
  const nextStep =
    requiredMissing.has("runtime_rules")
      ? "runtime-rules 仍未发布，下一步由开发先补齐运行规则。"
      : requiredMissing.has("testcases")
        ? "testcases 关键义务未完成，下一步由测试补齐验证章节。"
        : leadDraftItem
          ? `当前仍有草稿章节“${leadDraftItem.title}”，下一步先发布后再进入快照或 Gate。`
          : "规范章节已稳定，下一步可继续生成冻结快照或进入裁决。";
  const riskTier =
    errorSections > 0 || overview.latestGateSummaryStatus === "failed"
      ? "high"
      : warnSections > 0 || overview.hasStaleGate
        ? "medium"
        : "low";

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      overview.specProgress.draftSections > 0 || requiredMissing.size > 0
        ? "fixtures/channel_workflow_platform/cases/spec_bundle.incomplete.json"
        : "fixtures/channel_workflow_platform/cases/spec_bundle.ready.json",
    ]),
    detail: {
      caseId: overview.caseId,
      bundleId: `bundle_${overview.caseId}`,
      templateVersion: "default-v1",
      riskTier,
      publishedSections: overview.specProgress.publishedSections,
      totalSections: overview.specProgress.totalSections,
      draftSections: overview.specProgress.draftSections,
      errorSections,
      warnSections,
      nextOwnerRole,
      nextStep,
      items,
    },
  };
}

function buildRoleViewDetail(state: ResolvedScenarioState): ChannelWorkbenchRoleViewResponse {
  const overview = state.overviewResponse.overview;
  const roles = ["pm", "reviewer", "dev", "test"];

  return {
    scenario: state.overviewResponse.scenario,
    fixturePaths: mergeFixturePaths(state.overviewResponse.fixturePaths, [
      "fixtures/channel_workflow_platform/cases/role_view.derived.json",
    ]),
    detail: {
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      lanes: roles.map((role) => {
        const actions = state.nextActionsResponse.items
          .filter((item) => item.ownerRole === role)
          .sort((left, right) => right.priority - left.priority);
        const primaryAction = actions[0] ?? null;
        const blockingActions = actions.filter((item) => item.isBlocking).length;
        const status = blockingActions > 0 ? "blocked" : actions.length > 0 ? "assist" : "idle";
        const summary = primaryAction
          ? primaryAction.reason
          : role === "reviewer" && overview.statusSummary.canEnterCoding
            ? "当前无额外裁决动作，重点转为例外治理和交付收口。"
            : "当前首屏没有分配给该角色的动作。";

        return {
          role,
          label: roleLabelMap[role] ?? role,
          totalActions: actions.length,
          blockingActions,
          status,
          summary,
          primaryAction: primaryAction
            ? {
                actionId: primaryAction.actionId,
                actionType: primaryAction.actionType,
                title: primaryAction.title,
                reason: primaryAction.reason,
                targetPage: primaryAction.targetPage,
                priority: primaryAction.priority,
                isBlocking: primaryAction.isBlocking,
              }
            : null,
        };
      }),
    },
  };
}

async function listCaseActivity(db: Db, companyId: string, caseId: string) {
  return db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "channel_case"),
        eq(activityLog.entityId, caseId),
      ),
    )
    .orderBy(asc(activityLog.createdAt));
}

async function resolveScenarioState(
  db: Db,
  companyId: string,
  scenarioInput?: string,
): Promise<ResolvedScenarioState> {
  const baseScenarioKey = parseScenarioKey(scenarioInput);
  const baseRecord = scenarioMap[baseScenarioKey];
  const state: ResolvedScenarioState = {
    currentScenarioKey: baseScenarioKey,
    overviewResponse: cloneValue(baseRecord.overview),
    nextActionsResponse: cloneValue(baseRecord.nextActions),
    activity: [],
  };
  const caseId = state.overviewResponse.overview.caseId;
  const activity = await listCaseActivity(db, companyId, caseId);
  state.activity = activity;

  for (const event of activity) {
    applyActivityEvent(state, event);
  }

  state.nextActionsResponse.items = buildComputedNextActions(state);
  syncScenarioDefinition(state);
  return state;
}

function parseScenarioKey(input: string | undefined): ChannelWorkbenchScenarioKey {
  if (!input) return "gate_failed";
  const exists = channelWorkbenchScenarioDefinitions.some((scenario) => scenario.key === input);
  if (!exists) {
    throw badRequest("Invalid channel workbench scenario");
  }
  return input as ChannelWorkbenchScenarioKey;
}

async function assertCompanyExists(db: Db, companyId: string) {
  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);

  if (!company) {
    throw notFound("Company not found");
  }
}

function getScenarioDefinition(key: ChannelWorkbenchScenarioKey): ChannelWorkbenchScenarioDefinition {
  return channelWorkbenchScenarioDefinitions.find((scenario) => scenario.key === key) ?? channelWorkbenchScenarioDefinitions[2];
}

function buildRerunGateResult(state: ResolvedScenarioState): ChannelWorkbenchRerunGateResponse {
  const overview = state.overviewResponse.overview;
  const executedAt = new Date().toISOString();
  const gateRunId = `gate_run_${overview.caseId}_${executedAt.slice(11, 19).replaceAll(":", "")}`;

  if (state.currentScenarioKey === "gate_stale") {
    return {
      previousScenario: getScenarioDefinition("gate_stale"),
      currentScenario: getScenarioDefinition("passed_with_exception"),
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      gateRunId,
      executedAt,
      status: "completed",
      gateSummaryStatus: "passed",
      message: "已基于最新快照完成 Gate 重跑，当前转为“通过但有例外”，下一步建议去处理快照与 AI 导出。",
      targetPage: "snapshot_export",
    };
  }

  if (state.currentScenarioKey === "gate_failed") {
    return {
      previousScenario: getScenarioDefinition("gate_failed"),
      currentScenario: getScenarioDefinition("gate_failed"),
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      gateRunId,
      executedAt,
      status: "accepted",
      gateSummaryStatus: "failed",
      message: "已记录一次 Gate 重跑，但当前阻塞项仍未关闭，结果保持未通过，建议回到问题账本继续收敛。",
      targetPage: "issue_ledger",
    };
  }

  throw badRequest("Current scenario does not support rerun gate");
}

function buildExportAiResult(state: ResolvedScenarioState): ChannelWorkbenchExportAiResponse {
  const overview = state.overviewResponse.overview;
  const snapshotId = overview.currentSnapshot?.snapshotId;
  const ruleVersion = overview.currentSnapshot?.ruleVersion;

  if (!snapshotId || !ruleVersion) {
    throw badRequest("Current scenario does not have an exportable snapshot");
  }

  const executedAt = new Date().toISOString();
  const exportId = `ai_export_${overview.caseId}_${executedAt.slice(11, 19).replaceAll(":", "")}`;

  if (state.currentScenarioKey === "passed_with_exception") {
    return {
      previousScenario: getScenarioDefinition("passed_with_exception"),
      currentScenario: getScenarioDefinition("passed_with_exception"),
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      exportId,
      snapshotId,
      ruleVersion,
      executedAt,
      status: "completed",
      packageStatus: "exported",
      message: "AI 包已基于当前冻结快照导出，可交给开发开工；活动例外与 DoD 义务仍需继续跟踪。",
      targetPage: "evidence_dod",
    };
  }

  throw badRequest("Current scenario does not support export ai");
}

function buildUploadEvidenceResult(state: ResolvedScenarioState): ChannelWorkbenchUploadEvidenceResponse {
  const overview = state.overviewResponse.overview;
  const blockingItem = overview.topBlockingItems.find((item) => item.type === "dod_obligation");

  if (!blockingItem) {
    throw badRequest("Current scenario does not have an uploadable evidence obligation");
  }

  const executedAt = new Date().toISOString();
  const evidenceId = `evidence_${overview.caseId}_${executedAt.slice(11, 19).replaceAll(":", "")}`;

  if (state.currentScenarioKey === "dod_blocked") {
    return {
      previousScenario: getScenarioDefinition("dod_blocked"),
      currentScenario: getScenarioDefinition("dod_blocked"),
      caseId: overview.caseId,
      caseTitle: overview.caseTitle,
      evidenceId,
      obligationId: blockingItem.id,
      executedAt,
      status: "completed",
      evidenceStatus: "uploaded",
      completedEvidenceCount: overview.evidenceProgress.completedCount + 1,
      remainingBlockingCount: Math.max(overview.evidenceProgress.blockingCount - 1, 0),
      dodSummaryStatus: "blocked",
      message: "已上传一项关键证据，但 DoD 仍未全部闭环，建议继续补齐剩余阻塞义务。",
      targetPage: "evidence_dod",
    };
  }

  throw badRequest("Current scenario does not support upload evidence");
}

export function channelWorkbenchService(db: Db) {
  return {
    getOverview: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return state.overviewResponse;
    },

    getNextActions: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return state.nextActionsResponse;
    },

    getSnapshotExport: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildSnapshotExportDetail(state);
    },

    getEvidenceDod: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildEvidenceDodDetail(state);
    },

    getGateResult: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildGateResultDetail(state);
    },

    getIssueLedger: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildIssueLedgerDetail(state);
    },

    getSourceDocuments: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildSourceDocumentsDetail(state);
    },

    getSpecEditor: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildSpecEditorDetail(state);
    },

    getRoleView: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      return buildRoleViewDetail(state);
    },

    rerunGate: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      const result = buildRerunGateResult(state);

      const targetPageExists = channelWorkbenchPageDefinitions.some((page) => page.id === result.targetPage);
      if (!targetPageExists) {
        throw badRequest("Invalid rerun gate target page");
      }

      return result;
    },

    exportAi: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      const result = buildExportAiResult(state);

      const targetPageExists = channelWorkbenchPageDefinitions.some((page) => page.id === result.targetPage);
      if (!targetPageExists) {
        throw badRequest("Invalid export ai target page");
      }

      return result;
    },

    uploadEvidence: async (companyId: string, scenarioInput?: string) => {
      await assertCompanyExists(db, companyId);
      const state = await resolveScenarioState(db, companyId, scenarioInput);
      const result = buildUploadEvidenceResult(state);

      const targetPageExists = channelWorkbenchPageDefinitions.some((page) => page.id === result.targetPage);
      if (!targetPageExists) {
        throw badRequest("Invalid upload evidence target page");
      }

      return result;
    },
  };
}
