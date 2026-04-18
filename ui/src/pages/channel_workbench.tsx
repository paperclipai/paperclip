import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  FlaskConical,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  channelWorkbenchPageDefinitions,
  channelWorkbenchScenarioDefinitions,
  type ActivityEvent,
  type ChannelWorkbenchAction,
  type ChannelWorkbenchEvidenceDodResponse,
  type ChannelWorkbenchExportAiResponse,
  type ChannelWorkbenchGateResultResponse,
  type ChannelWorkbenchIssueLedgerResponse,
  type ChannelWorkbenchOverview,
  type ChannelWorkbenchPageId,
  type ChannelWorkbenchRerunGateResponse,
  type ChannelWorkbenchRoleViewResponse,
  type ChannelWorkbenchScenarioKey,
  type ChannelWorkbenchSourceDocumentsResponse,
  type ChannelWorkbenchSpecEditorResponse,
  type ChannelWorkbenchSnapshotExportResponse,
  type ChannelWorkbenchUploadEvidenceResponse,
} from "@paperclipai/shared";

import { channelWorkbenchApi } from "@/api/channel_workbench";
import { activityApi } from "@/api/activity";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

const stage_label_map: Record<string, string> = {
  intake: "资料整理中",
  spec: "规范沉淀中",
  gate: "Gate 审核中",
  ai_ready: "可进入编码",
  evidence: "证据补齐中",
  dod: "完成定义检查",
};

const status_label_map: Record<string, string> = {
  blocked: "阻塞",
  warning: "警告",
  ready: "就绪",
  missing: "缺失",
  running: "运行中",
  failed: "未通过",
  passed: "通过",
  stale: "已过期",
  available: "可用",
  not_started: "未开始",
  in_progress: "进行中",
  complete: "已完成",
  accessible: "可访问",
  inaccessible: "不可访问",
  unsnapshotted: "待快照",
  snapshotted: "已快照",
  clean: "已校验",
  warn: "待完善",
  error: "需修复",
  open: "待处理",
  waiting_external: "待外部确认",
  accepted: "已受理",
  uploaded: "已上传",
  queued: "排队中",
};

const banner_style_map: Record<string, string> = {
  blocked: "border-red-500/25 bg-red-50 dark:bg-red-950/30",
  warning: "border-amber-500/25 bg-amber-50 dark:bg-amber-950/30",
  ready: "border-emerald-500/25 bg-emerald-50 dark:bg-emerald-950/30",
};

const metric_style_map: Record<string, string> = {
  blocked: "text-red-700 dark:text-red-300",
  warning: "text-amber-700 dark:text-amber-300",
  ready: "text-emerald-700 dark:text-emerald-300",
  assist: "text-sky-700 dark:text-sky-300",
  idle: "text-muted-foreground",
  failed: "text-red-700 dark:text-red-300",
  stale: "text-amber-700 dark:text-amber-300",
  passed: "text-emerald-700 dark:text-emerald-300",
  complete: "text-emerald-700 dark:text-emerald-300",
};

const page_copy_map: Record<
  ChannelWorkbenchPageId,
  {
    label: string;
    description: string;
    emptyActionsText: string;
    emptyBlockingText: string;
  }
> = {
  source_documents: {
    label: "来源资料",
    description: "聚焦关键资料是否齐全、可访问、已快照，先解决 intake 阶段的根因。",
    emptyActionsText: "当前场景下，来源资料页没有额外动作。",
    emptyBlockingText: "当前没有来源资料类阻塞项。",
  },
  spec_editor: {
    label: "规范编辑",
    description: "聚焦章节完整性、发布时间和运行规则缺失，确保能生成可信快照。",
    emptyActionsText: "当前场景下，规范编辑页没有额外动作。",
    emptyBlockingText: "当前没有规范章节类阻塞项。",
  },
  gate_result: {
    label: "Gate 结果",
    description: "聚焦最近一次裁决结果、是否 stale，以及是否已具备重跑条件。",
    emptyActionsText: "当前场景下，Gate 结果页没有额外动作。",
    emptyBlockingText: "当前没有 Gate 类阻塞项。",
  },
  issue_ledger: {
    label: "问题账本",
    description: "聚焦阻塞问题、外部待确认项和跨角色协作收敛。",
    emptyActionsText: "当前场景下，问题账本页没有额外动作。",
    emptyBlockingText: "当前没有问题账本类阻塞项。",
  },
  snapshot_export: {
    label: "快照与 AI 导出",
    description: "聚焦冻结快照、例外状态和进入编码前的最后导出动作。",
    emptyActionsText: "当前场景下，快照与 AI 导出页没有额外动作。",
    emptyBlockingText: "当前没有快照或例外类阻塞项。",
  },
  evidence_dod: {
    label: "证据与 DoD",
    description: "聚焦完成定义和关键证据，确保不是“能开工、不能收口”。",
    emptyActionsText: "当前场景下，证据与 DoD 页没有额外动作。",
    emptyBlockingText: "当前没有证据类阻塞项。",
  },
};

const role_label_map: Record<string, string> = {
  pm: "产品",
  reviewer: "架构",
  dev: "开发",
  test: "测试",
};

const reason_code_label_map: Record<string, string> = {
  NO_SOURCE_DOCUMENTS: "关键资料未齐",
  SPEC_SECTION_NOT_PUBLISHED: "规范章节未发布",
  LATEST_GATE_FAILED: "最新 Gate 未通过",
  LATEST_GATE_STALE: "最新 Gate 已过期",
  PASSED_WITH_ACTIVE_EXCEPTION: "存在活动例外",
  DOD_BLOCKED: "DoD 仍有阻塞",
  AI_PACKAGE_EXPORTED_DOD_PENDING: "AI 包已导出，但 DoD 待收口",
  AI_PACKAGE_EXPORTED: "AI 包已导出",
  DOD_COMPLETE: "DoD 已完成",
};

const source_type_label_map: Record<string, string> = {
  link: "外部链接",
  apifox: "Apifox",
  file: "文件",
  wiki: "知识库",
};

const section_type_label_map: Record<string, string> = {
  glossary: "术语表",
  api_contract: "接口契约",
  runtime_rules: "运行规则",
  error_codes: "错误码",
  testcases: "测试用例",
  observability: "可观测性",
  examples: "样例与边界",
  scenarios: "场景验证",
  general: "通用要求",
};

const risk_tier_label_map: Record<string, string> = {
  high: "高风险",
  medium: "中风险",
  low: "低风险",
};

const severity_label_map: Record<string, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
};

const blocking_stage_label_map: Record<string, string> = {
  gate: "Gate 阶段",
  dod: "DoD 阶段",
};

const blocking_type_label_map: Record<string, string> = {
  source_document: "来源资料",
  spec_section: "规范章节",
  gate_finding: "Gate 发现项",
  stale_notice: "结果过期提醒",
  issue: "问题账本",
  exception: "活动例外",
  dod_obligation: "DoD 义务",
};

const verification_type_label_map: Record<string, string> = {
  manual: "人工核验",
  observability: "观测验证",
  scenario: "场景验证",
};

const environment_label_map: Record<string, string> = {
  staging: "Staging",
};

const recommended_action_label_map: Record<string, string> = {
  upload_evidence: "补传证据",
  reupload_evidence: "重新上传证据",
  none: "无需动作",
};

const exception_policy_label_map: Record<string, string> = {
  controlled: "可控例外",
  never: "不允许例外",
};

const stage_flow_definitions = [
  { stage: "intake", label: "资料 intake", pageId: "source_documents" },
  { stage: "spec", label: "规范沉淀", pageId: "spec_editor" },
  { stage: "gate", label: "Gate 裁决", pageId: "gate_result" },
  { stage: "ai_ready", label: "AI 导出", pageId: "snapshot_export" },
  { stage: "evidence", label: "证据补齐", pageId: "evidence_dod" },
  { stage: "dod", label: "交付收口", pageId: "evidence_dod" },
] as const satisfies Array<{
  stage: ChannelWorkbenchOverview["currentStage"];
  label: string;
  pageId: ChannelWorkbenchPageId;
}>;

const formatStatus = (value: string) => status_label_map[value] ?? value.replaceAll("_", " ");
const formatStage = (value: string) => stage_label_map[value] ?? value;
const formatRole = (value: string) => role_label_map[value] ?? value;
const formatReasonCode = (value: string) => reason_code_label_map[value] ?? value.replaceAll("_", " ");
const formatSourceType = (value: string) => source_type_label_map[value] ?? value;
const formatSectionType = (value: string) => section_type_label_map[value] ?? value.replaceAll("_", " ");
const formatRiskTier = (value: string) => risk_tier_label_map[value] ?? value;
const formatSeverity = (value: string) => severity_label_map[value] ?? value;
const formatBlockingStage = (value: string) => blocking_stage_label_map[value] ?? value;
const formatBlockingType = (value: string) => blocking_type_label_map[value] ?? value.replaceAll("_", " ");
const formatVerificationType = (value: string) => verification_type_label_map[value] ?? value.replaceAll("_", " ");
const formatEnvironment = (value: string) => environment_label_map[value] ?? value;
const formatRecommendedAction = (value: string) => recommended_action_label_map[value] ?? value.replaceAll("_", " ");
const formatExceptionPolicy = (value: string) => exception_policy_label_map[value] ?? value.replaceAll("_", " ");

const getBannerIcon = (overview: ChannelWorkbenchOverview) => {
  if (overview.codingReadiness === "warning") {
    return ShieldAlert;
  }
  if (overview.statusSummary.canEnterCoding) {
    return CheckCircle2;
  }
  return AlertTriangle;
};

const getMetricClass = (value: string) => metric_style_map[value] ?? "text-foreground";

const getScenarioKey = (value: string | null): ChannelWorkbenchScenarioKey => {
  const matchedScenario = channelWorkbenchScenarioDefinitions.find((item) => item.key === value);
  return matchedScenario?.key ?? "gate_failed";
};

const getScenarioDefinition = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }

  return channelWorkbenchScenarioDefinitions.find((item) => item.key === value) ?? null;
};

const getScenarioLabel = (scenarioKey: ChannelWorkbenchScenarioKey) => {
  const definition = getScenarioDefinition(scenarioKey);
  return definition ? `${definition.id} · ${definition.label}` : scenarioKey;
};

const getActionPageMeta = (pageId: ChannelWorkbenchPageId) => page_copy_map[pageId];

const getPageMetrics = (
  pageId: ChannelWorkbenchPageId,
  overview: ChannelWorkbenchOverview,
): Array<{ label: string; value: string; helper: string }> => {
  switch (pageId) {
    case "source_documents":
      return [
        {
          label: "关键资料覆盖",
          value: `${overview.sourceProgress.criticalCount}/${overview.sourceProgress.totalCount}`,
          helper: "关键 / 总资料数",
        },
        {
          label: "已快照资料",
          value: `${overview.sourceProgress.snapshottedCount}`,
          helper: "已进入冻结链路的资料份数",
        },
        {
          label: "不可访问关键资料",
          value: `${overview.sourceProgress.inaccessibleCriticalCount}`,
          helper: "这些资料必须优先补齐",
        },
      ];
    case "spec_editor":
      return [
        {
          label: "已发布章节",
          value: `${overview.specProgress.publishedSections}/${overview.specProgress.totalSections}`,
          helper: "当前规范包发布进度",
        },
        {
          label: "草稿章节",
          value: `${overview.specProgress.draftSections}`,
          helper: "仍在编辑中的章节数",
        },
        {
          label: "缺失必填章节",
          value: `${overview.specProgress.requiredMissingSections?.length ?? 0}`,
          helper: "未满足最小必填义务",
        },
      ];
    case "gate_result":
      return [
        {
          label: "Gate 摘要",
          value: formatStatus(overview.latestGateSummaryStatus),
          helper: "最近一次裁决结论",
        },
        {
          label: "快照状态",
          value: formatStatus(overview.latestSnapshotStatus),
          helper: overview.currentSnapshot ? overview.currentSnapshot.snapshotId : "暂无冻结快照",
        },
        {
          label: "结果是否过期",
          value: overview.hasStaleGate ? "是" : "否",
          helper: overview.hasStaleGate ? "需重跑 Gate 才能继续" : "当前结果仍可信",
        },
      ];
    case "issue_ledger":
      return [
        {
          label: "阻塞问题",
          value: `${overview.issueProgress.blockingIssueCount}`,
          helper: "直接阻塞主链路的问题数",
        },
        {
          label: "打开问题",
          value: `${overview.issueProgress.openIssueCount}`,
          helper: "仍未关闭的问题总数",
        },
        {
          label: "外部待确认",
          value: `${overview.issueProgress.waitingExternalCount}`,
          helper: "需要渠道或外部方回复的项",
        },
      ];
    case "snapshot_export":
      return [
        {
          label: "当前快照",
          value: overview.currentSnapshot?.snapshotId ?? "未生成",
          helper: overview.currentSnapshot?.ruleVersion ?? "尚未生成规则版本",
        },
        {
          label: "活动例外",
          value: `${overview.activeExceptionCount}`,
          helper: overview.hasActiveException ? "进入编码前需持续关注" : "当前没有活动例外",
        },
        {
          label: "编码就绪",
          value: formatStatus(overview.codingReadiness),
          helper: overview.statusSummary.canEnterCoding ? "允许进入编码" : "仍未满足进入编码条件",
        },
      ];
    case "evidence_dod":
      return [
        {
          label: "DoD 状态",
          value: formatStatus(overview.dodSummaryStatus),
          helper: "完成定义聚合结果",
        },
        {
          label: "关键义务",
          value: `${overview.evidenceProgress.requiredCount}`,
          helper: "当前要求补齐的义务总数",
        },
        {
          label: "仍阻塞义务",
          value: `${overview.evidenceProgress.blockingCount}`,
          helper: "未闭环的关键证据数",
        },
      ];
  }

  return [];
};

const getRelevantBlockingItems = (
  pageId: ChannelWorkbenchPageId,
  overview: ChannelWorkbenchOverview,
): ChannelWorkbenchOverview["topBlockingItems"] => {
  switch (pageId) {
    case "source_documents":
      return overview.topBlockingItems.filter((item) => item.type === "source_document");
    case "spec_editor":
      return overview.topBlockingItems.filter((item) => item.type === "spec_section");
    case "gate_result":
      return overview.topBlockingItems.filter((item) => item.type === "gate_finding" || item.type === "stale_notice");
    case "issue_ledger":
      return overview.topBlockingItems.filter((item) => item.type === "gate_finding" || item.type === "issue");
    case "snapshot_export":
      return overview.hasActiveException
        ? [
            {
              id: "active_exception_summary",
              type: "exception",
              title: `存在 ${overview.activeExceptionCount} 个活动例外`,
              reason: "进入编码前允许继续，但必须在例外到期前收敛。",
              ownerRole: "reviewer",
            },
          ]
        : [];
    case "evidence_dod":
      return overview.topBlockingItems.filter((item) => item.type === "dod_obligation");
  }

  return [];
};

const canExecuteInlineAction = (pageId: ChannelWorkbenchPageId, action: ChannelWorkbenchAction) => {
  if (pageId === "gate_result" && action.actionType === "rerun_gate") {
    return true;
  }

  if (pageId === "snapshot_export" && action.actionType === "export_ai") {
    return true;
  }

  if (pageId === "evidence_dod" && action.actionType === "upload_evidence") {
    return true;
  }

  return false;
};

const readStringDetail = (details: Record<string, unknown> | null | undefined, key: string) =>
  typeof details?.[key] === "string" && details[key].trim().length > 0 ? (details[key] as string) : null;

const readNumberDetail = (details: Record<string, unknown> | null | undefined, key: string) =>
  typeof details?.[key] === "number" ? (details[key] as number) : null;

const getActivityCreatedAt = (event: ActivityEvent) => {
  const value = event.createdAt;
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
};

const getLatestActivityEvent = (events: ActivityEvent[], action: string) => {
  const matchedEvents = events.filter((item) => item.action === action);
  return matchedEvents.length > 0 ? matchedEvents[matchedEvents.length - 1] : null;
};

const getActivityActionMeta = (event: ActivityEvent) => {
  if (event.action === "channel_workbench.gate_rerun_requested") {
    const gateSummaryStatus = readStringDetail(event.details, "gateSummaryStatus");
    return {
      title: gateSummaryStatus === "passed" ? "Gate 已完成重跑" : "Gate 已记录重跑",
      body:
        gateSummaryStatus === "passed"
          ? "最新一次重跑结果已通过，主链路已推进到快照与导出阶段。"
          : "已记录一次新的 Gate 重跑请求，但阻塞项仍待继续收敛。",
      tone: gateSummaryStatus === "passed" ? "ready" : "warning",
    };
  }

  if (event.action === "channel_workbench.ai_package_exported") {
    return {
      title: "AI 包已导出",
      body: "当前冻结快照已生成开发可消费的导出包，主链路重点转向 DoD 收口。",
      tone: "ready",
    };
  }

  if (event.action === "channel_workbench.evidence_uploaded") {
    const remainingBlockingCount = readNumberDetail(event.details, "remainingBlockingCount");
    return {
      title: "关键证据已上传",
      body:
        remainingBlockingCount !== null && remainingBlockingCount > 0
          ? `最近补齐了一项关键证据，仍有 ${remainingBlockingCount} 项 DoD 阻塞待继续处理。`
          : "最近上传已清空关键 DoD 阻塞，当前可以继续收口。",
      tone: remainingBlockingCount !== null && remainingBlockingCount > 0 ? "warning" : "ready",
    };
  }

  return {
    title: event.action,
    body: "该事件已记录到当前 case 的协作轨迹中。",
    tone: "warning",
  };
};

const buildRecoveredRerunGateResult = (
  event: ActivityEvent,
  overview: ChannelWorkbenchOverview,
): ChannelWorkbenchRerunGateResponse | null => {
  const previousScenario = getScenarioDefinition(readStringDetail(event.details, "previousScenario"));
  const currentScenario = getScenarioDefinition(readStringDetail(event.details, "currentScenario"));
  const gateRunId = readStringDetail(event.details, "gateRunId");
  const status = readStringDetail(event.details, "status");
  const gateSummaryStatus = readStringDetail(event.details, "gateSummaryStatus");
  const targetPage = readStringDetail(event.details, "targetPage");

  if (
    !previousScenario ||
    !currentScenario ||
    !gateRunId ||
    (status !== "accepted" && status !== "completed") ||
    (gateSummaryStatus !== "running" && gateSummaryStatus !== "failed" && gateSummaryStatus !== "passed") ||
    !targetPage ||
    !channelWorkbenchPageDefinitions.some((page) => page.id === targetPage)
  ) {
    return null;
  }

  return {
    previousScenario,
    currentScenario,
    caseId: overview.caseId,
    caseTitle: overview.caseTitle,
    gateRunId,
    executedAt: getActivityCreatedAt(event),
    status,
    gateSummaryStatus,
    message:
      gateSummaryStatus === "passed"
        ? "最近一次 Gate 重跑结果已从协作记录恢复，当前可以继续进入快照与导出阶段。"
        : "最近一次 Gate 重跑结果已从协作记录恢复，当前仍需继续收敛阻塞项。",
    targetPage: targetPage as ChannelWorkbenchPageId,
  };
};

const buildRecoveredExportAiResult = (
  event: ActivityEvent,
  overview: ChannelWorkbenchOverview,
): ChannelWorkbenchExportAiResponse | null => {
  const previousScenario = getScenarioDefinition(readStringDetail(event.details, "previousScenario"));
  const currentScenario = getScenarioDefinition(readStringDetail(event.details, "currentScenario"));
  const exportId = readStringDetail(event.details, "exportId");
  const snapshotId = readStringDetail(event.details, "snapshotId");
  const ruleVersion = readStringDetail(event.details, "ruleVersion");
  const status = readStringDetail(event.details, "status");
  const packageStatus = readStringDetail(event.details, "packageStatus");
  const targetPage = readStringDetail(event.details, "targetPage");

  if (
    !previousScenario ||
    !currentScenario ||
    !exportId ||
    !snapshotId ||
    !ruleVersion ||
    (status !== "accepted" && status !== "completed") ||
    (packageStatus !== "queued" && packageStatus !== "exported") ||
    !targetPage ||
    !channelWorkbenchPageDefinitions.some((page) => page.id === targetPage)
  ) {
    return null;
  }

  return {
    previousScenario,
    currentScenario,
    caseId: overview.caseId,
    caseTitle: overview.caseTitle,
    exportId,
    snapshotId,
    ruleVersion,
    executedAt: getActivityCreatedAt(event),
    status,
    packageStatus,
    message: "最近一次 AI 包导出结果已从协作记录恢复，可继续追踪后续证据与 DoD 收口。",
    targetPage: targetPage as ChannelWorkbenchPageId,
  };
};

const buildRecoveredUploadEvidenceResult = (
  event: ActivityEvent,
  overview: ChannelWorkbenchOverview,
): ChannelWorkbenchUploadEvidenceResponse | null => {
  const previousScenario = getScenarioDefinition(readStringDetail(event.details, "previousScenario"));
  const currentScenario = getScenarioDefinition(readStringDetail(event.details, "currentScenario"));
  const evidenceId = readStringDetail(event.details, "evidenceId");
  const obligationId = readStringDetail(event.details, "obligationId");
  const status = readStringDetail(event.details, "status");
  const evidenceStatus = readStringDetail(event.details, "evidenceStatus");
  const dodSummaryStatus = readStringDetail(event.details, "dodSummaryStatus");
  const targetPage = readStringDetail(event.details, "targetPage");
  const completedEvidenceCount = readNumberDetail(event.details, "completedEvidenceCount");
  const remainingBlockingCount = readNumberDetail(event.details, "remainingBlockingCount");

  if (
    !previousScenario ||
    !currentScenario ||
    !evidenceId ||
    !obligationId ||
    (status !== "accepted" && status !== "completed") ||
    (evidenceStatus !== "queued" && evidenceStatus !== "uploaded") ||
    (dodSummaryStatus !== "blocked" && dodSummaryStatus !== "in_progress" && dodSummaryStatus !== "complete") ||
    completedEvidenceCount === null ||
    remainingBlockingCount === null ||
    !targetPage ||
    !channelWorkbenchPageDefinitions.some((page) => page.id === targetPage)
  ) {
    return null;
  }

  return {
    previousScenario,
    currentScenario,
    caseId: overview.caseId,
    caseTitle: overview.caseTitle,
    evidenceId,
    obligationId,
    executedAt: getActivityCreatedAt(event),
    status,
    evidenceStatus,
    completedEvidenceCount,
    remainingBlockingCount,
    dodSummaryStatus,
    message: "最近一次证据上传结果已从协作记录恢复，可继续补齐剩余 DoD 阻塞项。",
    targetPage: targetPage as ChannelWorkbenchPageId,
  };
};

const pickLatestMutationResult = <T extends { executedAt: string }>(current: T | null, recovered: T | null) => {
  if (!current) {
    return recovered;
  }

  if (!recovered) {
    return current;
  }

  return new Date(current.executedAt).getTime() >= new Date(recovered.executedAt).getTime()
    ? current
    : recovered;
};

const ScenarioStateHeader = ({
  requestedScenarioKey,
  effectiveScenario,
}: {
  requestedScenarioKey: ChannelWorkbenchScenarioKey;
  effectiveScenario: Awaited<ReturnType<typeof channelWorkbenchApi.overview>>["scenario"];
}) => {
  const requestedScenarioLabel = getScenarioLabel(requestedScenarioKey);
  const isOverridden = requestedScenarioKey !== effectiveScenario.key;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">状态上下文</span>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">查看场景：{requestedScenarioLabel}</Badge>
        <Badge variant={isOverridden ? "secondary" : "outline"}>
          当前状态：{effectiveScenario.id} · {effectiveScenario.label}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {isOverridden
          ? "当前案例已经被最新协作动作推进，状态展示已自动切换到最新阶段。"
          : "当前页面展示的仍是你所选场景对应的状态视图。"}
      </p>
    </div>
  );
};

const MetricCard = ({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) => {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn("text-lg", getMetricClass(value))}>{formatStatus(value)}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 text-xs text-muted-foreground">{helper}</CardContent>
    </Card>
  );
};

const ProgressCard = ({
  title,
  primary,
  secondary,
  tertiary,
}: {
  title: string;
  primary: string;
  secondary: string;
  tertiary: string;
}) => {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-base">{primary}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 text-xs text-muted-foreground">
        <div>{secondary}</div>
        <div>{tertiary}</div>
      </CardContent>
    </Card>
  );
};

const DetailStatCard = ({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) => {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-base">{value}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 text-xs text-muted-foreground">{helper}</CardContent>
    </Card>
  );
};

const StageFlowCard = ({
  overview,
  nextActions,
  currentPageId = null,
  onOpenPage,
}: {
  overview: ChannelWorkbenchOverview;
  nextActions: ChannelWorkbenchAction[];
  currentPageId?: ChannelWorkbenchPageId | null;
  onOpenPage?: (pageId: ChannelWorkbenchPageId) => void;
}) => {
  const currentStageIndex = stage_flow_definitions.findIndex((item) => item.stage === overview.currentStage);
  const leadAction = nextActions[0] ?? null;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <CardTitle className="text-base">阶段推进</CardTitle>
        <CardDescription>把当前阶段、所在区块和下一棒交接放在一张图里，方便团队沿主链路推进。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          {stage_flow_definitions.map((item, index) => {
            const stageState =
              currentStageIndex === -1
                ? "upcoming"
                : index < currentStageIndex
                  ? "complete"
                  : index === currentStageIndex
                    ? "current"
                    : "upcoming";
            const isCurrentPage = currentPageId === item.pageId;

            return (
              <div
                key={item.stage}
                className={cn(
                  "rounded-lg border px-4 py-4",
                  stageState === "complete"
                    ? "border-emerald-500/30 bg-emerald-50/70 dark:bg-emerald-950/20"
                    : stageState === "current"
                      ? "border-cyan-500/30 bg-cyan-50/70 dark:bg-cyan-950/20"
                      : "border-border bg-card/70",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{item.label}</p>
                  <Badge
                    variant={
                      stageState === "complete"
                        ? "secondary"
                        : stageState === "current"
                          ? "default"
                          : "outline"
                    }
                  >
                    {stageState === "complete" ? "已完成" : stageState === "current" ? "当前阶段" : "待进入"}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  默认区块：{getActionPageMeta(item.pageId).label}
                  {isCurrentPage ? " · 当前正在查看" : ""}
                </p>
                {onOpenPage ? (
                  <Button
                    variant={stageState === "current" ? "secondary" : "outline"}
                    size="sm"
                    className="mt-3 w-full"
                    onClick={() => onOpenPage(item.pageId)}
                  >
                    {isCurrentPage ? "当前区块" : `去 ${getActionPageMeta(item.pageId).label}`}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          <div>
            当前阶段：{formatStage(overview.currentStage)} · 当前就绪：{formatStatus(overview.codingReadiness)}
            {leadAction ? (
              <span>
                {" "}· 下一棒：{formatRole(leadAction.ownerRole)} 去 {getActionPageMeta(leadAction.targetPage).label} 处理
                “{leadAction.title}”
              </span>
            ) : (
              <span> · 当前没有额外跨区块交接，主链路已接近收口。</span>
            )}
          </div>
          {leadAction && onOpenPage ? (
            <div className="mt-3">
              <Button size="sm" onClick={() => onOpenPage(leadAction.targetPage)}>
                打开下一棒区块
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
};

const RoleLaneCard = ({
  lane,
  onOpenPage,
}: {
  lane: ChannelWorkbenchRoleViewResponse["detail"]["lanes"][number];
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
}) => {
  const primaryAction = lane.primaryAction;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-4">
        <CardDescription>{lane.label}</CardDescription>
        <CardTitle className="text-base">{primaryAction?.title ?? "当前无主动作"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4 pb-4 pt-0 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={lane.status === "blocked" ? "destructive" : lane.status === "assist" ? "secondary" : "outline"}>
            {lane.status === "blocked" ? "阻塞中" : lane.status === "assist" ? "协同中" : "空闲"}
          </Badge>
          <span className={getMetricClass(lane.status)}>主视角状态：{formatStatus(lane.status)}</span>
        </div>
        <div>待关注动作：{lane.totalActions}</div>
        <div>阻塞动作：{lane.blockingActions}</div>
        <div>{lane.summary}</div>
        {primaryAction ? (
          <Button variant="outline" size="sm" onClick={() => onOpenPage(primaryAction.targetPage)}>
            去 {getActionPageMeta(primaryAction.targetPage).label}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
};

const ActivityTimelineCard = ({
  events,
}: {
  events: ActivityEvent[];
}) => {
  const visibleEvents = events
    .filter((event) => event.action.startsWith("channel_workbench."))
    .slice(-4)
    .reverse();

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <CardTitle className="text-base">协作轨迹</CardTitle>
        <CardDescription>展示最近几次关键动作，帮助产品、架构、开发、测试同步当前推进位置。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-5 pt-0">
        {visibleEvents.length > 0 ? (
          visibleEvents.map((event) => {
            const meta = getActivityActionMeta(event);

            return (
              <div key={event.id} className="rounded-lg border border-border bg-card/70 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{meta.title}</p>
                  <Badge variant={meta.tone === "ready" ? "secondary" : "outline"}>
                    {meta.tone === "ready" ? "已推进" : "待继续"}
                  </Badge>
                  <Badge variant="outline">{getActivityCreatedAt(event)}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{meta.body}</p>
              </div>
            );
          })
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            当前 case 还没有可展示的协作轨迹，后续推进动作会自动沉淀在这里。
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const PageEntryCard = ({
  pageId,
  scenarioKey,
  active = false,
}: {
  pageId: ChannelWorkbenchPageId;
  scenarioKey: ChannelWorkbenchScenarioKey;
  active?: boolean;
}) => {
  const pageMeta = getActionPageMeta(pageId);

  return (
    <Card className={cn("gap-0 py-0 transition-colors", active ? "border-cyan-500/50 bg-cyan-50/60 dark:bg-cyan-950/20" : undefined)}>
      <CardHeader className="px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{pageMeta.label}</CardTitle>
            <CardDescription className="mt-1">{pageMeta.description}</CardDescription>
          </div>
          <Button asChild variant={active ? "secondary" : "outline"} size="sm">
            <Link to={`/channel-workbench/${pageId}?scenario=${scenarioKey}`}>
              {active ? "当前页" : "打开"}
            </Link>
          </Button>
        </div>
      </CardHeader>
    </Card>
  );
};

const ActionRow = ({
  action,
  onOpenPage,
  onExecuteAction,
  isExecuting = false,
}: {
  action: ChannelWorkbenchAction;
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
  onExecuteAction?: (action: ChannelWorkbenchAction) => void;
  isExecuting?: boolean;
}) => {
  const targetPageMeta = getActionPageMeta(action.targetPage);
  const canExecuteInline = action.ctaType === "mutation" && !!onExecuteAction;
  const handleClick = () => {
    if (canExecuteInline) {
      onExecuteAction(action);
      return;
    }
    onOpenPage(action.targetPage);
  };

  return (
    <div className="rounded-lg border border-border bg-card/70 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{action.title}</p>
            <Badge variant={action.isBlocking ? "destructive" : "outline"}>
              {action.isBlocking ? "主阻塞" : "协同项"}
            </Badge>
            <Badge variant="outline">{formatRole(action.ownerRole)}</Badge>
            <Badge variant="secondary">{targetPageMeta.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{action.reason}</p>
          <p className="mt-2 text-xs text-muted-foreground">完成影响：{action.impact}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            落点页面：{targetPageMeta.label} · {canExecuteInline ? "当前页可直接推进这一步。" : action.ctaType === "mutation" ? "先进入对应区块，再继续处理。" : "可直接跳转到对应工作区。"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge variant="secondary">P{Math.round(action.priority / 10)}</Badge>
          <Button
            variant={canExecuteInline ? "secondary" : action.ctaType === "mutation" ? "secondary" : "outline"}
            size="sm"
            onClick={handleClick}
            disabled={isExecuting}
          >
            {isExecuting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                执行中
              </>
            ) : canExecuteInline ? (
              action.ctaLabel
            ) : action.ctaType === "mutation" ? (
              "进入区块处理"
            ) : (
              action.ctaLabel
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

const BlockingRow = ({
  item,
}: {
  item: ChannelWorkbenchOverview["topBlockingItems"][number];
}) => {
  return (
    <div className="rounded-lg border border-border bg-card/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{item.title}</p>
        <Badge variant="outline">{formatRole(item.ownerRole)}</Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{item.reason}</p>
      <p className="mt-2 text-xs text-muted-foreground">来源：{formatBlockingType(item.type)}</p>
    </div>
  );
};

const RerunGateResultCard = ({
  result,
  onOpenPage,
}: {
  result: ChannelWorkbenchRerunGateResponse;
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
}) => {
  const targetPageMeta = getActionPageMeta(result.targetPage);

  return (
    <Card className="gap-0 border-cyan-500/25 bg-cyan-50/70 py-0 dark:bg-cyan-950/20">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">最近一次 Gate 重跑结果</CardTitle>
              <Badge variant="secondary">{result.status === "completed" ? "已完成" : "已接受"}</Badge>
              <Badge variant="outline">{formatStatus(result.gateSummaryStatus)}</Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">{result.message}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenPage(result.targetPage)}>
            去 {targetPageMeta.label}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-3">
          <span>需求单：{result.caseId}</span>
          <span>Gate Run：{result.gateRunId}</span>
          <span>执行时间：{new Date(result.executedAt).toLocaleString()}</span>
          <span>
            场景流转：{result.previousScenario.label} → {result.currentScenario.label}
          </span>
        </div>
      </CardContent>
    </Card>
  );
};

const ExportAiResultCard = ({
  result,
  onOpenPage,
}: {
  result: ChannelWorkbenchExportAiResponse;
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
}) => {
  const targetPageMeta = getActionPageMeta(result.targetPage);

  return (
    <Card className="gap-0 border-emerald-500/25 bg-emerald-50/70 py-0 dark:bg-emerald-950/20">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">最近一次 AI 包导出结果</CardTitle>
              <Badge variant="secondary">{result.status === "completed" ? "已完成" : "已接受"}</Badge>
              <Badge variant="outline">{result.packageStatus === "exported" ? "已导出" : "排队中"}</Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">{result.message}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenPage(result.targetPage)}>
            去 {targetPageMeta.label}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-3">
          <span>需求单：{result.caseId}</span>
          <span>导出单：{result.exportId}</span>
          <span>快照：{result.snapshotId}</span>
          <span>规则版本：{result.ruleVersion}</span>
          <span>执行时间：{new Date(result.executedAt).toLocaleString()}</span>
        </div>
      </CardContent>
    </Card>
  );
};

const UploadEvidenceResultCard = ({
  result,
  onOpenPage,
}: {
  result: ChannelWorkbenchUploadEvidenceResponse;
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
}) => {
  const targetPageMeta = getActionPageMeta(result.targetPage);

  return (
    <Card className="gap-0 border-amber-500/25 bg-amber-50/70 py-0 dark:bg-amber-950/20">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">最近一次证据上传结果</CardTitle>
              <Badge variant="secondary">{result.status === "completed" ? "已完成" : "已接受"}</Badge>
              <Badge variant="outline">{result.evidenceStatus === "uploaded" ? "已上传" : "排队中"}</Badge>
              <Badge variant="outline">{formatStatus(result.dodSummaryStatus)}</Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">{result.message}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => onOpenPage(result.targetPage)}>
            去 {targetPageMeta.label}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-3">
          <span>需求单：{result.caseId}</span>
          <span>证据：{result.evidenceId}</span>
          <span>义务：{result.obligationId}</span>
          <span>已完成义务：{result.completedEvidenceCount}</span>
          <span>剩余阻塞：{result.remainingBlockingCount}</span>
          <span>执行时间：{new Date(result.executedAt).toLocaleString()}</span>
        </div>
      </CardContent>
    </Card>
  );
};

const SourceDocumentsDetailPanel = ({
  payload,
}: {
  payload: ChannelWorkbenchSourceDocumentsResponse;
}) => {
  const detail = payload.detail;
  const summaryText =
    detail.totalCount === 0
      ? "当前还没有纳入任何来源资料，主链路起点仍未建立。"
      : detail.inaccessibleCriticalCount > 0
        ? `当前有 ${detail.inaccessibleCriticalCount} 份关键资料不可访问，优先恢复输入可信度。`
        : detail.snapshottedCount < detail.criticalCount
          ? "关键资料已到位，但仍需继续补齐冻结链路。"
          : "来源资料已基本稳定，可继续推进规范沉淀。";

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <CardTitle className="text-base">来源资料清单</CardTitle>
        <CardDescription>{summaryText}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-5">
        <DetailStatCard label="资料总数" value={`${detail.totalCount}`} helper="当前已纳入工作台的来源资料数" />
        <DetailStatCard label="关键资料" value={`${detail.criticalCount}`} helper="会直接影响裁决可信度的资料数" />
        <DetailStatCard label="已快照" value={`${detail.snapshottedCount}`} helper="已进入冻结链路的资料数" />
        <DetailStatCard label="不可访问关键" value={`${detail.inaccessibleCriticalCount}`} helper="需要优先补齐的缺口" />
        <DetailStatCard
          label="下一棒角色"
          value={detail.nextOwnerRole ? formatRole(detail.nextOwnerRole) : "未指定"}
          helper={detail.nextStep}
        />
      </CardContent>
      <CardContent className="space-y-3 px-5 pb-5 pt-0">
        {detail.items.length > 0 ? (
          detail.items.map((item) => (
            <div key={item.sourceId} className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">{item.sourceTitle}</p>
                <Badge variant={item.isCritical ? "destructive" : "outline"}>
                  {item.isCritical ? "关键" : "非关键"}
                </Badge>
                <Badge variant="outline">{formatSourceType(item.sourceType)}</Badge>
                <Badge variant="outline">{formatStatus(item.snapshotStatus)}</Badge>
                <Badge variant="outline">{formatStatus(item.availabilityStatus)}</Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">负责人：{item.ownerName}</p>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            当前没有来源资料，主链路需要先补齐关键资料。
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const SpecEditorDetailPanel = ({
  payload,
}: {
  payload: ChannelWorkbenchSpecEditorResponse;
}) => {
  const detail = payload.detail;
  const summaryText =
    detail.errorSections > 0
      ? `当前有 ${detail.errorSections} 个章节需要修复，必须先处理后再进入快照或 Gate。`
      : detail.draftSections > 0
        ? `当前仍有 ${detail.draftSections} 个草稿章节待发布。`
        : detail.warnSections > 0
          ? `当前仍有 ${detail.warnSections} 个章节待完善，建议收敛后再裁决。`
          : "规范章节已基本稳定，可继续进入快照或 Gate。";

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <CardTitle className="text-base">规范包摘要</CardTitle>
        <CardDescription>{summaryText}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-6">
        <DetailStatCard label="模板版本" value={detail.templateVersion} helper={`风险等级 ${formatRiskTier(detail.riskTier)}`} />
        <DetailStatCard label="已发布章节" value={`${detail.publishedSections}/${detail.totalSections}`} helper="章节发布进度" />
        <DetailStatCard label="草稿章节" value={`${detail.draftSections}`} helper="仍在编辑中的章节数" />
        <DetailStatCard label="需修复章节" value={`${detail.errorSections}`} helper="当前存在明显缺口的章节数" />
        <DetailStatCard label="待完善章节" value={`${detail.warnSections}`} helper="建议继续补齐的章节数" />
        <DetailStatCard
          label="下一棒角色"
          value={detail.nextOwnerRole ? formatRole(detail.nextOwnerRole) : "未指定"}
          helper={detail.nextStep}
        />
      </CardContent>
      <CardContent className="space-y-3 px-5 pb-5 pt-0">
        {detail.items.map((item) => (
          <div key={item.sectionId} className="rounded-lg border border-border bg-card/70 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{item.title}</p>
              <Badge variant="outline">{formatSectionType(item.sectionType)}</Badge>
              <Badge variant={item.lintStatus === "error" ? "destructive" : "outline"}>{formatStatus(item.lintStatus)}</Badge>
              <Badge variant="outline">{formatStatus(item.status)}</Badge>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              必填进度：{item.completedFields}/{item.totalFields} · 最近发布时间：
              {item.lastPublishedAt ? new Date(item.lastPublishedAt).toLocaleString() : "未发布"}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
};

const GateResultDetailPanel = ({
  payload,
}: {
  payload: ChannelWorkbenchGateResultResponse;
}) => {
  const detail = payload.detail;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Gate 运行详情</CardTitle>
              <Badge variant={detail.summaryStatus === "passed" ? "secondary" : "outline"}>
                {formatStatus(detail.summaryStatus)}
              </Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">
              {detail.staleReason ?? `当前 Gate 运行关联 ${detail.linkedIssueCount} 个问题，命中发现项 ${detail.findings.length} 条。`}
            </CardDescription>
            <p className="text-xs text-muted-foreground">{detail.nextStep}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-5">
        <DetailStatCard label="Gate Run" value={detail.gateRunId} helper={detail.snapshotId ?? "无快照"} />
        <DetailStatCard label="规则版本" value={detail.ruleVersion ?? "未知"} helper="裁决使用的规则版本" />
        <DetailStatCard label="关联问题" value={`${detail.linkedIssueCount}`} helper="当前 Gate 直接关联的问题数" />
        <DetailStatCard label="发现项" value={`${detail.findings.length}`} helper="当前命中的裁决发现项数量" />
        <DetailStatCard
          label="下一棒角色"
          value={detail.nextOwnerRole ? formatRole(detail.nextOwnerRole) : "未指定"}
          helper={detail.nextStep}
        />
      </CardContent>
      {detail.findings.length > 0 ? (
        <CardContent className="space-y-3 px-5 pb-5 pt-0">
          {detail.findings.map((finding) => (
            <div key={finding.findingId} className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">{finding.title}</p>
                <Badge variant="outline">{finding.ruleId}</Badge>
                <Badge variant="outline">{finding.gateStage}</Badge>
                <Badge variant={finding.severity === "critical" ? "destructive" : "outline"}>{formatSeverity(finding.severity)}</Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {finding.reason} · 责任角色：{formatRole(finding.ownerRole)} · 例外策略：{formatExceptionPolicy(finding.allowException)}
              </p>
            </div>
          ))}
        </CardContent>
      ) : null}
    </Card>
  );
};

const IssueLedgerDetailPanel = ({
  payload,
}: {
  payload: ChannelWorkbenchIssueLedgerResponse;
}) => {
  const detail = payload.detail;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">问题账本聚合</CardTitle>
              <Badge variant={detail.waitingExternalOnly ? "secondary" : "outline"}>
                {detail.waitingExternalOnly ? "仅外部待确认" : "含阻塞问题"}
              </Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">
              当前打开问题 {detail.openCount} 个，其中阻塞问题 {detail.blockingCount} 个。
            </CardDescription>
            <p className="text-xs text-muted-foreground">{detail.nextStep}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-4">
        <DetailStatCard label="打开问题" value={`${detail.openCount}`} helper="账本中未关闭的问题总数" />
        <DetailStatCard label="阻塞问题" value={`${detail.blockingCount}`} helper="直接卡主链路的问题数" />
        <DetailStatCard
          label="外部待确认"
          value={detail.waitingExternalOnly ? "是" : "否"}
          helper="是否处于等待外部确认的窄场景"
        />
        <DetailStatCard
          label="下一棒角色"
          value={detail.nextOwnerRole ? formatRole(detail.nextOwnerRole) : "未指定"}
          helper={detail.nextStep}
        />
      </CardContent>
      <CardContent className="space-y-3 px-5 pb-5 pt-0">
        {detail.items.length > 0 ? (
          detail.items.map((item) => (
            <div key={item.issueId} className="rounded-lg border border-border bg-card/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">{item.title}</p>
                <Badge variant="outline">{formatSeverity(item.severity)}</Badge>
                <Badge variant="outline">{formatStatus(item.status)}</Badge>
                <Badge variant="outline">{formatBlockingStage(item.blockingStage)}</Badge>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                负责人：{item.ownerName} · 截止时间：{item.dueAt ? new Date(item.dueAt).toLocaleString() : "未设置"} · 关联规则：{item.sourceRuleId ?? "无"}
              </p>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            当前聚合结果下没有额外问题项。
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const SnapshotExportDetailPanel = ({
  payload,
}: {
  payload: ChannelWorkbenchSnapshotExportResponse;
}) => {
  const detail = payload.detail;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">快照与导出状态</CardTitle>
              <Badge variant={detail.packageStatus === "exported" ? "secondary" : "outline"}>
                {detail.packageStatus === "exported"
                  ? "已导出"
                  : detail.packageStatus === "queued"
                    ? "导出排队中"
                    : "尚未导出"}
              </Badge>
              <Badge variant="outline">{formatStatus(detail.latestGateSummaryStatus)}</Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">{detail.notice}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-5">
        <DetailStatCard
          label="冻结快照"
          value={detail.snapshotId ?? "未生成"}
          helper={detail.ruleVersion ?? "尚未生成规则版本"}
        />
        <DetailStatCard
          label="活动例外"
          value={`${detail.activeExceptionCount}`}
          helper={detail.hasActiveException ? "需要持续跟踪到期前处理" : "当前没有活动例外"}
        />
        <DetailStatCard
          label="导出状态"
          value={
            detail.packageStatus === "exported"
              ? "已导出"
              : detail.packageStatus === "queued"
                ? "排队中"
                : "待导出"
          }
          helper={detail.latestExport ? detail.latestExport.exportId : "尚无导出记录"}
        />
          <DetailStatCard
            label="冻结时间"
            value={detail.frozenAt ? new Date(detail.frozenAt).toLocaleString() : "未冻结"}
            helper="冻结时间越新，导出可信度越高"
          />
        <DetailStatCard
          label="下一棒角色"
          value={detail.nextOwnerRole ? formatRole(detail.nextOwnerRole) : "未指定"}
          helper={detail.nextStep}
        />
      </CardContent>
      {detail.latestExport ? (
        <CardContent className="px-5 pb-5 pt-0 text-xs text-muted-foreground">
          最近导出：{detail.latestExport.exportId} · 快照 {detail.latestExport.snapshotId} ·
          {new Date(detail.latestExport.exportedAt).toLocaleString()}
        </CardContent>
      ) : null}
    </Card>
  );
};

const EvidenceDodDetailPanel = ({
  payload,
}: {
  payload: ChannelWorkbenchEvidenceDodResponse;
}) => {
  const detail = payload.detail;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">DoD 聚合</CardTitle>
              <Badge variant={detail.summaryStatus === "complete" ? "secondary" : "outline"}>
                {formatStatus(detail.summaryStatus)}
              </Badge>
            </div>
            <CardDescription className="text-sm text-foreground/80">
              当前快照下共有 {detail.requiredObligationCount} 项关键义务，已完成 {detail.completedObligationCount} 项，仍阻塞 {detail.blockingCount} 项。
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-5">
        <DetailStatCard
          label="当前快照"
          value={detail.snapshotId ?? "未生成"}
          helper="DoD 校验绑定的冻结快照"
        />
        <DetailStatCard
          label="必需义务"
          value={`${detail.requiredObligationCount}`}
          helper="当前纳入统计的关键义务数"
        />
        <DetailStatCard
          label="已完成"
          value={`${detail.completedObligationCount}`}
          helper="已具备有效证据的义务数"
        />
        <DetailStatCard
          label="仍阻塞"
          value={`${detail.blockingCount}`}
          helper={detail.latestUpload ? `最近上传 ${detail.latestUpload.evidenceId}` : "尚无最近上传记录"}
        />
        <DetailStatCard
          label="下一棒角色"
          value={detail.nextOwnerRole ? formatRole(detail.nextOwnerRole) : "未指定"}
          helper={detail.nextStep}
        />
      </CardContent>
      <CardContent className="space-y-3 px-5 pb-5 pt-0">
        {detail.items.map((item) => (
          <div key={item.obligationId} className="rounded-lg border border-border bg-card/70 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{item.obligationTitle}</p>
              <Badge variant={item.status === "complete" ? "secondary" : "outline"}>
                {item.status === "missing" ? "缺失" : item.status === "expired" ? "已过期" : "已完成"}
              </Badge>
              <Badge variant="outline">{formatEnvironment(item.environment)}</Badge>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              来源章节：{formatSectionType(item.sourceSection)} · 校验类型：{formatVerificationType(item.verificationType)} · 建议动作：{formatRecommendedAction(item.recommendedAction)}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
};

const SectionOverview = ({
  overview,
  roleViewPayload,
  nextActions,
  channelCaseActivity,
  onOpenPage,
  scenarioKey,
}: {
  overview: ChannelWorkbenchOverview;
  roleViewPayload: ChannelWorkbenchRoleViewResponse | null;
  nextActions: ChannelWorkbenchAction[];
  channelCaseActivity: ActivityEvent[];
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
  scenarioKey: ChannelWorkbenchScenarioKey;
}) => {
  const visibleNextActions = nextActions.slice(0, 3);
  const bannerIcon = getBannerIcon(overview);
  const BannerIcon = bannerIcon;
  const roleLanes = roleViewPayload?.detail.lanes ?? [];

  return (
    <>
      <Card className={cn("gap-0 border py-0", banner_style_map[overview.codingReadiness] ?? banner_style_map.blocked)}>
        <CardHeader className="px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-background/80 p-2">
              <BannerIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{overview.caseTitle}</CardTitle>
                <Badge variant="outline">{overview.channelName}</Badge>
                <Badge variant="outline">{formatStage(overview.currentStage)}</Badge>
              </div>
              <CardDescription className="mt-2 text-sm text-foreground/80">
                {overview.statusSummary.summaryText}
              </CardDescription>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>需求单：{overview.caseId}</span>
                <span>当前判断：{formatReasonCode(overview.statusSummary.reasonCode)}</span>
                <span>快照：{overview.currentSnapshot?.snapshotId ?? "无"}</span>
                <span>规则版本：{overview.currentSnapshot?.ruleVersion ?? "未生成"}</span>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="编码就绪"
          value={overview.codingReadiness}
          helper={overview.statusSummary.canEnterCoding ? "当前允许进入编码阶段" : "当前仍有阻塞条件"}
        />
        <MetricCard
          label="Gate 状态"
          value={overview.latestGateSummaryStatus}
          helper={overview.hasStaleGate ? "当前结果已过期，需要重跑" : "当前结论仍可作为推进依据"}
        />
        <MetricCard
          label="快照状态"
          value={overview.latestSnapshotStatus}
          helper={overview.currentSnapshot ? `快照 ${overview.currentSnapshot.snapshotId}` : "尚无冻结快照"}
        />
        <MetricCard
          label="DoD 状态"
          value={overview.dodSummaryStatus}
          helper={`阻塞项 ${overview.evidenceProgress.blockingCount} 个`}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ProgressCard
          title="来源资料"
          primary={`${overview.sourceProgress.totalCount} 份资料 / ${overview.sourceProgress.criticalCount} 份关键`}
          secondary={`已快照 ${overview.sourceProgress.snapshottedCount} 份`}
          tertiary={`不可访问关键资料 ${overview.sourceProgress.inaccessibleCriticalCount} 份`}
        />
        <ProgressCard
          title="规范包"
          primary={`${overview.specProgress.publishedSections}/${overview.specProgress.totalSections} 已发布`}
          secondary={`草稿章节 ${overview.specProgress.draftSections} 个`}
          tertiary={
            overview.specProgress.requiredMissingSections?.length
              ? `缺失章节：${overview.specProgress.requiredMissingSections.join(" / ")}`
              : "当前无缺失章节"
          }
        />
        <ProgressCard
          title="问题账本"
          primary={`阻塞问题 ${overview.issueProgress.blockingIssueCount} 个`}
          secondary={`打开问题 ${overview.issueProgress.openIssueCount} 个`}
          tertiary={`外部待确认 ${overview.issueProgress.waitingExternalCount} 个`}
        />
        <ProgressCard
          title="证据与 DoD"
          primary={`关键义务 ${overview.evidenceProgress.requiredCount} 项`}
          secondary={`已完成 ${overview.evidenceProgress.completedCount} 项`}
          tertiary={`仍阻塞 ${overview.evidenceProgress.blockingCount} 项`}
        />
      </div>

      <StageFlowCard overview={overview} nextActions={nextActions} onOpenPage={onOpenPage} />

      <Card className="gap-0 py-0">
        <CardHeader className="px-5 py-5">
          <CardTitle className="text-base">工作导航</CardTitle>
          <CardDescription>按资料、规范、裁决、问题、导出、收口 6 个区块组织协作，让不同角色都能快速进入自己的工作面。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-3">
          {channelWorkbenchPageDefinitions.map((page) => (
            <PageEntryCard key={page.id} pageId={page.id} scenarioKey={scenarioKey} />
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="gap-0 py-0">
          <CardHeader className="px-5 py-5">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
              <CardTitle>优先动作</CardTitle>
            </div>
            <CardDescription>首屏只保留当前最值得优先处理的 3 条动作，帮助团队快速对齐。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 pt-0">
            {visibleNextActions.map((action) => (
              <ActionRow key={action.actionId} action={action} onOpenPage={onOpenPage} />
            ))}
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="px-5 py-5">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
              <CardTitle>阻塞摘要</CardTitle>
            </div>
            <CardDescription>集中回答“为什么现在还不能继续”，方便快速定位卡点。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 pt-0">
            {overview.topBlockingItems.length > 0 ? (
              overview.topBlockingItems.map((item) => (
                <BlockingRow key={item.id} item={item} />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                当前场景没有额外阻塞摘要，主链路重点转为持续推进与收口。
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="gap-0 py-0">
          <CardHeader className="px-5 py-5">
            <CardTitle className="text-base">角色视角</CardTitle>
            <CardDescription>统一看到产品、架构、开发、测试各自最该处理的事情，减少来回切换成本。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-4">
            {roleLanes.length > 0 ? (
              roleLanes.map((lane) => (
                <RoleLaneCard key={lane.role} lane={lane} onOpenPage={onOpenPage} />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground md:col-span-2 xl:col-span-4">
                当前还没有可展示的角色动作，随着后续推进会自动补全。
              </div>
            )}
          </CardContent>
        </Card>

        <ActivityTimelineCard events={channelCaseActivity} />
      </div>

    </>
  );
};

const SectionDetail = ({
  pageId,
  overview,
  nextActions,
  channelCaseActivity,
  onOpenPage,
  onExecuteAction,
  executingActionType = null,
  latestRerunGateResult,
  latestExportAiResult,
  latestUploadEvidenceResult,
  sourceDocumentsPayload,
  specEditorPayload,
  gateResultPayload,
  issueLedgerPayload,
  snapshotExportPayload,
  evidenceDodPayload,
  scenarioKey,
}: {
  pageId: ChannelWorkbenchPageId;
  overview: ChannelWorkbenchOverview;
  nextActions: ChannelWorkbenchAction[];
  channelCaseActivity: ActivityEvent[];
  onOpenPage: (pageId: ChannelWorkbenchPageId) => void;
  onExecuteAction: (action: ChannelWorkbenchAction) => void;
  executingActionType?: string | null;
  latestRerunGateResult: ChannelWorkbenchRerunGateResponse | null;
  latestExportAiResult: ChannelWorkbenchExportAiResponse | null;
  latestUploadEvidenceResult: ChannelWorkbenchUploadEvidenceResponse | null;
  sourceDocumentsPayload: ChannelWorkbenchSourceDocumentsResponse | null;
  specEditorPayload: ChannelWorkbenchSpecEditorResponse | null;
  gateResultPayload: ChannelWorkbenchGateResultResponse | null;
  issueLedgerPayload: ChannelWorkbenchIssueLedgerResponse | null;
  snapshotExportPayload: ChannelWorkbenchSnapshotExportResponse | null;
  evidenceDodPayload: ChannelWorkbenchEvidenceDodResponse | null;
  scenarioKey: ChannelWorkbenchScenarioKey;
}) => {
  const pageMeta = getActionPageMeta(pageId);
  const pageMetrics = getPageMetrics(pageId, overview);
  const pageActions = nextActions.filter((action) => action.targetPage === pageId);
  const pageBlockingItems = getRelevantBlockingItems(pageId, overview);
  const pagePrimaryAction = pageActions[0] ?? null;
  const pagePrimaryOwner = pagePrimaryAction?.ownerRole ?? pageBlockingItems[0]?.ownerRole ?? null;
  const nextHandoffAction = nextActions.find((action) => action.targetPage !== pageId) ?? null;
  const canExecutePrimaryInline = pagePrimaryAction ? canExecuteInlineAction(pageId, pagePrimaryAction) : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-3">
          <Button asChild variant="ghost" size="sm" className="w-fit px-0 text-muted-foreground hover:text-foreground">
            <Link to={`/channel-workbench?scenario=${scenarioKey}`}>
              <ArrowLeft className="h-4 w-4" />
              返回总览
            </Link>
          </Button>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold">{pageMeta.label}</h2>
              <Badge variant="outline">{overview.caseTitle}</Badge>
              <Badge variant="outline">{overview.channelName}</Badge>
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">{pageMeta.description}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {pageMetrics.map((metric) => (
          <DetailStatCard key={metric.label} label={metric.label} value={metric.value} helper={metric.helper} />
        ))}
      </div>

      <StageFlowCard
        overview={overview}
        nextActions={nextActions}
        currentPageId={pageId}
        onOpenPage={onOpenPage}
      />

      <Card className="gap-0 py-0">
        <CardHeader className="px-5 py-5">
          <CardTitle className="text-base">协作分工</CardTitle>
          <CardDescription>明确当前谁先处理、这一步做什么，以及做完后交给谁。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-3">
          <DetailStatCard
            label="当前 owner"
            value={pagePrimaryOwner ? formatRole(pagePrimaryOwner) : "未指定"}
            helper={pagePrimaryOwner ? "当前区块最先需要响应的角色" : "当前区块暂无明确责任角色"}
          />
          <DetailStatCard
            label="当前主动作"
            value={pagePrimaryAction?.title ?? "无主动作"}
            helper={pagePrimaryAction?.reason ?? "当前区块没有独立动作，更多是承接上游结果。"}
          />
          <DetailStatCard
            label="下一棒"
            value={nextHandoffAction ? formatRole(nextHandoffAction.ownerRole) : "当前区块即可收口"}
            helper={
              nextHandoffAction
                ? `${nextHandoffAction.title} · ${getActionPageMeta(nextHandoffAction.targetPage).label}`
                : "当前没有额外跨区块交接。"
            }
          />
        </CardContent>
        {pagePrimaryAction || nextHandoffAction ? (
          <CardContent className="flex flex-wrap gap-2 px-5 pb-5 pt-0">
            {pagePrimaryAction ? (
              <Button
                variant={canExecutePrimaryInline ? "secondary" : "outline"}
                size="sm"
                onClick={() => (canExecutePrimaryInline ? onExecuteAction(pagePrimaryAction) : onOpenPage(pagePrimaryAction.targetPage))}
                disabled={canExecutePrimaryInline && executingActionType === pagePrimaryAction.actionType}
              >
                {canExecutePrimaryInline
                  ? executingActionType === pagePrimaryAction.actionType
                    ? "处理中"
                    : pagePrimaryAction.ctaLabel
                  : "聚焦当前主动作"}
              </Button>
            ) : null}
            {nextHandoffAction ? (
              <Button variant="ghost" size="sm" onClick={() => onOpenPage(nextHandoffAction.targetPage)}>
                交给下一棒
              </Button>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      {pageId === "source_documents" && sourceDocumentsPayload ? (
        <SourceDocumentsDetailPanel payload={sourceDocumentsPayload} />
      ) : null}

      {pageId === "spec_editor" && specEditorPayload ? (
        <SpecEditorDetailPanel payload={specEditorPayload} />
      ) : null}

      {pageId === "gate_result" &&
      latestRerunGateResult &&
      (latestRerunGateResult.currentScenario.key === scenarioKey ||
        latestRerunGateResult.previousScenario.key === scenarioKey) ? (
        <RerunGateResultCard result={latestRerunGateResult} onOpenPage={onOpenPage} />
      ) : null}

      {pageId === "gate_result" && gateResultPayload ? (
        <GateResultDetailPanel payload={gateResultPayload} />
      ) : null}

      {pageId === "issue_ledger" && issueLedgerPayload ? (
        <IssueLedgerDetailPanel payload={issueLedgerPayload} />
      ) : null}

      {pageId === "snapshot_export" &&
      latestExportAiResult &&
      (latestExportAiResult.currentScenario.key === scenarioKey ||
        latestExportAiResult.previousScenario.key === scenarioKey) ? (
        <ExportAiResultCard result={latestExportAiResult} onOpenPage={onOpenPage} />
      ) : null}

      {pageId === "snapshot_export" && snapshotExportPayload ? (
        <SnapshotExportDetailPanel payload={snapshotExportPayload} />
      ) : null}

      {pageId === "evidence_dod" &&
      latestUploadEvidenceResult &&
      (latestUploadEvidenceResult.currentScenario.key === scenarioKey ||
        latestUploadEvidenceResult.previousScenario.key === scenarioKey) ? (
        <UploadEvidenceResultCard result={latestUploadEvidenceResult} onOpenPage={onOpenPage} />
      ) : null}

      {pageId === "evidence_dod" && evidenceDodPayload ? (
        <EvidenceDodDetailPanel payload={evidenceDodPayload} />
      ) : null}

      <Card className="gap-0 py-0">
        <CardHeader className="px-5 py-5">
          <CardTitle className="text-base">区块导航</CardTitle>
          <CardDescription>继续沿着主链路切换区块，保持当前场景不丢失。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-3">
          {channelWorkbenchPageDefinitions.map((page) => (
            <PageEntryCard key={page.id} pageId={page.id} scenarioKey={scenarioKey} active={page.id === pageId} />
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="gap-0 py-0">
          <CardHeader className="px-5 py-5">
            <CardTitle>本区块优先动作</CardTitle>
            <CardDescription>只保留当前区块最值得立即处理的动作，方便直接开工。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 pt-0">
            {pageActions.length > 0 ? (
              pageActions.map((action) => (
                <ActionRow
                  key={action.actionId}
                  action={action}
                  onOpenPage={onOpenPage}
                  onExecuteAction={canExecuteInlineAction(pageId, action) ? onExecuteAction : undefined}
                  isExecuting={executingActionType === action.actionType}
                />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                {pageMeta.emptyActionsText}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="gap-0 py-0">
            <CardHeader className="px-5 py-5">
              <CardTitle>相关阻塞摘要</CardTitle>
              <CardDescription>只看与当前区块直接相关的卡点，方便就地解决。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-5 pb-5 pt-0">
              {pageBlockingItems.length > 0 ? (
                pageBlockingItems.map((item) => <BlockingRow key={item.id} item={item} />)
              ) : (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  {pageMeta.emptyBlockingText}
                </div>
              )}
            </CardContent>
          </Card>

          <ActivityTimelineCard events={channelCaseActivity} />
        </div>
      </div>

    </div>
  );
};

export const ChannelWorkbench = () => {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompany, selectedCompanyId, companies } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pageId: routePageId } = useParams<{ pageId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [latestRerunGateResult, setLatestRerunGateResult] = useState<ChannelWorkbenchRerunGateResponse | null>(null);
  const [latestExportAiResult, setLatestExportAiResult] = useState<ChannelWorkbenchExportAiResponse | null>(null);
  const [latestUploadEvidenceResult, setLatestUploadEvidenceResult] = useState<ChannelWorkbenchUploadEvidenceResponse | null>(null);

  const pageId = useMemo(() => {
    const matchedPage = channelWorkbenchPageDefinitions.find((item) => item.id === routePageId);
    return matchedPage?.id ?? null;
  }, [routePageId]);
  const scenarioKey = useMemo(
    () => getScenarioKey(searchParams.get("scenario")),
    [searchParams],
  );

  useEffect(() => {
    if (pageId) {
      setBreadcrumbs([
        { label: "渠道需求工作台", href: "/channel-workbench" },
        { label: getActionPageMeta(pageId).label },
      ]);
      return;
    }

    if (routePageId) {
      setBreadcrumbs([
        { label: "渠道需求工作台", href: "/channel-workbench" },
        { label: "未知页面" },
      ]);
      return;
    }

    setBreadcrumbs([{ label: "渠道需求工作台" }]);
  }, [pageId, routePageId, setBreadcrumbs]);

  const handleScenarioChange = (value: string) => {
    const matchedScenario = channelWorkbenchScenarioDefinitions.find((item) => item.key === value);
    if (!matchedScenario) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("scenario", matchedScenario.key);
    setSearchParams(nextSearchParams, { replace: true });
  };

  const handleOpenPage = (targetPage: ChannelWorkbenchPageId) => {
    navigate(`/channel-workbench/${targetPage}?scenario=${scenarioKey}`);
  };

  const rerunGateMutation = useMutation({
    mutationFn: () => channelWorkbenchApi.rerunGate(selectedCompanyId!, scenarioKey),
    onSuccess: async (result) => {
      setLatestRerunGateResult(result);

      const queryKeysToRefresh: Array<readonly unknown[]> = [
        queryKeys.channelWorkbench.overview(selectedCompanyId!, scenarioKey),
        queryKeys.channelWorkbench.nextActions(selectedCompanyId!, scenarioKey),
        queryKeys.channelWorkbench.gateResult(selectedCompanyId!, scenarioKey),
      ];

      if (result.currentScenario.key !== scenarioKey) {
        queryKeysToRefresh.push(
          queryKeys.channelWorkbench.overview(selectedCompanyId!, result.currentScenario.key),
          queryKeys.channelWorkbench.nextActions(selectedCompanyId!, result.currentScenario.key),
          queryKeys.channelWorkbench.gateResult(selectedCompanyId!, result.currentScenario.key),
          queryKeys.channelWorkbench.roleView(selectedCompanyId!, result.currentScenario.key),
          queryKeys.channelWorkbench.snapshotExport(selectedCompanyId!, result.currentScenario.key),
        );
      }

      await Promise.all(
        [
          ...queryKeysToRefresh,
          queryKeys.channelWorkbench.activity(selectedCompanyId!, result.caseId),
          queryKeys.channelWorkbench.roleView(selectedCompanyId!, scenarioKey),
          queryKeys.channelWorkbench.snapshotExport(selectedCompanyId!, scenarioKey),
        ].map((key) => queryClient.invalidateQueries({ queryKey: key })),
      );

      if (result.currentScenario.key !== scenarioKey) {
        const nextSearchParams = new URLSearchParams(searchParams);
        nextSearchParams.set("scenario", result.currentScenario.key);
        setSearchParams(nextSearchParams, { replace: true });
      }

      pushToast({
        title: result.status === "completed" ? "Gate 已重跑完成" : "Gate 重跑请求已接受",
        body: result.message,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Gate 重跑失败",
        body: error instanceof Error ? error.message : "渠道需求工作台暂时无法发起 Gate 重跑。",
        tone: "error",
      });
    },
  });

  const exportAiMutation = useMutation({
    mutationFn: () => channelWorkbenchApi.exportAi(selectedCompanyId!, scenarioKey),
    onSuccess: async (result) => {
      setLatestExportAiResult(result);

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.overview(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.nextActions(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.snapshotExport(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.roleView(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.evidenceDod(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.issueLedger(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.activity(selectedCompanyId!, result.caseId),
        }),
      ]);

      pushToast({
        title: result.status === "completed" ? "AI 包已导出" : "AI 包导出已受理",
        body: result.message,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "AI 包导出失败",
        body: error instanceof Error ? error.message : "渠道需求工作台暂时无法导出 AI 包。",
        tone: "error",
      });
    },
  });

  const uploadEvidenceMutation = useMutation({
    mutationFn: () => channelWorkbenchApi.uploadEvidence(selectedCompanyId!, scenarioKey),
    onSuccess: async (result) => {
      setLatestUploadEvidenceResult(result);

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.overview(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.nextActions(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.evidenceDod(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.roleView(selectedCompanyId!, scenarioKey),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.channelWorkbench.activity(selectedCompanyId!, result.caseId),
        }),
      ]);

      pushToast({
        title: result.status === "completed" ? "证据已上传" : "证据上传已受理",
        body: result.message,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "证据上传失败",
        body: error instanceof Error ? error.message : "渠道需求工作台暂时无法上传证据。",
        tone: "error",
      });
    },
  });

  const handleExecuteAction = (action: ChannelWorkbenchAction) => {
    if (action.actionType === "rerun_gate") {
      rerunGateMutation.mutate();
      return;
    }

    if (action.actionType === "export_ai") {
      exportAiMutation.mutate();
      return;
    }

    if (action.actionType === "upload_evidence") {
      uploadEvidenceMutation.mutate();
      return;
    }

    handleOpenPage(action.targetPage);
  };

  const executingActionType = rerunGateMutation.isPending
    ? "rerun_gate"
    : exportAiMutation.isPending
      ? "export_ai"
      : uploadEvidenceMutation.isPending
        ? "upload_evidence"
        : null;

  const overviewQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.overview(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.overview(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId,
  });

  const nextActionsQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.nextActions(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.nextActions(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId,
  });

  const roleViewQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.roleView(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.roleView(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && !pageId,
  });

  const activityQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.activity(
      selectedCompanyId ?? "__none__",
      overviewQuery.data?.overview.caseId ?? "__none__",
    ),
    queryFn: () =>
      activityApi.list(selectedCompanyId!, {
        entityType: "channel_case",
        entityId: overviewQuery.data!.overview.caseId,
      }),
    enabled: !!selectedCompanyId && !!overviewQuery.data?.overview.caseId,
  });

  const snapshotExportQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.snapshotExport(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.snapshotExport(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && pageId === "snapshot_export",
  });

  const evidenceDodQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.evidenceDod(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.evidenceDod(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && pageId === "evidence_dod",
  });

  const sourceDocumentsQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.sourceDocuments(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.sourceDocuments(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && pageId === "source_documents",
  });

  const specEditorQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.specEditor(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.specEditor(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && pageId === "spec_editor",
  });

  const gateResultQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.gateResult(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.gateResult(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && pageId === "gate_result",
  });

  const issueLedgerQuery = useQuery({
    queryKey: queryKeys.channelWorkbench.issueLedger(selectedCompanyId ?? "__none__", scenarioKey),
    queryFn: () => channelWorkbenchApi.issueLedger(selectedCompanyId!, scenarioKey),
    enabled: !!selectedCompanyId && pageId === "issue_ledger",
  });

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return <EmptyState icon={FileCode2} message="请先创建或选择一个公司，再打开渠道需求工作台。" />;
    }
    return <EmptyState icon={FileCode2} message="请先在左侧选择一个公司，再查看渠道需求工作台。" />;
  }

  if (
    overviewQuery.isLoading ||
    nextActionsQuery.isLoading ||
    (!pageId && roleViewQuery.isLoading) ||
    (pageId === "source_documents" && sourceDocumentsQuery.isLoading) ||
    (pageId === "spec_editor" && specEditorQuery.isLoading) ||
    (pageId === "gate_result" && gateResultQuery.isLoading) ||
    (pageId === "issue_ledger" && issueLedgerQuery.isLoading) ||
    (pageId === "snapshot_export" && snapshotExportQuery.isLoading) ||
    (pageId === "evidence_dod" && evidenceDodQuery.isLoading)
  ) {
    return <PageSkeleton variant="detail" />;
  }

  if (
    overviewQuery.error ||
    nextActionsQuery.error ||
    (!pageId ? roleViewQuery.error : null) ||
    (pageId === "source_documents" ? sourceDocumentsQuery.error : null) ||
    (pageId === "spec_editor" ? specEditorQuery.error : null) ||
    (pageId === "gate_result" ? gateResultQuery.error : null) ||
    (pageId === "issue_ledger" ? issueLedgerQuery.error : null) ||
    (pageId === "snapshot_export" ? snapshotExportQuery.error : null) ||
    (pageId === "evidence_dod" ? evidenceDodQuery.error : null)
  ) {
    const error =
      overviewQuery.error ??
      nextActionsQuery.error ??
      (!pageId ? roleViewQuery.error : null) ??
      (pageId === "source_documents" ? sourceDocumentsQuery.error : null) ??
      (pageId === "spec_editor" ? specEditorQuery.error : null) ??
      (pageId === "gate_result" ? gateResultQuery.error : null) ??
      (pageId === "issue_ledger" ? issueLedgerQuery.error : null) ??
      (pageId === "snapshot_export" ? snapshotExportQuery.error : null) ??
      (pageId === "evidence_dod" ? evidenceDodQuery.error : null);
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-50 px-5 py-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
        {error instanceof Error ? error.message : "渠道需求工作台加载失败"}
      </div>
    );
  }

  if (routePageId && !pageId) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-5 py-5">
          <CardTitle>未知工作区块</CardTitle>
          <CardDescription>当前地址不在已定义的工作区块里，请从下面入口重新进入。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 pb-5 pt-0 md:grid-cols-2 xl:grid-cols-3">
          {channelWorkbenchPageDefinitions.map((page) => (
            <PageEntryCard key={page.id} pageId={page.id} scenarioKey={scenarioKey} />
          ))}
        </CardContent>
      </Card>
    );
  }

  const overviewPayload = overviewQuery.data!;
  const nextActionsPayload = nextActionsQuery.data!;
  const overview = overviewPayload.overview;
  const nextActions = nextActionsPayload.items;
  const channelCaseActivity = activityQuery.data ?? [];

  const recoveredRerunGateResult = useMemo(() => {
    const event = getLatestActivityEvent(channelCaseActivity, "channel_workbench.gate_rerun_requested");
    return event ? buildRecoveredRerunGateResult(event, overview) : null;
  }, [channelCaseActivity, overview]);

  const recoveredExportAiResult = useMemo(() => {
    const event = getLatestActivityEvent(channelCaseActivity, "channel_workbench.ai_package_exported");
    return event ? buildRecoveredExportAiResult(event, overview) : null;
  }, [channelCaseActivity, overview]);

  const recoveredUploadEvidenceResult = useMemo(() => {
    const event = getLatestActivityEvent(channelCaseActivity, "channel_workbench.evidence_uploaded");
    return event ? buildRecoveredUploadEvidenceResult(event, overview) : null;
  }, [channelCaseActivity, overview]);

  const resolvedRerunGateResult = pickLatestMutationResult(latestRerunGateResult, recoveredRerunGateResult);
  const resolvedExportAiResult = pickLatestMutationResult(latestExportAiResult, recoveredExportAiResult);
  const resolvedUploadEvidenceResult = pickLatestMutationResult(
    latestUploadEvidenceResult,
    recoveredUploadEvidenceResult,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
            <h2 className="text-xl font-bold">渠道需求工作台</h2>
            <Badge variant="secondary">Workflow Live</Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            这里把资料整理、规范沉淀、Gate 裁决、AI 导出和 DoD 收口串成一条连续工作链，
            让产品、架构、开发、测试都能在同一张工作台上接棒推进。
          </p>
          <p className="text-xs text-muted-foreground">
            当前公司：{selectedCompany?.name ?? "未选择"} · 场景视图：{getScenarioLabel(scenarioKey)} · 当前有效状态：
            {overviewPayload.scenario.id} / {overviewPayload.scenario.label}
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 lg:w-[280px]">
          <span className="text-xs font-medium text-muted-foreground">场景视图</span>
          <Select value={scenarioKey} onValueChange={handleScenarioChange}>
            <SelectTrigger>
              <SelectValue placeholder="选择一个场景" />
            </SelectTrigger>
            <SelectContent>
              {channelWorkbenchScenarioDefinitions.map((item) => (
                <SelectItem key={item.id} value={item.key}>
                  {item.id} · {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ScenarioStateHeader requestedScenarioKey={scenarioKey} effectiveScenario={overviewPayload.scenario} />

      {pageId ? (
        <SectionDetail
          pageId={pageId}
          overview={overview}
          nextActions={nextActions}
          channelCaseActivity={channelCaseActivity}
          onOpenPage={handleOpenPage}
          onExecuteAction={handleExecuteAction}
          executingActionType={executingActionType}
          latestRerunGateResult={resolvedRerunGateResult}
          latestExportAiResult={resolvedExportAiResult}
          latestUploadEvidenceResult={resolvedUploadEvidenceResult}
          sourceDocumentsPayload={sourceDocumentsQuery.data ?? null}
          specEditorPayload={specEditorQuery.data ?? null}
          gateResultPayload={gateResultQuery.data ?? null}
          issueLedgerPayload={issueLedgerQuery.data ?? null}
          snapshotExportPayload={snapshotExportQuery.data ?? null}
          evidenceDodPayload={evidenceDodQuery.data ?? null}
          scenarioKey={scenarioKey}
        />
      ) : (
        <SectionOverview
          overview={overview}
          roleViewPayload={roleViewQuery.data ?? null}
          nextActions={nextActions}
          channelCaseActivity={channelCaseActivity}
          onOpenPage={handleOpenPage}
          scenarioKey={scenarioKey}
        />
      )}
    </div>
  );
};
