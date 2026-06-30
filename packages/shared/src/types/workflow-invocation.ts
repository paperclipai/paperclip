import type { WorkflowInvocationContractVersion } from "../constants.js";

export interface WorkflowInvocationTargetSelector {
  workflowId?: string | null;
  workflowKey?: string | null;
  capability?: string | null;
}

export interface WorkflowInvocationMarkdownPayload {
  kind: "markdown";
  inputMarkdown: string;
}

export interface WorkflowInvocationJsonPayload {
  kind: "json";
  inputJson: Record<string, unknown>;
}

export type WorkflowInvocationPayload =
  | WorkflowInvocationMarkdownPayload
  | WorkflowInvocationJsonPayload;

export interface WorkflowInvocationEnvelope {
  contractVersion: WorkflowInvocationContractVersion;
  target: WorkflowInvocationTargetSelector;
  payload: WorkflowInvocationPayload;
}

export interface WorkflowInvocationResult {
  id: string;
  companyId: string;
  sourceRoutineId: string;
  sourceRoutineRunId: string;
  targetWorkflowId: string;
  targetWorkflowKey: string | null;
  targetCapability: string | null;
  contractVersion: WorkflowInvocationContractVersion;
  inputKind: WorkflowInvocationPayload["kind"];
  inputMarkdown: string;
  inputJson: Record<string, unknown> | null;
  workflowRunId: string | null;
  status: "queued" | "linked" | "failed";
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRunInvocationSummary {
  id: string;
  contractVersion: WorkflowInvocationContractVersion;
  inputKind: WorkflowInvocationPayload["kind"];
  sourceRoutineId: string;
  sourceRoutineTitle: string | null;
  sourceRoutineRunId: string;
  sourceRoutineRunSource: string | null;
  targetWorkflowId: string;
  targetWorkflowKey: string | null;
  targetCapability: string | null;
}
