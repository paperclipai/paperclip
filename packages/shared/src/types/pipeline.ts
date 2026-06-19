import type { Issue } from "./issue.js";
import type { RoutineEnvConfig } from "./routine.js";

export type PipelineCaseConversationSourceReason =
  | "producer_update"
  | "producer_create"
  | "automation_link"
  | "conversation_link"
  | "work_link";

export type PipelineCaseConversationSourceLinkRole = "automation" | "conversation" | "work";

export interface PipelineCaseConversationSource {
  issue: Issue;
  reason: PipelineCaseConversationSourceReason;
  linkRole?: PipelineCaseConversationSourceLinkRole | null;
  sourceRunId?: string | null;
}

export interface PipelineStageAutomation {
  routineId: string;
  assigneeAgentId: string | null;
  instructionsBody: string;
  env: RoutineEnvConfig | null;
  latestRoutineRevisionId: string | null;
  latestRoutineRevisionNumber: number;
}

export type PipelineCaseLivenessState = "terminal" | "live" | "waiting" | "blocked" | "attention";

export interface PipelineCaseLiveness {
  state: PipelineCaseLivenessState;
  reason:
    | "terminal"
    | "lease_active"
    | "linked_issue_active"
    | "linked_issue_waiting"
    | "linked_issue_blocked"
    | "case_blocked"
    | "automation_failed"
    | "permission_preflight_failed"
    | "breakdown_pending"
    | "breakdown_incomplete"
    | "children_waiting"
    | "review_waiting"
    | "no_action_path";
  message: string;
  issue?: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  } | null;
  blocker?: {
    caseId?: string | null;
    issueId?: string | null;
    title?: string | null;
    status?: string | null;
    terminalKind?: string | null;
  } | null;
  automation?: {
    automationId?: string | null;
    routineId?: string | null;
    executionId?: string | null;
    error?: string | null;
    fingerprint?: string | null;
  } | null;
  breakdown?: {
    expectedRequestKeys?: string[];
    createdRequestKeys?: string[];
    missingRequestKeys?: string[];
  } | null;
}

export type PipelineAutomationRetryScope = "current_stage" | "previous_stage";

export interface PipelineAutomationRetryCleanupOptions {
  retireDirectChildren: boolean;
  retireDescendants: boolean;
  cancelLinkedAutomationIssues: boolean;
}

export interface PipelineAutomationRetryStageRef {
  id: string;
  key: string;
  name: string;
}

export interface PipelineAutomationRetryRoutineRef {
  id: string;
  assigneeAgentId: string | null;
}

export interface PipelineAutomationRetryEffectCounts {
  directChildren: number;
  descendants: number;
  linkedAutomationIssues: number;
  activeDescendants: number;
  unresolvedBlockers: number;
}

export interface PipelineAutomationRetryBlocker {
  kind:
    | "automation_not_configured"
    | "previous_stage_not_found"
    | "target_case_terminal"
    | "target_pipeline_archived"
    | "active_descendants"
    | "unresolved_blockers"
    | "permission_preflight_failed";
  message: string;
  caseIds?: string[];
  issueIds?: string[];
  details?: Record<string, unknown>;
}

export interface PipelineAutomationRetryPlan {
  caseId: string;
  scope: PipelineAutomationRetryScope;
  allowed: boolean;
  caseVersion: number;
  currentStage: PipelineAutomationRetryStageRef;
  targetStage: PipelineAutomationRetryStageRef | null;
  automationId: string | null;
  routine: PipelineAutomationRetryRoutineRef | null;
  previousAttemptId: string | null;
  generation: number;
  effectCounts: PipelineAutomationRetryEffectCounts;
  defaultCleanup: PipelineAutomationRetryCleanupOptions;
  blockers: PipelineAutomationRetryBlocker[];
}

export interface PipelineAutomationRetryRequest {
  scope: PipelineAutomationRetryScope;
  expectedVersion: number;
  cleanup: PipelineAutomationRetryCleanupOptions;
}
