import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues as issueTable } from "@paperclipai/db";
import {
  AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
  buildAutonomousGoalLoopState,
} from "./autonomous-goal-loop-continuation.js";
import { listMissionControlCompletionDocuments } from "./mission-control-gates.js";

const WATCHDOG_PREVIEW_DEFAULT_LIMIT = 100;
const WATCHDOG_PREVIEW_MAX_LIMIT = 100;
const WATCHDOG_PREVIEW_OPEN_STATUS_EXCLUSIONS = ["done", "cancelled"] as const;

export type AutonomousGoalLoopWatchdogPreviewCandidateKind =
  | "loop_decision_repair"
  | "loop_limit_attention"
  | "loop_manual_review"
  | "loop_operator_attention";

export type AutonomousGoalLoopWatchdogPreviewCandidate = {
  id: string;
  kind: AutonomousGoalLoopWatchdogPreviewCandidateKind;
  severity: "low" | "medium" | "high";
  owner: "operator";
  issueId: string;
  identifier: string | null;
  title: string;
  status: string | null;
  reason: string;
  recoveryAction: string;
  recommendedAction: string;
  userVisible: boolean;
  generatedAt: string;
};

export type AutonomousGoalLoopWatchdogPreview = {
  companyId: string;
  mode: "preview";
  readOnly: true;
  generatedAt: string;
  totalIssuesScanned: number;
  candidates: AutonomousGoalLoopWatchdogPreviewCandidate[];
};

type WatchdogPreviewIssue = {
  id: string;
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  identifier?: string | null;
  title: string;
  priority: string;
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  requestDepth?: number | null;
  executionPolicy?: unknown;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type WatchdogPreviewInputIssue = {
  issue: WatchdogPreviewIssue;
  documents: Parameters<typeof buildAutonomousGoalLoopState>[0]["documents"];
  childIssues?: Parameters<typeof buildAutonomousGoalLoopState>[0]["childIssues"];
};

function serializeGeneratedAt(value: string | Date | undefined) {
  if (value instanceof Date) return value.toISOString();
  return value ?? new Date().toISOString();
}

function clampLimit(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return WATCHDOG_PREVIEW_DEFAULT_LIMIT;
  return Math.min(WATCHDOG_PREVIEW_MAX_LIMIT, Math.max(1, Math.floor(value)));
}

function candidateKindFor(recoveryAction: string): AutonomousGoalLoopWatchdogPreviewCandidateKind {
  if (recoveryAction === "repair_loop_decision") return "loop_decision_repair";
  if (recoveryAction === "adjust_loop_limits_or_close_goal") return "loop_limit_attention";
  if (recoveryAction === "manual_review") return "loop_manual_review";
  return "loop_operator_attention";
}

function severityFor(recoveryAction: string): AutonomousGoalLoopWatchdogPreviewCandidate["severity"] {
  if (recoveryAction === "repair_loop_decision") return "high";
  if (recoveryAction === "adjust_loop_limits_or_close_goal") return "medium";
  return "medium";
}

function recommendedActionFor(input: { reason: string; recoveryAction: string }) {
  if (input.recoveryAction === "repair_loop_decision") {
    return "Review and rewrite the ceo-loop-decision document for the current loop iteration before any continuation runs.";
  }
  if (input.recoveryAction === "adjust_loop_limits_or_close_goal") {
    return "Review loop runtime/iteration limits and either close the goal or explicitly adjust the safe limits.";
  }
  if (input.recoveryAction === "manual_review") {
    return "Inspect the loop documents and owner handoff; create a repair issue or ask the CEO to write the missing decision.";
  }
  return `Operator review required for autonomous-loop supervisor reason: ${input.reason}.`;
}

export function buildAutonomousGoalLoopWatchdogPreview(input: {
  companyId: string;
  issues: WatchdogPreviewInputIssue[];
  generatedAt?: string | Date;
}): AutonomousGoalLoopWatchdogPreview {
  const generatedAt = serializeGeneratedAt(input.generatedAt);
  const candidates: AutonomousGoalLoopWatchdogPreviewCandidate[] = [];

  for (const item of input.issues) {
    const state = buildAutonomousGoalLoopState({
      issue: item.issue,
      documents: item.documents,
      childIssues: item.childIssues ?? [],
      now: generatedAt,
    });
    if (!state.enabled) continue;
    if (!state.supervisor.attentionRequired || state.supervisor.owner !== "operator") continue;
    if (!state.supervisor.reason) continue;

    candidates.push({
      id: `${item.issue.id}:${state.supervisor.recoveryAction}:${state.supervisor.reason}`,
      kind: candidateKindFor(state.supervisor.recoveryAction),
      severity: severityFor(state.supervisor.recoveryAction),
      owner: "operator",
      issueId: item.issue.id,
      identifier: item.issue.identifier ?? null,
      title: item.issue.title,
      status: item.issue.status ?? null,
      reason: state.supervisor.reason,
      recoveryAction: state.supervisor.recoveryAction,
      recommendedAction: recommendedActionFor({
        reason: state.supervisor.reason,
        recoveryAction: state.supervisor.recoveryAction,
      }),
      userVisible: state.supervisor.userVisible,
      generatedAt,
    });
  }

  candidates.sort((left, right) => {
    const severityOrder = { high: 0, medium: 1, low: 2 } as const;
    return severityOrder[left.severity] - severityOrder[right.severity] || left.title.localeCompare(right.title);
  });

  return {
    companyId: input.companyId,
    mode: "preview",
    readOnly: true,
    generatedAt,
    totalIssuesScanned: input.issues.length,
    candidates,
  };
}

export async function listAutonomousGoalLoopWatchdogPreview(
  db: Db,
  companyId: string,
  options: { limit?: number } = {},
): Promise<AutonomousGoalLoopWatchdogPreview> {
  const limit = clampLimit(options.limit);
  const issueRows = await db
    .select({
      id: issueTable.id,
      companyId: issueTable.companyId,
      projectId: issueTable.projectId,
      goalId: issueTable.goalId,
      identifier: issueTable.identifier,
      title: issueTable.title,
      priority: issueTable.priority,
      status: issueTable.status,
      assigneeAgentId: issueTable.assigneeAgentId,
      assigneeUserId: issueTable.assigneeUserId,
      requestDepth: issueTable.requestDepth,
      executionPolicy: issueTable.executionPolicy,
      createdAt: issueTable.createdAt,
      updatedAt: issueTable.updatedAt,
    })
    .from(issueTable)
    .where(
      and(
        eq(issueTable.companyId, companyId),
        isNull(issueTable.hiddenAt),
        notInArray(issueTable.status, [...WATCHDOG_PREVIEW_OPEN_STATUS_EXCLUSIONS]),
      ),
    )
    .orderBy(desc(issueTable.updatedAt), desc(issueTable.id))
    .limit(limit);

  const generatedAt = new Date().toISOString();
  const issues = await Promise.all(
    issueRows.map(async (issue) => {
      const [documents, childIssues] = await Promise.all([
        listMissionControlCompletionDocuments(db, issue.id),
        db
          .select({
            id: issueTable.id,
            parentId: issueTable.parentId,
            identifier: issueTable.identifier,
            title: issueTable.title,
            status: issueTable.status,
            originKind: issueTable.originKind,
            originId: issueTable.originId,
            originFingerprint: issueTable.originFingerprint,
            assigneeAgentId: issueTable.assigneeAgentId,
            assigneeUserId: issueTable.assigneeUserId,
            createdAt: issueTable.createdAt,
            updatedAt: issueTable.updatedAt,
          })
          .from(issueTable)
          .where(
            and(
              eq(issueTable.companyId, companyId),
              eq(issueTable.parentId, issue.id),
              eq(issueTable.originKind, AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND),
              eq(issueTable.originId, issue.id),
              isNull(issueTable.hiddenAt),
            ),
          )
          .orderBy(desc(issueTable.updatedAt), desc(issueTable.id))
          .limit(100),
      ]);
      return { issue, documents, childIssues };
    }),
  );

  return buildAutonomousGoalLoopWatchdogPreview({ companyId, issues, generatedAt });
}
